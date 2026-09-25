/**
 * SQ Router Control — Monitor tab.
 * L/R output selectors, mix / channel / FX return / Main LR routing into the
 * selected outputs, and the keyboard navigation.
 *
 * Mono channel selection supports an ad-hoc pair: click a channel (→ both
 * L/R outputs), then Shift+click a second mono channel — the first goes to
 * the L output, the second to the R output.
 *
 * FX returns (FX 1-4) are stereo sources: the L side is routed to the L
 * output, the R side to the R output.
 *
 * Matrices (3 stereo buses on the SQ, slot pairs at b3 0x73-0x78) follow the
 * same L/R pattern: the matrix's L slot patches into the L output, the R
 * slot into the R output (regular output-patch frames, like mixes).
 *
 * Console stereo-linked pairs are patched as two explicit output-patch
 * frames: the left channel into the L output, the right channel into the R
 * output. The SQ does not derive the right half from the master patch, so
 * both halves must be sent separately.
 */
import { elementRefs, state } from "../../core/utils";
import { dbToPercent, meterClassName } from "../../core/meters";
import type { SnapshotInput, SnapshotOutput, MetersPayload, OutputKey } from "../../../shared/ipc";
import type { OutputOption, Dest, MixItem } from "./types";

// ── output selectors ─────────────────────────────────────────────────

/**
 * Build the list of all available physical outputs from the model spec.
 * Returns array of {value, label} where value = "destType:channel".
 */
/** TRS jack output labels (panel silkscreen A / B). */
const TRS_LABELS = ["A", "B"];

function buildOutputOptions(): OutputOption[] {
  const opts: OutputOption[] = [];
  const spec = state.modelSpec;
  // Local XLR Out 1..N, then the two TRS A/B outputs. The TRS jacks continue
  // the local output bank (e.g. SQ-5: 12 XLR + TRS A = Local 13, B = 14), so
  // they are addressed with the same destType 0x1a and the next channel numbers.
  const xlrCount = spec ? spec.xlrOutputs : 12;
  const trsCount = spec ? spec.trsOutputs : 2;
  for (let i = 1; i <= xlrCount; i++) {
    opts.push({ value: `0x1a:${i}`, label: `Local Out ${i}` });
  }
  for (let i = 0; i < trsCount && i < TRS_LABELS.length; i++) {
    opts.push({ value: `0x1a:${xlrCount + i + 1}`, label: `TRS Out ${TRS_LABELS[i]}` });
  }
  // SLink Out 1..48
  for (let i = 1; i <= 48; i++) {
    opts.push({ value: `0x1c:${i}`, label: `SLink Out ${i}` });
  }
  // USB Out 1..32
  const usbCount = spec ? spec.usbChannels : 32;
  for (let i = 1; i <= usbCount; i++) {
    opts.push({ value: `0x1d:${i}`, label: `USB Out ${i}` });
  }
  // I/O Port Out 1..64
  for (let i = 1; i <= 64; i++) {
    opts.push({ value: `0x1e:${i}`, label: `I/O Port Out ${i}` });
  }
  return opts;
}

function populateMonitorSelects(): void {
  const opts = buildOutputOptions();
  for (const sel of [elementRefs.monLDest, elementRefs.monRDest]) {
    sel.innerHTML = "";
    // Placeholder stays selectable — picking it deselects the output.
    const ph = document.createElement("option");
    ph.value = "";
    ph.textContent = "— не выбран —";
    sel.appendChild(ph);
    // Group by type
    const groups: Record<string, HTMLOptGroupElement> = {};
    for (const o of opts) {
      const type = o.label.split(" Out")[0];
      if (!groups[type]) {
        const g = document.createElement("optgroup");
        g.label = type + " Out";
        groups[type] = g;
      }
      const opt = document.createElement("option");
      opt.value = o.value;
      opt.textContent = o.label;
      // Base label kept aside — usage annotations rewrite textContent in place.
      opt.dataset.baseLabel = o.label;
      groups[type].appendChild(opt);
    }
    for (const g of Object.values(groups)) sel.appendChild(g);
  }
  // No pre-selected outputs — both selects start at the "— не выбран —" placeholder.
  elementRefs.monLDest.value = "";
  elementRefs.monRDest.value = "";
  // Re-apply usage annotations if a routing snapshot has already arrived.
  applyOutputUsage();
  // Disable safe outputs; lock sources until both outputs are chosen.
  applySafeOutputLock();
}

// ── source lock (until both outputs are chosen) ─────────────────────

/**
 * Keep the "Применять" toggle and the source buttons (mixes, channels, FX
 * returns, Main LR) disabled until at least one of the L/R output selectors
 * has a value — there is nothing to apply or route into otherwise.
 */
function updateSourceLock(): void {
  const locked = !elementRefs.monLDest.value && !elementRefs.monRDest.value;
  elementRefs.monEnable.disabled = locked;
  elementRefs.mainlrBtn.disabled = locked;
  elementRefs.paflBtn.disabled = locked;
  for (const group of [elementRefs.mixButtons, elementRefs.chButtons, elementRefs.fxButtons]) {
    for (const b of group.querySelectorAll<HTMLButtonElement>("button")) {
      b.disabled = locked;
    }
  }
}

// ── "Применять" session: save / restore output routing ──────────────

/** Output routing captured when "Применять" was enabled; restored on disable. */
let savedOutputs: SnapshotOutput[] | null = null;

/**
 * Outputs ("destType:destChannel") borrowed by this session — every output
 * that was selected in L/R while "Применять" was on. Only these are restored
 * on disable; everything else kept its original routing untouched.
 */
let borrowedKeys: Set<string> | null = null;

/** Keys ("destType:destChannel") of the outputs currently chosen in L/R. */
function selectedDestKeys(): string[] {
  const keys: string[] = [];
  for (const sel of [elementRefs.monLDest, elementRefs.monRDest]) {
    const dest = parseDest(sel);
    if (dest) keys.push(`${dest.destType}:${dest.destChannel}`);
  }
  return keys;
}

/** Remember outputs chosen while the session is active — they get restored. */
function recordBorrowedOutputs(): void {
  if (!monEnabled() || !borrowedKeys) return;
  for (const key of selectedDestKeys()) borrowedKeys.add(key);
}

/**
 * Point the R selector at the output neighbouring L (same bank, channel+1).
 * Stereo pairs are most often patched to adjacent sockets (L, L+1), so the
 * UI defaults to that; the user can still pick any other R output. Skips safe
 * outputs (disabled options) and missing neighbours (e.g. past the end of a
 * bank).
 */
function alignRToLNeighbor(): void {
  // L deselected — there is no neighbour to align to.
  if (!elementRefs.monLDest.value) return;
  const [destTypeHex, chStr] = elementRefs.monLDest.value.split(":");
  const neighborVal = `${destTypeHex}:${Number(chStr) + 1}`;
  if (elementRefs.monRDest.value === neighborVal) return;
  if ([...elementRefs.monRDest.options].some((o) => o.value === neighborVal && !o.disabled)) {
    elementRefs.monRDest.value = neighborVal;
    recordBorrowedOutputs();
    updateSourceLock();
  }
}

/**
 * Checkbox handler. Enabling snapshots the console's current output routing
 * (before any monitor routing overwrites it) — this works even before the
 * L/R outputs are chosen. Disabling sends the snapshot back for the borrowed
 * outputs only, returning them to their pre-session state.
 */
