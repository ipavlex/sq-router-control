/**
 * SQ Router Control — Monitor tab.
 * L/R output selectors, mix / channel / Main LR routing into the selected
 * outputs, and the keyboard navigation.
 */
import { els, state } from "../../utils";
import type { SnapshotInput } from "../../../shared/ipc";
import type { OutputOption, Dest, MixItem } from "./types";

// ── output selectors ─────────────────────────────────────────────────

/**
 * Build the list of all available physical outputs from the model spec.
 * Returns array of {value, label} where value = "destType:channel".
 */
function buildOutputOptions(): OutputOption[] {
  const opts: OutputOption[] = [];
  const spec = state.modelSpec;
  // Local Out 1..N
  if (spec) {
    for (let i = 1; i <= spec.localOutputs; i++) {
      opts.push({ value: `0x1a:${i}`, label: `Local Out ${i}` });
    }
  } else {
    for (let i = 1; i <= 24; i++) {
      opts.push({ value: `0x1a:${i}`, label: `Local Out ${i}` });
    }
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
  for (const sel of [els.monLDest, els.monRDest]) {
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
      groups[type].appendChild(opt);
    }
    for (const g of Object.values(groups)) sel.appendChild(g);
  }
  // Default to Local Out 1 (L) and Local Out 2 (R)
  els.monLDest.value = "0x1a:1";
  els.monRDest.value = "0x1a:2";
}

/** Whether monitor changes should be applied to the actual mixer. */
function monEnabled(): boolean {
  return els.monEnable.checked;
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
  const L = parseDest(els.monLDest);
  const R = parseDest(els.monRDest);
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
 * Selecting routes the mix to the selected L/R outputs; deselecting leaves
 * the current routing untouched.
 */
async function toggleMixRoute(b3: number, btn: HTMLButtonElement): Promise<void> {
  const isOn = btn.classList.contains("active");
  clearActiveMix();
  // Also clear channel selections when picking a mix
  clearChannelSelection();
  if (!isOn) {
    activeSourceB3 = b3;
    btn.classList.add("active");
    await routeActiveSelection();
  }
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
 *   Click active channel   → deselect (routing stays as-is)
 */
async function onChannelClick(b3: number, btn: HTMLButtonElement): Promise<void> {
  // Selecting a channel clears any active mix.
  clearActiveMix();

  // Click active channel → deselect.
  if (btn.classList.contains("active-l")) {
    btn.classList.remove("active-l");
    leftChannelB3 = null;
    return;
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
  const container = els.mixButtons;
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
  const container = els.chButtons;
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
      btn.addEventListener("click", () => onChannelClick(b3, btn));
    }
    container.appendChild(btn);
  }
}

/** Click handler for a stereo pair — routes left ch to L out, right ch to R out. */
async function onStereoClick(b3L: number, b3R: number, btn: HTMLButtonElement): Promise<void> {
  // Selecting a channel clears any active mix.
  clearActiveMix();

  // Toggle off if already active — routing stays as-is.
  if (btn.classList.contains("active-l")) {
    btn.classList.remove("active-l");
    leftChannelB3 = null;
    rightChannelB3 = null;
    return;
  }

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
  for (const btn of els.chButtons.querySelectorAll(".ch-btn.active-l, .ch-btn.active-r")) {
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

  for (const btn of els.chButtons.querySelectorAll<HTMLButtonElement>(".ch-btn")) {
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
  populateMonitorSelects();
  buildMixButtons();
  state.stereoPairs = [];
  buildChannelButtons();
  // Main LR active by default (UI-only — no command sent unless enabled)
  activeSourceB3 = 0x68;
  leftChannelB3 = null;
  rightChannelB3 = null;
  els.mainlrBtn.classList.add("active");
}

// ── bindings ─────────────────────────────────────────────────────────

els.monLDest.addEventListener("change", async () => {
  // Auto-select the neighboring (channel+1) output for the right side.
  const [destTypeHex, chStr] = els.monLDest.value.split(":");
  const neighborVal = `${destTypeHex}:${Number(chStr) + 1}`;
  if ([...els.monRDest.options].some((o) => o.value === neighborVal)) {
    els.monRDest.value = neighborVal;
  }
  // Re-route the active source to the new L output.
  await routeActiveSelection();
});
els.monRDest.addEventListener("change", () => routeActiveSelection());

// Enabling "Применять" immediately routes the current selection.
els.monEnable.addEventListener("change", () => {
  if (monEnabled()) routeActiveSelection();
});

// Main LR button — routes Main LR like a mix selection
els.mainlrBtn.addEventListener("click", () => toggleMixRoute(0x68, els.mainlrBtn));

// ── arrow key navigation (left/right) ────────────────────────────────
// If a channel is active → arrows cycle through channels only.
// If a mix is active → arrows cycle through mixes only.
// Main LR and nothing-selected → arrows do nothing.

window.addEventListener("keydown", (e: KeyboardEvent) => {
  if (els.viewMonitor.hidden) return;
  if (e.key !== "ArrowLeft" && e.key !== "ArrowRight") return;
  if (e.target instanceof HTMLSelectElement || e.target instanceof HTMLInputElement) return;

  e.preventDefault();

  const channelBtns = [...els.chButtons.querySelectorAll<HTMLButtonElement>(".ch-btn")];
  const mixBtns = [...els.mixButtons.querySelectorAll<HTMLButtonElement>(".mix-btn")];

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
  if (els.viewMonitor.hidden) return;
  if (e.target instanceof HTMLSelectElement || e.target instanceof HTMLInputElement) return;

  const num = parseInt(e.key, 10);
  if (isNaN(num)) return;

  // 1-9 → Mix 1-9, 0 → Mix 10
  const mixNum = num === 0 ? 10 : num;
  if (mixNum < 1 || mixNum > 12) return;

  const mixBtns = [...els.mixButtons.querySelectorAll<HTMLButtonElement>(".mix-btn")];
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
  if (els.viewMonitor.hidden) return;
  if (e.key !== "Escape") return;
  if (!monEnabled()) return;
  if (e.target instanceof HTMLSelectElement || e.target instanceof HTMLInputElement) return;
  e.preventDefault();

  // Clear all selections and highlights. The routing is left as-is — the
  // outputs keep the last selected source.
  clearActiveMix();
  clearChannelSelection();
  els.mainlrBtn.classList.remove("active");

  // Uncheck the enable checkbox
  els.monEnable.checked = false;
});
