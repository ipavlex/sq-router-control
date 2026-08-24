/**
 * SQ Router Control — Monitor tab.
 * L/R output selectors, mix / channel / Main LR routing into the selected
 * outputs, and the keyboard navigation.
 *
 * Mono channel selection supports an ad-hoc pair: click a channel (→ both
 * L/R outputs), then Shift+click a second mono channel — the first goes to
 * the L output, the second to the R output.
 */
import { elementRefs, state } from "../../core/utils";
import { dbToPercent, meterClassName } from "../../core/meters";
import type { SnapshotInput, SnapshotOutput, MetersPayload } from "../../../shared/ipc";
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
    // Placeholder
    const ph = document.createElement("option");
    ph.value = "";
    ph.textContent = "— не выбран —";
    ph.disabled = true;
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

/** Rewrite option labels as "base · source" for outputs present in the routing. */
function applyOutputUsage(): void {
  if (!lastOutputs) return;
  const byKey = outputUsageMap();
  for (const sel of [elementRefs.monLDest, elementRefs.monRDest]) {
    for (const opt of sel.options) {
      if (!opt.value) continue; // "— не выбран —" placeholder
      const [destTypeHex, chStr] = opt.value.split(":");
      const src = byKey.get(`${parseInt(destTypeHex, 16)}:${Number(chStr)}`);
      const base = opt.dataset.baseLabel || opt.textContent || "";
      opt.dataset.baseLabel = base;
      opt.textContent = src ? `${base} · ${src}` : base;
    }
  }
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

/** Route a source b3 to a physical output (output patch). */
async function routeSourceToOutput(
  sourceB3: number | null,
  dest: Dest | null
): Promise<void> {
  if (sourceB3 === null || !dest) return;
  await window.sq.setOutputPatch(sourceB3, dest.destType, dest.destChannel);
}

/**
 * Route the currently selected source to the selected L/R monitor outputs:
 *   stereo pair   → left channel → L out, right channel → R out
 *   mono channel  → source → both L and R outs
 *   mix / Main LR → source → both L and R outs
 * A deselection never changes the routing — the outputs keep the last source.
 */
async function routeActiveSelection(): Promise<void> {
  if (!monEnabled()) return;
  const L = parseDest(elementRefs.monLDest);
  const R = parseDest(elementRefs.monRDest);
  if (leftChannelB3 !== null && rightChannelB3 !== null) {
    await routeSourceToOutput(leftChannelB3, L);
    await routeSourceToOutput(rightChannelB3, R);
  } else if (leftChannelB3 !== null) {
    await routeSourceToOutput(leftChannelB3, L);
    await routeSourceToOutput(leftChannelB3, R);
  } else if (activeSourceB3 !== null) {
    await routeSourceToOutput(activeSourceB3, L);
    await routeSourceToOutput(activeSourceB3, R);
  }
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
  // Also clear channel selections when picking a mix
  clearChannelSelection();
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
  // Selecting a channel clears any active mix.
  clearActiveMix();

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

function buildMixButtons(): void {
  const container = elementRefs.mixButtons;
  container.innerHTML = "";
  const items: MixItem[] = [];
  for (let i = 0; i < 12; i++) items.push({ b3: 0x58 + i, label: `Mix ${i + 1}` });

  for (const item of items) {
    const btn = document.createElement("button");
    btn.type = "button";
    btn.className = "mix-btn";
    btn.textContent = item.label;
    btn.dataset.b3 = String(item.b3);
    btn.addEventListener("click", () => toggleMixRoute(item.b3, btn));
    container.appendChild(btn);
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
    applyChMeter(meters[0] ?? null, m, b3);
    if (b3r !== null) applyChMeter(meters[1] ?? null, m, b3r);
  }
}

/** Apply one channel's reading to a single vertical meter. */
function applyChMeter(
  meter: HTMLElement | null,
  m: MetersPayload | null,
  ch: number
): void {
  if (!meter) return;
  const fill = meter.querySelector<HTMLElement>(".ch-meter-fill");
  const clip = meter.querySelector<HTMLElement>(".ch-meter-clip");
  if (!fill || !clip) return;

  const db = m ? m.inputs[ch] ?? null : null;
  const isClip = m ? !!m.clip[ch] : false;

  fill.style.height = `${dbToPercent(db)}%`;
  fill.className = `ch-meter-fill${meterClassName(db)}`;
  clip.classList.toggle("on", isClip);
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
}

/** Click handler for a stereo pair — routes left ch to L out, right ch to R out. */
async function onStereoClick(b3L: number, b3R: number, btn: HTMLButtonElement): Promise<void> {
  // Selecting a channel clears any active mix.
  clearActiveMix();

  // Click the active stereo pair → keep it selected (no-op; ESC clears).
  if (btn.classList.contains("active-l")) return;

  // Clear previous channel selections.
  if (leftChannelB3 !== null || rightChannelB3 !== null) {
    await clearAllChannels();
  }

  // Assign stereo pair: left channel → L output, right channel → R output.
  leftChannelB3 = b3L;
  rightChannelB3 = b3R;
  btn.classList.add("active-l");
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
  populateMonitorSelects();
  buildMixButtons();
  state.stereoPairs = [];
  lastMeters = null; // fresh session — don't re-apply stale readings
  buildChannelButtons();
  // Main LR active by default (UI-only — no command sent unless enabled)
  activeSourceB3 = 0x68;
  leftChannelB3 = null;
  rightChannelB3 = null;
  elementRefs.mainlrBtn.classList.add("active");
}

// ── bindings ─────────────────────────────────────────────────────────

elementRefs.monLDest.addEventListener("change", async () => {
  // Auto-select the neighboring (channel+1) output for the right side.
  const [destTypeHex, chStr] = elementRefs.monLDest.value.split(":");
  const neighborVal = `${destTypeHex}:${Number(chStr) + 1}`;
  if ([...elementRefs.monRDest.options].some((o) => o.value === neighborVal)) {
    elementRefs.monRDest.value = neighborVal;
  }
  // Re-route the active source to the new L output.
  await routeActiveSelection();
});
elementRefs.monRDest.addEventListener("change", () => routeActiveSelection());

// Enabling "Применять" immediately routes the current selection.
elementRefs.monEnable.addEventListener("change", () => {
  if (monEnabled()) routeActiveSelection();
});

// Main LR button — routes Main LR like a mix selection
elementRefs.mainlrBtn.addEventListener("click", () => toggleMixRoute(0x68, elementRefs.mainlrBtn));

// ── arrow key navigation (left/right) ────────────────────────────────
// If a channel is active → arrows cycle through channels only.
// If a mix is active → arrows cycle through mixes only.
// Main LR and nothing-selected → arrows do nothing.

window.addEventListener("keydown", (e: KeyboardEvent) => {
  if (elementRefs.viewMonitor.hidden) return;
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
  if (!monEnabled()) return;
  if (e.target instanceof HTMLSelectElement || e.target instanceof HTMLInputElement) return;
  e.preventDefault();

  // Clear all selections and highlights. The routing is left as-is — the
  // outputs keep the last selected source.
  clearActiveMix();
  clearChannelSelection();
  elementRefs.mainlrBtn.classList.remove("active");

  // Uncheck the enable checkbox
  elementRefs.monEnable.checked = false;
});