async function onMonEnableChange(): Promise<void> {
  if (monEnabled()) {
    savedOutputs = lastOutputs ? [...lastOutputs] : [];
    borrowedKeys = new Set(selectedDestKeys());
    await routeActiveSelection();
  } else {
    const outputs = savedOutputs ?? [];
    const keys = borrowedKeys;
    savedOutputs = null;
    borrowedKeys = null;
    if (keys && keys.size > 0) {
      // Outputs with a known pre-session source are restored; outputs that
      // were free before the session are cleared, so disabling "Применять"
      // leaves no leftover monitor routing on them.
      const savedByKey = new Map(outputs.map((o) => [`${o.dest}:${o.destChannel}`, o]));
      const restore: SnapshotOutput[] = [];
      const clear: OutputKey[] = [];
      for (const key of keys) {
        const rec = savedByKey.get(key);
        if (rec) {
          restore.push(rec);
        } else {
          const [dest, destChannel] = key.split(":").map(Number);
          clear.push({ dest, destChannel });
        }
      }
      if (restore.length > 0) await window.sq.restoreOutputs(restore);
      if (clear.length > 0) await window.sq.clearOutputs(clear);
    }
  }
  renderSendDebug(planActiveSelection());
}

// ── output usage annotations ────────────────────────────────────────

/** Latest routing outputs — re-applied when the selects are rebuilt. */
let lastOutputs: SnapshotOutput[] | null = null;

/**
 * Annotate the L/R output selectors with what each physical output is
 * currently routed to (from the routing snapshot). A used output shows
 * "· <source>" next to its label; a free one keeps the plain label.
 */
export function updateOutputUsage(outputs: SnapshotOutput[]): void {
  lastOutputs = outputs;
  applyOutputUsage();
  updateLockPanelUsage();
}

/** destType:destChannel (decimal) → routed source label(s), joined on conflict. */
function outputUsageMap(): Map<string, string> {
  const byKey = new Map<string, string>();
  for (const out of lastOutputs ?? []) {
    const key = `${out.dest}:${out.destChannel}`;
    const prev = byKey.get(key);
    byKey.set(key, prev ? `${prev} + ${out.sourceLabel}` : out.sourceLabel);
  }
  return byKey;
}

// ── output lock modal (padlock button) ──────────────────────────────

/** localStorage key for the persisted safe-outputs list. */
const SAFE_OUTPUTS_KEY = "sq_safe_outputs";

/** Load the safe-outputs set from localStorage (survives app restarts). */
function loadSafeOutputs(): Set<string> {
  try {
    const raw = JSON.parse(localStorage.getItem(SAFE_OUTPUTS_KEY) || "[]");
    const set = new Set<string>();
    if (Array.isArray(raw)) {
      for (const k of raw) {
        if (typeof k === "string" && /^\d+:\d+$/.test(k)) set.add(k);
      }
    }
    return set;
  } catch {
    return new Set();
  }
}

/** Outputs selected in the lock modal: "destType:destChannel" (decimal) keys. */
const lockedOutputs = loadSafeOutputs();

/** Persist the safe-outputs set to localStorage. */
function persistSafeOutputs(): void {
  try {
    localStorage.setItem(SAFE_OUTPUTS_KEY, JSON.stringify([...lockedOutputs]));
  } catch {
    /* storage unavailable — keep the in-memory set only */
  }
}

/** Red dot on the padlock button while any safe output is selected. */
function updateLockBtnDot(): void {
  elementRefs.monLockBtn.classList.toggle("has-sel", lockedOutputs.size > 0);
}

/** Dest types shown as tabs in the lock modal. */
const LOCK_TAB_DESTS = [0x1a, 0x1c, 0x1d, 0x1e] as const;

function lockModalOpen(): boolean {
  return !elementRefs.monLockModal.hidden;
}

function openLockModal(): void {
  buildLockPanels();
  elementRefs.monLockModal.hidden = false;
}

function closeLockModal(): void {
  elementRefs.monLockModal.hidden = true;
}

/** One output entry for a lock tab: {key, short label for the button}. */
function lockTabOutputs(destType: number): { key: string; label: string }[] {
  const spec = state.modelSpec;
  const entries: { key: string; label: string }[] = [];
  if (destType === 0x1a) {
    // Local XLR Out 1..N, then TRS A/B continuing the bank.
    const xlrCount = spec ? spec.xlrOutputs : 12;
    const trsCount = spec ? spec.trsOutputs : 2;
    for (let i = 1; i <= xlrCount; i++) entries.push({ key: `0x1a:${i}`, label: String(i) });
    for (let i = 0; i < trsCount && i < TRS_LABELS.length; i++) {
      entries.push({ key: `0x1a:${xlrCount + i + 1}`, label: TRS_LABELS[i] });
    }
  } else {
    const count =
      destType === 0x1c ? 48 :
      destType === 0x1d ? (spec ? spec.usbChannels : 32) :
      64; // I/O Port
    const prefix = `0x${destType.toString(16)}`;
    for (let i = 1; i <= count; i++) entries.push({ key: `${prefix}:${i}`, label: String(i) });
  }
  return entries;
}

/** Build the tab panels: small output buttons with usage annotations. */
function buildLockPanels(): void {
  const byKey = outputUsageMap();
  const panels = elementRefs.monLockPanels;
  panels.innerHTML = "";
  for (const destType of LOCK_TAB_DESTS) {
    const panel = document.createElement("div");
    panel.className = "mon-lock-panel";
    panel.dataset.dest = `0x${destType.toString(16)}`;
    const grid = document.createElement("div");
    grid.className = "mon-out-grid";
    for (const entry of lockTabOutputs(destType)) {
      const [destTypeHex, chStr] = entry.key.split(":");
      const usageKey = `${parseInt(destTypeHex, 16)}:${Number(chStr)}`;
      const btn = document.createElement("button");
      btn.type = "button";
      btn.className = "mon-out-btn";
      btn.dataset.key = usageKey;
      if (lockedOutputs.has(usageKey)) btn.classList.add("selected");
      const num = document.createElement("span");
      num.className = "mon-out-num";
      num.textContent = entry.label;
      btn.appendChild(num);
      const src = document.createElement("span");
      src.className = "mon-out-src";
      src.textContent = byKey.get(usageKey) ?? "";
      btn.appendChild(src);
      btn.addEventListener("click", () => {
        btn.classList.toggle("selected");
        if (btn.classList.contains("selected")) lockedOutputs.add(usageKey);
        else lockedOutputs.delete(usageKey);
        persistSafeOutputs();
        updateLockTabDots();
        updateLockBtnDot();
        applySafeOutputLock();
      });
      grid.appendChild(btn);
    }
    panel.appendChild(grid);
    panels.appendChild(panel);
  }
  updateLockTabDots();
  // Show the panel of the active tab.
  syncLockPanels();
}

/** Show only the panel of the active tab. */
function syncLockPanels(): void {
  const activeTab = elementRefs.monLockTabs.querySelector<HTMLButtonElement>(".mon-lock-tab.active");
  const activeDest = activeTab?.dataset.dest ?? null;
  for (const panel of elementRefs.monLockPanels.querySelectorAll<HTMLElement>(".mon-lock-panel")) {
    panel.hidden = panel.dataset.dest !== activeDest;
  }
}

/** Light the red dot on tabs that have at least one selected output. */
function updateLockTabDots(): void {
  for (const tab of elementRefs.monLockTabs.querySelectorAll<HTMLButtonElement>(".mon-lock-tab")) {
    const destType = parseInt(tab.dataset.dest ?? "0", 16);
    const has = [...lockedOutputs].some((k) => k.startsWith(`${destType}:`));
    tab.classList.toggle("has-sel", has);
  }
}

/** Refresh usage annotations on the lock buttons (routing snapshot arrived). */
function updateLockPanelUsage(): void {
  if (!lockModalOpen()) return;
  const byKey = outputUsageMap();
  for (const btn of elementRefs.monLockPanels.querySelectorAll<HTMLButtonElement>(".mon-out-btn")) {
    const src = btn.querySelector(".mon-out-src");
    if (src) src.textContent = byKey.get(btn.dataset.key ?? "") ?? "";
  }
}

/** Compose an option label: base name + routed source + safe marker. */
function refreshOptionLabel(opt: HTMLOptionElement, byKey: Map<string, string>): void {
  if (!opt.value) return; // "— не выбран —" placeholder
  const [destTypeHex, chStr] = opt.value.split(":");
  const key = `${parseInt(destTypeHex, 16)}:${Number(chStr)}`;
  const base = opt.dataset.baseLabel || opt.textContent || "";
  opt.dataset.baseLabel = base;
  const src = byKey.get(key);
  let label = src ? `${base} · ${src}` : base;
  if (lockedOutputs.has(key)) label += " · 🔒";
  opt.textContent = label;
}

/** Rewrite option labels as "base · source" for outputs present in the routing. */
function applyOutputUsage(): void {
  if (!lastOutputs) return;
  const byKey = outputUsageMap();
  for (const sel of [elementRefs.monLDest, elementRefs.monRDest]) {
    for (const opt of sel.options) refreshOptionLabel(opt, byKey);
  }
}

/**
 * Disable the safe outputs in the L/R selectors (they can't be chosen) and
 * drop a current selection that just became safe. Re-renders option labels
 * so the 🔒 marker appears/disappears immediately.
 */
function applySafeOutputLock(): void {
  const byKey = lastOutputs ? outputUsageMap() : new Map<string, string>();
  for (const sel of [elementRefs.monLDest, elementRefs.monRDest]) {
    for (const opt of sel.options) {
      if (!opt.value) continue;
      const [destTypeHex, chStr] = opt.value.split(":");
      const key = `${parseInt(destTypeHex, 16)}:${Number(chStr)}`;
      opt.disabled = lockedOutputs.has(key);
      refreshOptionLabel(opt, byKey);
    }
    // The currently selected output just became safe → drop the selection.
    if (sel.value) {
      const [destTypeHex, chStr] = sel.value.split(":");
      if (lockedOutputs.has(`${parseInt(destTypeHex, 16)}:${Number(chStr)}`)) {
        sel.value = "";
      }
    }
  }
  updateSourceLock();
  renderSendDebug(planActiveSelection());
}

/** Whether monitor changes should be applied to the actual mixer. */
function monEnabled(): boolean {
  return elementRefs.monEnable.checked;
}

/** Parse an L/R destination selector value into {destType, destChannel}. */
function parseDest(sel: HTMLSelectElement): Dest | null {
  const val = sel.value;
  if (!val) return null;
  const [destTypeHex, chStr] = val.split(":");
  return { destType: parseInt(destTypeHex, 16), destChannel: Number(chStr) };
}

// ── routing plan (also drives the debug readout) ─────────────────────

/** One patch command the tab will send (or would send) to the console. */
interface PlannedSend {
  side: "L" | "R";
  /** Target output selector value, or null when that side isn't chosen. */
  dest: Dest | null;
  kind: "bus" | "fx" | "pafl";
  /** Source bus b3 for kind "bus". */
  sourceB3?: number;
  /** FX engine index / side for kind "fx". */
  fxIndex?: number;
  fxSide?: "L" | "R";
  /** Human-readable source, e.g. "Mix 1". */
  sourceLabel: string;
}

/** Hex byte for the debug readout ("0x1a"). */
function hexByte(n: number): string {
  return `0x${n.toString(16).padStart(2, "0")}`;
}

/** Human label for a source b3 (mirrors main/routing.ts b3ToLabel). */
function b3DebugLabel(b3: number): string {
  if (b3 >= 0x00 && b3 <= 0x2f) return `Input ${b3 + 1}`;
  if (b3 >= 0x40 && b3 <= 0x43) return `FX ${b3 - 0x40 + 1}`;
  if (b3 >= 0x58 && b3 <= 0x63) return `Mix ${b3 - 0x58 + 1}`;
  if (b3 === 0x68) return "Main LR";
  if (b3 >= 0x73 && b3 <= 0x78) {
    const slot = b3 - 0x73;
    return `Matrix ${Math.floor(slot / 2) + 1} ${slot % 2 === 0 ? "L" : "R"}`;
  }
  return `b3 ${hexByte(b3)}`;
}

/** Human label for an output destination type. */
function destTypeDebugName(destType: number): string {
  return destType === 0x1a ? "Local Out" :
    destType === 0x1b ? "ME" :
    destType === 0x1c ? "SLink Out" :
    destType === 0x1d ? "USB Out" :
    destType === 0x1e ? "I/O Port Out" :
    `dest ${hexByte(destType)}`;
}

/** "Local Out 1" / "— не выбран —" for the debug readout. */
function destDebugLabel(dest: Dest | null): string {
  return dest ? `${destTypeDebugName(dest.destType)} ${dest.destChannel}` : "— не выбран —";
}

/**
 * Build the list of patches for the current source + L/R output selection.
 * Mirrors exactly what routeActiveSelection() sends, so the debug readout
 * shows the real commands.
 */
function planActiveSelection(): PlannedSend[] {
  const L = parseDest(elementRefs.monLDest);
  const R = parseDest(elementRefs.monRDest);
  const plan: PlannedSend[] = [];

  if (leftChannelB3 !== null && rightChannelB3 !== null) {
    // A stereo pair (console-linked or ad-hoc) is patched as two separate
    // output-patch frames: left half → L output, right half → R output. The
    // SQ does NOT derive the right half from the master patch.
    plan.push({ side: "L", dest: L, kind: "bus", sourceB3: leftChannelB3, sourceLabel: b3DebugLabel(leftChannelB3) });
    plan.push({ side: "R", dest: R, kind: "bus", sourceB3: rightChannelB3, sourceLabel: b3DebugLabel(rightChannelB3) });
  } else if (leftChannelB3 !== null) {
    plan.push({ side: "L", dest: L, kind: "bus", sourceB3: leftChannelB3, sourceLabel: b3DebugLabel(leftChannelB3) });
    plan.push({ side: "R", dest: R, kind: "bus", sourceB3: leftChannelB3, sourceLabel: b3DebugLabel(leftChannelB3) });
  } else if (activeFxIndex !== null) {
    plan.push({ side: "L", dest: L, kind: "fx", fxIndex: activeFxIndex, fxSide: "L", sourceLabel: `FX ${activeFxIndex + 1} L` });
    plan.push({ side: "R", dest: R, kind: "fx", fxIndex: activeFxIndex, fxSide: "R", sourceLabel: `FX ${activeFxIndex + 1} R` });
  } else if (paflActive) {
    plan.push({ side: "L", dest: L, kind: "pafl", sourceLabel: "PAFL L" });
    plan.push({ side: "R", dest: R, kind: "pafl", sourceLabel: "PAFL R" });
  } else if (activeMatrixIndex !== null) {
    const lSlot = matrixSlotB3(activeMatrixIndex, "L");
    const rSlot = matrixSlotB3(activeMatrixIndex, "R");
    plan.push({ side: "L", dest: L, kind: "bus", sourceB3: lSlot, sourceLabel: b3DebugLabel(lSlot) });
    plan.push({ side: "R", dest: R, kind: "bus", sourceB3: rSlot, sourceLabel: b3DebugLabel(rSlot) });
  } else if (activeSourceB3 !== null) {
    plan.push({ side: "L", dest: L, kind: "bus", sourceB3: activeSourceB3, sourceLabel: b3DebugLabel(activeSourceB3) });
    plan.push({ side: "R", dest: R, kind: "bus", sourceB3: activeSourceB3, sourceLabel: b3DebugLabel(activeSourceB3) });
  }
  return plan;
}

/** IPC call string for the debug readout, e.g. `setOutputPatch(0x58, 0x1a:1)`. */
function planCommand(p: PlannedSend): string {
  if (!p.dest) return "(выход не выбран)";
  const dest = `${hexByte(p.dest.destType)}:${p.dest.destChannel}`;
  if (p.kind === "bus" && p.sourceB3 !== undefined) return `setOutputPatch(${hexByte(p.sourceB3)}, ${dest})`;
  if (p.kind === "fx") return `setFxOutputPatch(${p.fxIndex}, ${p.fxSide}, ${dest})`;
  return `setMonitorOutput(${p.side}, ${dest})`;
}

/** Send one planned patch to the console (no-op when its output isn't chosen). */
async function sendPlanned(p: PlannedSend): Promise<void> {
  if (!p.dest) return;
  if (p.kind === "bus" && p.sourceB3 !== undefined) {
    await window.sq.setOutputPatch(p.sourceB3, p.dest.destType, p.dest.destChannel);
  } else if (p.kind === "fx" && p.fxIndex !== undefined && p.fxSide) {
    await window.sq.setFxOutputPatch(p.fxIndex, p.fxSide, p.dest.destType, p.dest.destChannel);
  } else if (p.kind === "pafl") {
    await window.sq.setMonitorOutput(p.side, p.dest.destType, p.dest.destChannel);
  }
}

/**
 * Render the debug readout under the L/R selectors: for every side, the
 * selected output and the source that is (or would be) patched to it, with
 * the exact IPC command. Visible even while "Применять" is off so the plan
 * can be inspected before anything is sent.
 */
function renderSendDebug(plan: PlannedSend[]): void {
  const container = elementRefs.monSendDebug;
  if (!container) return;
  container.innerHTML = "";

  const title = document.createElement("div");
  title.className = "mon-send-debug-title";
  title.textContent = monEnabled() ? "Отправка на пульт: ВКЛ" : "Отправка на пульт: ВЫКЛ (показан план)";
  container.appendChild(title);

  if (plan.length === 0) {
    const empty = document.createElement("div");
    empty.className = "mon-send-debug-empty";
    empty.textContent = "Источник не выбран";
    container.appendChild(empty);
    return;
  }

  for (const p of plan) {
    const row = document.createElement("div");
    row.className = `mon-send-debug-row${monEnabled() ? "" : " off"}`;

    const side = document.createElement("span");
    side.className = `mon-send-debug-side ${p.side.toLowerCase()}`;
    side.textContent = p.side;

    const dest = document.createElement("span");
    dest.className = "mon-send-debug-dest";
    dest.textContent = destDebugLabel(p.dest);

    const arrow = document.createElement("span");
    arrow.className = "mon-send-debug-arrow";
    arrow.textContent = "←";

    const src = document.createElement("span");
    src.className = "mon-send-debug-src";
    src.textContent = p.sourceLabel;

    const cmd = document.createElement("span");
    cmd.className = "mon-send-debug-cmd";
    cmd.textContent = planCommand(p);

    row.append(side, dest, arrow, src, cmd);
    container.appendChild(row);
  }
}

/**
 * Route the currently selected source to the selected L/R monitor outputs:
 *   stereo pair         → left channel → L out, right channel → R out
 *   mono channel        → source → both L and R outs
 *   FX return           → L side → L out, R side → R out
 *   PAFL                → PAFL L → L out, PAFL R → R out (monitor patch)
 *   Matrix              → L slot (b3) → L out, R slot → R out (output patch)
 *   mix / Main LR       → source → both L and R outs
 * A deselection never changes the routing — the outputs keep the last source.
 * The debug readout always reflects the plan, even when sending is off.
 */
async function routeActiveSelection(): Promise<void> {
  const plan = planActiveSelection();
  renderSendDebug(plan);
  if (!monEnabled()) return;
  for (const p of plan) await sendPlanned(p);
}

// ── mix group buttons ───────────────────────────────────────────────

let activeSourceB3: number | null = null;
let leftChannelB3: number | null = null;
let rightChannelB3: number | null = null;

/** Clear the active mix highlight and selection. */
function clearActiveMix(): void {
  for (const b of document.querySelectorAll(".mix-btn.active")) {
    b.classList.remove("active");
  }
  activeSourceB3 = null;
}

/**
 * Toggle routing for a mix (mutual exclusion: only one mix at a time).
 * Selecting routes the mix to the selected L/R outputs; clicking the active
 * mix keeps it selected (no-op; ESC clears).
 */
async function toggleMixRoute(b3: number, btn: HTMLButtonElement): Promise<void> {
  // Click the active mix → keep it selected.
  if (btn.classList.contains("active")) return;

  clearActiveMix();
  // Also clear channel, FX, PAFL and matrix selections when picking a mix
  clearChannelSelection();
  clearFxSelection();
  clearPaflSelection();
  clearMatrixSelection();
  activeSourceB3 = b3;
  btn.classList.add("active");
  await routeActiveSelection();
}

/** Clear L/R channel highlights and selection. */
function clearChannelSelection(): void {
  for (const b of document.querySelectorAll(".ch-btn")) {
    b.classList.remove("active-l", "active-r");
  }
  leftChannelB3 = null;
  rightChannelB3 = null;
}

/**
 * Mono channel click handler — single selection at a time.
 *   Click inactive channel → clear previous, route channel to BOTH L/R outputs (blue)
 *   Click a member of a pair → solo it: only the clicked channel stays active
 *                              (routed to both L/R), the partner is dropped
 *   Click the single active channel → stays selected (no-op; ESC clears)
 *   Shift+click a second mono channel → pair them: first → L out, second → R out (green)
 */
async function onChannelClick(
  b3: number,
  btn: HTMLButtonElement,
  shift = false
): Promise<void> {
  // Selecting a channel clears any active mix, FX return, PAFL and matrix.
  clearActiveMix();
  clearFxSelection();
  clearPaflSelection();
  clearMatrixSelection();

  // Click the R partner → solo it: R becomes the single mono selection
  // (routed to both L/R), the L channel is dropped.
  if (btn.classList.contains("active-r")) {
    const lBtn = elementRefs.chButtons.querySelector(`.ch-btn[data-b3="${leftChannelB3}"]`);
    lBtn?.classList.remove("active-l");
    btn.classList.remove("active-r");
    leftChannelB3 = b3;
    rightChannelB3 = null;
    btn.classList.add("active-l");
    await routeActiveSelection();
    return;
  }

  // Click the L channel of a pair → solo it: the partner is dropped, L keeps
  // routing (now to both L/R outputs).
  if (btn.classList.contains("active-l") && rightChannelB3 !== null) {
    const rBtn = elementRefs.chButtons.querySelector(`.ch-btn[data-b3="${rightChannelB3}"]`);
    rBtn?.classList.remove("active-r");
    rightChannelB3 = null;
    await routeActiveSelection();
    return;
  }

  // Click the single active channel → keep it selected. Also guards the
  // Shift-branch below from pairing a channel with itself.
  if (btn.classList.contains("active-l")) {
    return;
  }

  // Shift+click extends a mono selection into an ad-hoc pair:
  // first channel → L out, this one → R out.
  if (shift && leftChannelB3 !== null && rightChannelB3 === null) {
    const lBtn = elementRefs.chButtons.querySelector<HTMLButtonElement>(
      `.ch-btn[data-b3="${leftChannelB3}"]`
    );
    // Don't pair with a stereo-button selection — restart instead.
    if (lBtn && !lBtn.classList.contains("ch-stereo")) {
      rightChannelB3 = b3;
      btn.classList.add("active-r");
      await routeActiveSelection();
      return;
    }
  }

  // Clear any previous mono selection.
  if (leftChannelB3 !== null) {
    await clearAllChannels();
  }

  // Activate: mono channel is routed to both monitor outputs.
  leftChannelB3 = b3;
  rightChannelB3 = null;
  btn.classList.add("active-l");
  await routeActiveSelection();
}

/** Latest mix names (index 0 = Mix 1) — re-applied when buttons are rebuilt. */
let lastMixNames: string[] = [];

/**
 * Update only the names of the existing mix buttons (without rebuilding the
 * DOM, so active highlights and stereo bars survive routing updates).
 */
export function updateMixNames(names: string[]): void {
  lastMixNames = names;
  for (const btn of elementRefs.mixButtons.querySelectorAll<HTMLButtonElement>(".mix-btn")) {
    const mixIdx = Number(btn.dataset.b3) - 0x58;
    const nameEl = btn.querySelector(".mix-btn-name");
    if (nameEl) nameEl.textContent = names[mixIdx] ?? "";
  }
}

/**
 * Apply the stereo mix pairs decoded from ParamData (byte +331 of each mix's
 * channel block, index 0 = Mix 1). Rebuilds the mix buttons only when the set
 * changes, so stereo mixes immediately get their L/R meter bars.
 */
export function updateMixStereoPairs(pairs: number[][]): void {
  const before = JSON.stringify(state.mixStereoPairs);
  const next = pairs.map((p) => [...p]);
  if (before === JSON.stringify(next)) return;
  state.mixStereoPairs = next;
  buildMixButtons();
}

export function buildMixButtons(): void {
  const container = elementRefs.mixButtons;
  container.innerHTML = "";
  const items: MixItem[] = [];
  for (let i = 0; i < 12; i++) items.push({ b3: 0x58 + i, label: `Mix ${i + 1}` });

  for (const item of items) {
    const btn = document.createElement("button");
    btn.type = "button";
    const mixIdx = item.b3 - 0x58;
    const stereo = isMixStereo(mixIdx);
    btn.className = stereo ? "mix-btn mix-stereo" : "mix-btn";
    btn.dataset.b3 = String(item.b3);
    // Vertical level meters first (L, then R for stereo) — querySelector
    // order maps them to the left/right sides.
    btn.appendChild(buildChMeter());
    if (stereo) btn.appendChild(buildChMeter());
    // Label column: "Mix N" plus the console-assigned name underneath
    // (kept fresh by updateMixNames without rebuilding the DOM).
    const numEl = document.createElement("span");
    numEl.className = "mix-btn-num";
    numEl.textContent = item.label;
    btn.appendChild(numEl);
    const nameEl = document.createElement("span");
    nameEl.className = "mix-btn-name";
    nameEl.textContent = lastMixNames[mixIdx] ?? "";
    btn.appendChild(nameEl);
    btn.addEventListener("click", () => toggleMixRoute(item.b3, btn));
    container.appendChild(btn);
  }

  // Re-apply the latest readings so a rebuild (a mix turned out stereo)
  // doesn't blank the bars until the next meter packet.
  if (lastMeters) applyMeters(lastMeters);
  updateSourceLock();
}

// ── FX return buttons ───────────────────────────────────────────────

/** Currently selected FX return (0-based engine index), or null. */
let activeFxIndex: number | null = null;

/** Clear the FX return selection and highlight. */
function clearFxSelection(): void {
  for (const b of elementRefs.fxButtons.querySelectorAll(".fx-btn.active")) {
    b.classList.remove("active");
  }
  activeFxIndex = null;
}

/**
 * FX return click handler — routes the return like a stereo pair:
 * L side → L output, R side → R output.
 * Clicking the active FX keeps it selected (no-op; ESC clears).
 */
async function onFxClick(fxIndex: number, btn: HTMLButtonElement): Promise<void> {
  // Selecting an FX return clears mixes, channels, PAFL and matrix.
  clearActiveMix();
  clearChannelSelection();
  clearPaflSelection();
  clearMatrixSelection();

  // Click the active FX → keep it selected.
  if (btn.classList.contains("active")) return;

  // Drop the previously selected FX return (mutual exclusion, like mixes).
  clearFxSelection();

  activeFxIndex = fxIndex;
  btn.classList.add("active");
  await routeActiveSelection();
}

/** Latest FX return names (index 0 = FX 1) — re-applied when buttons are rebuilt. */
let lastFxNames: string[] = [];

/**
 * Update only the names of the existing FX buttons (without rebuilding the
 * DOM, so the active highlight survives routing updates).
 */
export function updateFxNames(names: string[]): void {
  lastFxNames = names;
  for (const btn of elementRefs.fxButtons.querySelectorAll<HTMLButtonElement>(".fx-btn")) {
    const fxIdx = Number(btn.dataset.fx);
    const nameEl = btn.querySelector(".fx-btn-name");
    if (nameEl) nameEl.textContent = names[fxIdx] ?? "";
  }
}

function buildFxButtons(): void {
  const container = elementRefs.fxButtons;
  container.innerHTML = "";
  // SQ has 4 FX engines (b3 0x40–0x43 → FX 1-4).
  for (let i = 0; i < 4; i++) {
    const btn = document.createElement("button");
    btn.type = "button";
    btn.className = "fx-btn";
    btn.dataset.fx = String(i);
    // Label column: "FX N" plus the console-assigned name underneath
    // (kept fresh by updateFxNames without rebuilding the DOM).
    const numEl = document.createElement("span");
    numEl.className = "fx-btn-num";
    numEl.textContent = `FX ${i + 1}`;
    btn.appendChild(numEl);
    const nameEl = document.createElement("span");
    nameEl.className = "fx-btn-name";
    nameEl.textContent = lastFxNames[i] ?? "";
    btn.appendChild(nameEl);
    btn.addEventListener("click", () => onFxClick(i, btn));
    container.appendChild(btn);
  }
  // Matrix sources: 3 stereo matrices (slot pairs at b3 0x73-0x78) — same
  // row, after the FX returns. First matrix starts a new group. L slot → L
  // output, R slot → R output on click.
  for (let i = 0; i < MATRIX_COUNT; i++) {
    const btn = document.createElement("button");
    btn.type = "button";
    // First matrix starts a new group — extra gap from the FX returns.
    btn.className = i === 0 ? "mtx-btn src-break" : "mtx-btn";
    btn.dataset.mtx = String(i);
    btn.title = `Матрица ${i + 1} (L/R) → выбранные выходы`;
    const numEl = document.createElement("span");
    numEl.className = "mtx-btn-num";
    numEl.textContent = `Mtx ${i + 1}`;
    btn.appendChild(numEl);
    const nameEl = document.createElement("span");
    nameEl.className = "mtx-btn-name";
    nameEl.textContent = lastMatrixNames[i * 2] ?? "";
    btn.appendChild(nameEl);
    btn.addEventListener("click", () => onMatrixClick(i, btn));
    container.appendChild(btn);
  }
  updateSourceLock();
}

// ── PAFL source button ───────────────────────────────────────────────

/** Whether the console's PAFL (solo) bus is the active monitor source. */
let paflActive = false;

/** Clear the PAFL selection and highlight. */
function clearPaflSelection(): void {
  elementRefs.paflBtn.classList.remove("active");
  paflActive = false;
}

/**
 * PAFL click handler — routes the console's solo bus like a stereo pair:
 * PAFL L → L output, PAFL R → R output (monitor output patch).
 * Clicking the active PAFL keeps it selected (no-op; ESC clears).
 */
async function onPaflClick(btn: HTMLButtonElement): Promise<void> {
  // Selecting PAFL clears mixes, channels, FX returns and matrix.
  clearActiveMix();
  clearChannelSelection();
  clearFxSelection();
  clearMatrixSelection();

  // Click the active PAFL → keep it selected.
  if (btn.classList.contains("active")) return;

  paflActive = true;
  btn.classList.add("active");
  await routeActiveSelection();
}

// ── matrix source buttons ────────────────────────────────────────────

/**
 * Matrix buses: the SQ features 3 stereo matrices that can be split into up
 * to 6 mono ones. All six slots are addressable at b3 0x73–0x78 — a stereo
 * matrix occupies a slot pair (first slot = L side, second = R side), split
 * mono matrices use the slots independently. Routing follows the FX-return
 * pattern: L slot → L output, R slot → R output (regular output patches).
 */
const MATRIX_BASE_B3 = 0x73;
const MATRIX_COUNT = 3;

/** Index of the currently selected matrix (0-based), or null. */
let activeMatrixIndex: number | null = null;

/** Latest matrix slot names (index 0 = slot Matrix1-L), from the snapshot. */
let lastMatrixNames: string[] = [];

/** b3 of the L slot of matrix index (0-based); the R slot follows at +1. */
function matrixSlotB3(matrixIndex: number, side: "L" | "R"): number {
  return MATRIX_BASE_B3 + matrixIndex * 2 + (side === "R" ? 1 : 0);
}

/** Clear the matrix selection and highlight. */
function clearMatrixSelection(): void {
  for (const b of elementRefs.fxButtons.querySelectorAll(".mtx-btn.active")) {
    b.classList.remove("active");
  }
  activeMatrixIndex = null;
}

/**
 * Matrix click handler — routes the matrix like a stereo pair:
 * L slot → L output, R slot → R output (regular output-patch frames).
 * Clicking the active matrix keeps it selected (no-op; ESC clears).
 */
async function onMatrixClick(matrixIndex: number, btn: HTMLButtonElement): Promise<void> {
  // Selecting a matrix clears mixes, channels, FX returns and PAFL.
  clearActiveMix();
  clearChannelSelection();
  clearFxSelection();
  clearPaflSelection();

  // Click the active matrix → keep it selected.
  if (btn.classList.contains("active")) return;

  clearMatrixSelection();
  activeMatrixIndex = matrixIndex;
  btn.classList.add("active");
  await routeActiveSelection();
}

/**
 * Update only the names of the existing matrix buttons (without rebuilding
 * the DOM, so the active highlight survives routing updates). A stereo
 * matrix shares its name across both slots — the L slot's name is shown.
 */
export function updateMatrixNames(names: string[]): void {
  lastMatrixNames = names;
  for (const btn of elementRefs.fxButtons.querySelectorAll<HTMLButtonElement>(".mtx-btn")) {
    const mtxIdx = Number(btn.dataset.mtx);
    const nameEl = btn.querySelector(".mtx-btn-name");
    if (nameEl) nameEl.textContent = names[mtxIdx * 2] ?? "";
  }
}

// ── channel buttons ─────────────────────────────────────────────────

// ── vertical level meters on the channel buttons ─────────────────────

/**
 * A thin vertical meter at the left edge of a channel button: fill grows
 * bottom-up, clip flag lights at the top. Stereo buttons carry two of
 * these (L, R) side by side.
 */
function buildChMeter(): HTMLElement {
  const meter = document.createElement("span");
  meter.className = "ch-meter";
  const fill = document.createElement("span");
  fill.className = "ch-meter-fill";
  meter.appendChild(fill);
  const clip = document.createElement("span");
  clip.className = "ch-meter-clip";
  meter.appendChild(clip);
  return meter;
}

let pendingMeters: MetersPayload | null = null;
let meterFrame: number | null = null;
/** Latest applied payload — re-applied when buttons are rebuilt. */
let lastMeters: MetersPayload | null = null;

/**
 * Mixes observed carrying distinct L/R levels (mixesL ≠ mixesR beyond a
 * small threshold). Mono buses meter L and R bit-identically, so a real
 * divergence means the bus is a stereo mix. Latched for the session — a
 * stereo mix fed mono content (L == R) keeps its two bars.
 */
const stereoObservedMixes = new Set<number>();
/** dB difference between sides treated as a real L/R divergence. */
const STEREO_DIVERGENCE_DB = 0.4;

/**
 * Latch stereo-observed mixes from the latest payload.
 * Returns true when the set changed (mix buttons need a rebuild).
 */
function updateStereoObservedMixes(m: MetersPayload | null): boolean {
  if (!m?.mixesL || !m?.mixesR) return false;
  let changed = false;
  for (let i = 0; i < 12; i++) {
    if (stereoObservedMixes.has(i)) continue;
    const l = m.mixesL[i];
    const r = m.mixesR[i];
    if (l != null && r != null && Math.abs(l - r) >= STEREO_DIVERGENCE_DB) {
      stereoObservedMixes.add(i);
      changed = true;
    }
  }
  return changed;
}

/** A mix shows the stereo L/R meter: reported pair or divergence observed. */
function isMixStereo(mixIdx: number): boolean {
  return getMixPair(mixIdx) !== null || stereoObservedMixes.has(mixIdx);
}

/**
 * Apply a meters payload to the channel buttons, coalescing the incoming
 * stream per animation frame (same pattern as the routing tab).
 */
export function updateMeters(p: MetersPayload | null): void {
  pendingMeters = p;
  if (meterFrame !== null) return;
  meterFrame = requestAnimationFrame(() => {
    meterFrame = null;
    const m = pendingMeters;
    pendingMeters = null;
    if (updateStereoObservedMixes(m)) {
      // A mix just turned out to be stereo — rebuild its button with two
      // bars (the rebuild re-applies the latest readings itself).
      buildMixButtons();
    }
    applyMeters(m);
  });
}

/** Clear all channel meters (disconnect / fresh session). */
export function clearMeters(): void {
  lastMeters = null;
  updateMeters(null);
}

function applyMeters(m: MetersPayload | null): void {
  lastMeters = m;
  for (const btn of elementRefs.chButtons.querySelectorAll<HTMLButtonElement>(".ch-btn")) {
    const b3 = Number(btn.dataset.b3);
    const b3r = btn.dataset.b3r ? Number(btn.dataset.b3r) : null;
    const meters = btn.querySelectorAll<HTMLElement>(".ch-meter");
    // First bar = left (or mono) channel; second bar = stereo right.
    applyChMeter(meters[0] ?? null, m ? m.inputs[b3] ?? null : null, m ? !!m.clip[b3] : false);
    if (b3r !== null) {
      applyChMeter(meters[1] ?? null, m ? m.inputs[b3r] ?? null : null, m ? !!m.clip[b3r] : false);
    }
  }
  // Mix buses 1–12 (live from UDP packet 0x18). A stereo mix shows two
  // bars (L | R); a mono mix keeps a single bar. Stereo is either reported
  // in the snapshot (mixStereoPairs) or latched from observed L/R
  // divergence; for a reported pair the sides combine across both buses.
  for (const btn of elementRefs.mixButtons.querySelectorAll<HTMLButtonElement>(".mix-btn")) {
    const meters = btn.querySelectorAll<HTMLElement>(".ch-meter");
    if (!meters.length) continue;
    const mixIdx = Number(btn.dataset.b3) - 0x58;
    if (isMixStereo(mixIdx) && meters.length >= 2) {
      const pair = getMixPair(mixIdx);
      const p0 = pair ? pair[0] : mixIdx;
      const p1 = pair ? pair[1] : mixIdx;
      applyChMeter(
        meters[0],
        louderDb(m?.mixesL?.[p0], m?.mixesL?.[p1]),
        !!(m?.mixClipL?.[p0] || m?.mixClipL?.[p1])
      );
      applyChMeter(
        meters[1],
        louderDb(m?.mixesR?.[p0], m?.mixesR?.[p1]),
        !!(m?.mixClipR?.[p0] || m?.mixClipR?.[p1])
      );
    } else {
      applyChMeter(meters[0], m?.mixes?.[mixIdx] ?? null, !!m?.mixClip?.[mixIdx]);
    }
  }
  // Main LR button (static HTML in .monitor-setup): always a stereo meter.
  const lrMeters = elementRefs.mainlrBtn.querySelectorAll<HTMLElement>(".ch-meter");
  applyChMeter(lrMeters[0] ?? null, m?.mainLRL ?? m?.mainLR ?? null, !!(m?.mainLRClipL ?? m?.mainLRClip));
  applyChMeter(lrMeters[1] ?? null, m?.mainLRR ?? m?.mainLR ?? null, !!(m?.mainLRClipR ?? m?.mainLRClip));
}

/** Apply one channel's reading to a single vertical meter. */
function applyChMeter(
  meter: HTMLElement | null,
  db: number | null,
  isClip: boolean
): void {
  if (!meter) return;
  const fill = meter.querySelector<HTMLElement>(".ch-meter-fill");
  const clip = meter.querySelector<HTMLElement>(".ch-meter-clip");
  if (!fill || !clip) return;

  fill.style.height = `${dbToPercent(db)}%`;
  fill.className = `ch-meter-fill${meterClassName(db)}`;
  clip.classList.toggle("on", isClip);
}

/** Check if a mix (0-based) belongs to a stereo-linked pair; returns the pair. */
function getMixPair(mixIdx: number): number[] | null {
  return state.mixStereoPairs.find(([a, b]) => a === mixIdx || b === mixIdx) ?? null;
}

/** Louder of two optional dB readings (null-aware). */
function louderDb(a: number | null | undefined, b: number | null | undefined): number | null {
  if (a == null) return b ?? null;
  if (b == null) return a;
  return Math.max(a, b);
}

/** Check if a b3 is the left side of a stereo pair. Returns the pair or null. */
function getStereoPair(b3: number): number[] | null {
  for (const pair of state.stereoPairs) {
    if (pair[0] === b3) return pair;
  }
  return null;
}

/** Check if a b3 is the right side of a stereo pair (skip it — merged into left). */
function isStereoRight(b3: number): boolean {
  return state.stereoPairs.some((p) => p[1] === b3);
}

/**
 * Create the 48 channel buttons once. Stereo pairs are merged into one cell
 * spanning 2 grid columns. Rebuilt when the console's stereo pairs change.
 */
export function buildChannelButtons(): void {
  const container = elementRefs.chButtons;
  container.innerHTML = "";

  for (let i = 0; i < 48; i++) {
    const b3 = i;
    // Right side of a stereo pair is skipped — merged into the left cell
    if (isStereoRight(b3)) continue;

    const pair = getStereoPair(b3);
    const isStereo = pair !== null;

    const btn = document.createElement("button");
    btn.type = "button";
    btn.className = isStereo ? "ch-btn ch-stereo" : "ch-btn";
    btn.dataset.b3 = String(b3);
    if (isStereo) {
      btn.dataset.b3r = String(pair[1]);
      btn.style.gridColumn = "span 2";
    }

    // Vertical level meters first (L, then R for stereo) — querySelector
    // order maps them to the left/right channels.
    btn.appendChild(buildChMeter());
    if (isStereo) btn.appendChild(buildChMeter());

    const numEl = document.createElement("span");
    numEl.className = "ch-btn-num";
    if (isStereo) {
      numEl.textContent = `${b3 + 1}-${pair[1] + 1}`;
    } else {
      numEl.textContent = String(b3 + 1);
    }
    btn.appendChild(numEl);

    const nameEl = document.createElement("span");
    nameEl.className = "ch-btn-name";
    btn.appendChild(nameEl);

    if (isStereo) {
      btn.addEventListener("click", () => onStereoClick(pair[0], pair[1], btn));
    } else {
      btn.addEventListener("click", (e) => onChannelClick(b3, btn, e.shiftKey));
    }
    container.appendChild(btn);
  }

  // Re-apply the latest readings so a rebuild (stereo pairs changed) doesn't
  // blank the bars until the next meter packet.
  if (lastMeters) applyMeters(lastMeters);
  updateSourceLock();
}

/** Click handler for a stereo pair — routes left ch to L out, right ch to R out. */
async function onStereoClick(b3L: number, b3R: number, btn: HTMLButtonElement): Promise<void> {
  // Selecting a channel clears any active mix, FX return, PAFL and matrix.
  clearActiveMix();
  clearFxSelection();
  clearPaflSelection();
  clearMatrixSelection();

  // Click the active stereo pair → keep it selected (no-op; ESC clears).
  if (btn.classList.contains("active-l")) return;

  // Clear previous channel selections.
  if (leftChannelB3 !== null || rightChannelB3 !== null) {
    await clearAllChannels();
  }

  // Assign stereo pair: left channel → L output, right channel → R output
  // (two separate patch frames). Default the R output to the adjacent socket.
  leftChannelB3 = b3L;
  rightChannelB3 = b3R;
  btn.classList.add("active-l");
  alignRToLNeighbor();
  await routeActiveSelection();
}

/** Clear all channel selections and highlights. Routing is left untouched. */
async function clearAllChannels(): Promise<void> {
  for (const btn of elementRefs.chButtons.querySelectorAll(".ch-btn.active-l, .ch-btn.active-r")) {
    btn.classList.remove("active-l", "active-r");
  }
  leftChannelB3 = null;
  rightChannelB3 = null;
}

/**
 * Update only the names of existing channel buttons (without rebuilding DOM,
 * so active-l / active-r highlights survive routing updates).
 */
export function updateChannelNames(inputs: SnapshotInput[]): void {
  const nameMap = new Map<number, string>();
  for (const inp of inputs) nameMap.set(inp.destB3, inp.name || "");

  for (const btn of elementRefs.chButtons.querySelectorAll<HTMLButtonElement>(".ch-btn")) {
    const b3 = Number(btn.dataset.b3);
    const b3r = btn.dataset.b3r ? Number(btn.dataset.b3r) : null;

    if (b3r !== null) {
      // Stereo: show combined name from left channel
      const name = nameMap.get(b3) || "";
      const nameEl = btn.querySelector(".ch-btn-name");
      if (nameEl) nameEl.textContent = name;
    } else {
      const name = nameMap.get(b3) || "";
      const nameEl = btn.querySelector(".ch-btn-name");
      if (nameEl) nameEl.textContent = name;
    }
  }
}

// ── reset (fresh dashboard session) ─────────────────────────────────

export function reset(): void {
  lastOutputs = null; // fresh session — no stale usage annotations
  savedOutputs = null; // no borrow session to restore
  borrowedKeys = null;
  // Safe outputs persist across sessions (localStorage) — not cleared here.
  closeLockModal();
  updateLockBtnDot();
  elementRefs.monEnable.checked = false; // fresh session — start unchecked
  populateMonitorSelects();
  state.stereoPairs = [];
  state.mixStereoPairs = [];
  stereoObservedMixes.clear();
  lastMixNames = []; // fresh session — no stale mix names
  buildMixButtons(); // rebuild without stereo bars
  lastMeters = null; // fresh session — don't re-apply stale readings
  buildChannelButtons();
  lastFxNames = []; // fresh session — no stale FX names
  lastMatrixNames = []; // fresh session — no stale matrix names
  buildFxButtons();
  // Main LR active by default (UI-only — no command sent unless enabled)
  activeSourceB3 = 0x68;
  leftChannelB3 = null;
  rightChannelB3 = null;
  activeFxIndex = null;
  paflActive = false;
  activeMatrixIndex = null;
  elementRefs.paflBtn.classList.remove("active");
  elementRefs.mainlrBtn.classList.add("active");
  renderSendDebug(planActiveSelection());
}

// ── bindings ─────────────────────────────────────────────────────────

// The Main LR button is static HTML — attach its stereo level meter once
// (always two bars: Main LR is a stereo bus).
elementRefs.mainlrBtn.dataset.b3 = String(0x68);
elementRefs.mainlrBtn.classList.add("mix-stereo");
elementRefs.mainlrBtn.appendChild(buildChMeter());
elementRefs.mainlrBtn.appendChild(buildChMeter());

elementRefs.monLDest.addEventListener("change", async () => {
  // Auto-select the neighboring (channel+1) output for the right side —
  // unless it is a safe output (disabled).
  alignRToLNeighbor();
  updateSourceLock();
  recordBorrowedOutputs();
  // Re-route the active source to the new L output.
  await routeActiveSelection();
});
elementRefs.monRDest.addEventListener("change", () => {
  updateSourceLock();
  recordBorrowedOutputs();
  routeActiveSelection();
});

// "Применять": enabling captures the output-routing snapshot and routes the
// current selection; disabling restores the captured routing.
elementRefs.monEnable.addEventListener("change", () => {
  void onMonEnableChange();
});

// Padlock button — opens the output selection modal.
elementRefs.monLockBtn.addEventListener("click", () => {
  if (lockModalOpen()) closeLockModal();
  else openLockModal();
});
elementRefs.monLockClose.addEventListener("click", closeLockModal);
for (const tab of elementRefs.monLockTabs.querySelectorAll<HTMLButtonElement>(".mon-lock-tab")) {
  tab.addEventListener("click", () => {
    for (const t of elementRefs.monLockTabs.querySelectorAll(".mon-lock-tab")) {
      t.classList.remove("active");
    }
    tab.classList.add("active");
    syncLockPanels();
  });
}

// Main LR button — routes Main LR like a mix selection
elementRefs.mainlrBtn.addEventListener("click", () => toggleMixRoute(0x68, elementRefs.mainlrBtn));

// PAFL button (static HTML, beside Main LR) — routes the console's solo bus.
elementRefs.paflBtn.addEventListener("click", () => onPaflClick(elementRefs.paflBtn));

// ── arrow key navigation (left/right) ────────────────────────────────
// If a channel is active → arrows cycle through channels only.
// If a mix is active → arrows cycle through mixes only.
// Main LR and nothing-selected → arrows do nothing.

window.addEventListener("keydown", (e: KeyboardEvent) => {
  if (elementRefs.viewMonitor.hidden) return;
  if (lockModalOpen()) return;
  if (e.key !== "ArrowLeft" && e.key !== "ArrowRight") return;
  if (e.target instanceof HTMLSelectElement || e.target instanceof HTMLInputElement) return;

  e.preventDefault();

  const channelBtns = [...elementRefs.chButtons.querySelectorAll<HTMLButtonElement>(".ch-btn")];
  const mixBtns = [...elementRefs.mixButtons.querySelectorAll<HTMLButtonElement>(".mix-btn")];

  // Determine active group: channels or mixes
  let group: HTMLButtonElement[];
  let groupActive: (b: HTMLButtonElement) => boolean;
  const chActive = channelBtns.some(
    (b) => b.classList.contains("active-l") || b.classList.contains("active-r")
  );
  const mixActive = mixBtns.some((b) => b.classList.contains("active"));

  if (chActive) {
    group = channelBtns;
    groupActive = (b) => b.classList.contains("active-l") || b.classList.contains("active-r");
  } else if (mixActive) {
    group = mixBtns;
    groupActive = (b) => b.classList.contains("active");
  } else {
    return; // Main LR or nothing selected → no navigation
  }

  const idx = group.findIndex(groupActive);
  let next: number;
  if (e.key === "ArrowRight") {
    next = idx < group.length - 1 ? idx + 1 : 0;
  } else {
    next = idx > 0 ? idx - 1 : group.length - 1;
  }
  // Toggle off current, toggle on next
  group[idx].click();
  group[next].click();
  group[next].scrollIntoView({ block: "nearest", behavior: "smooth" });
});

// ── number keys 1-9 → Mix 1-9, 0 → Mix 10 ────────────────────────────

window.addEventListener("keydown", (e: KeyboardEvent) => {
  if (elementRefs.viewMonitor.hidden) return;
  if (lockModalOpen()) return;
  if (e.target instanceof HTMLSelectElement || e.target instanceof HTMLInputElement) return;

  const num = parseInt(e.key, 10);
  if (isNaN(num)) return;

  // 1-9 → Mix 1-9, 0 → Mix 10
  const mixNum = num === 0 ? 10 : num;
  if (mixNum < 1 || mixNum > 12) return;

  const mixBtns = [...elementRefs.mixButtons.querySelectorAll<HTMLButtonElement>(".mix-btn")];
  const btn = mixBtns[mixNum - 1];
  if (btn) {
    e.preventDefault();
    // Only activate; never toggle off via number keys
    if (!btn.classList.contains("active")) {
      btn.click();
    }
    btn.scrollIntoView({ block: "nearest", behavior: "smooth" });
  }
});

// ── ESC: disable monitor + clear all selections ─────────────────────

window.addEventListener("keydown", (e: KeyboardEvent) => {
  if (elementRefs.viewMonitor.hidden) return;
  if (e.key !== "Escape") return;
  // ESC with the lock modal open just closes the modal.
  if (lockModalOpen()) {
    e.preventDefault();
    closeLockModal();
    return;
  }
  if (!monEnabled()) return;
  if (e.target instanceof HTMLSelectElement || e.target instanceof HTMLInputElement) return;
  e.preventDefault();

  // Clear all selections and highlights.
  clearActiveMix();
  clearChannelSelection();
  clearFxSelection();
  clearPaflSelection();
  clearMatrixSelection();
  elementRefs.mainlrBtn.classList.remove("active");

  // Uncheck the enable checkbox — this also restores the saved output
  // routing (same path as unchecking by click).
  elementRefs.monEnable.checked = false;
  void onMonEnableChange();
});
