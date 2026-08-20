/**
 * SQ Router Control — Routing tab.
 * Active Patching, editable Input Patching (A/B presets), Upload/Download,
 * sync scroll, and the save/load routing modals.
 */
import { elementRefs, state, escapeHtml, flashTitle, todayStr } from "../../core/utils";
import { buildChannelButtons } from "../monitor";
import type { SnapshotInput, SnapshotPayload } from "../../../shared/ipc";
import type { EditRow, PatchInput, MergedInput, SavedSet, SavedRoutingEntry } from "./types";

// ── stereo merge helpers ─────────────────────────────────────────────

/** Set of b3 values that are the RIGHT side of a stereo pair (to be skipped). */
function stereoRightSet(pairs: number[][]): Set<number> {
  const set = new Set<number>();
  for (const [left, right] of pairs) set.add(right);
  return set;
}

/** Returns the stereo pair for a left b3, or null. */
function stereoPairForLeft(b3: number, pairs: number[][]): [number, number] | null {
  for (const [l, r] of pairs) if (l === b3) return [l, r];
  return null;
}

/**
 * Merge stereo pairs in an inputs array: right-side channels are removed,
 * left-side channels get a combined label and the right channel's info.
 * Returns a new array.
 */
function mergeStereoInputs(inputs: PatchInput[], pairs: number[][]): MergedInput[] {
  const rightSet = stereoRightSet(pairs);
  const byB3: Record<number, PatchInput> = {};
  for (const inp of inputs) byB3[inp.destB3] = inp;
  const result: MergedInput[] = [];
  for (const inp of inputs) {
    if (rightSet.has(inp.destB3)) continue; // skip right side
    const pair = stereoPairForLeft(inp.destB3, pairs);
    if (pair) {
      const right = byB3[pair[1]];
      const merged: MergedInput = { ...(inp as SnapshotInput) };
      merged.destLabel = `${inp.destLabel}-${pair[1] + 1}`;
      merged._stereo = true;
      merged._rightSourceChannel = right ? right.sourceChannel : inp.sourceChannel + 1;
      result.push(merged);
    } else {
      result.push(inp as SnapshotInput);
    }
  }
  return result;
}

/**
 * Show the 1-based source channel number. The wire value is 0-indexed
 * (matching the SQ b3 address space), but inputs on the console surface
 * are labelled 1..N, so we display 1-based.
 */
function formatSourceChannel(patch: SnapshotInput): string {
  return String(patch.sourceChannel + 1);
}

// ── Active Patching table ────────────────────────────────────────────

export function renderInputs(inputs: SnapshotInput[]): void {
  state.activeInputs = inputs;
  const merged = mergeStereoInputs(inputs, state.stereoPairs);
  elementRefs.inputTbody.innerHTML = "";
  if (!merged.length) {
    elementRefs.inEmpty.hidden = false;
    return;
  }
  elementRefs.inEmpty.hidden = true;
  const frag = document.createDocumentFragment();
  for (const r of merged) {
    const tr = document.createElement("tr");
    const inLabel = r._stereo
      ? `${r.sourceChannel + 1}-${(r._rightSourceChannel ?? 0) + 1}`
      : formatSourceChannel(r);
    tr.innerHTML =
      `<td class="ch-cell">${escapeHtml(r.destLabel)}</td>` +
      `<td class="name-cell">${escapeHtml(r.name || "—")}</td>` +
      `<td class="src-cell">${escapeHtml(r.sourceLabel)}</td>` +
      `<td>${escapeHtml(inLabel)}</td>`;
    frag.appendChild(tr);
  }
  elementRefs.inputTbody.appendChild(frag);
  updateTransferButtons();
}

// ── editable input patching ──────────────────────────────────────────

const INPUT_SOURCES: { value: number; label: string }[] = [
  { value: 0x01, label: "Local" },
  { value: 0x02, label: "dSnake / SLink" },
  { value: 0x03, label: "USB" },
  { value: 0x04, label: "I/O Port" },
];

/** Max channels available for a given source type (1-based count). */
function maxSourceChannel(source: number): number {
  switch (source) {
    case 0x01: return state.modelSpec ? state.modelSpec.localInputs : 48;
    case 0x02: return 48;
    case 0x03: return state.modelSpec ? state.modelSpec.usbChannels : 32;
    case 0x04: return 64;
    default: return 48;
  }
}

/** Populate the input-number <select> with options 1..max for a source type. */
function populateInputNumberSelect(
  selectEl: HTMLSelectElement,
  source: number,
  currentValue?: number | null
): void {
  const max = maxSourceChannel(source);
  selectEl.innerHTML = "";
  for (let i = 0; i < max; i++) {
    const opt = document.createElement("option");
    opt.value = String(i);
    opt.textContent = String(i + 1);
    selectEl.appendChild(opt);
  }
  const v = currentValue != null ? currentValue : Number(selectEl.dataset.prev);
  if (v != null && v >= 0 && v < max) {
    selectEl.value = String(v);
  }
  selectEl.dataset.prev = selectEl.value;
}

/**
 * Populate the input-number <select> with stereo pairs: "1-2", "3-4", …
 * The value is the 0-based index of the LEFT (odd) channel.
 */
function populateStereoInputNumberSelect(
  selectEl: HTMLSelectElement,
  source: number,
  currentValue?: number | null
): void {
  const max = maxSourceChannel(source);
  const pairs = Math.floor(max / 2);
  selectEl.innerHTML = "";
  for (let p = 0; p < pairs; p++) {
    const leftIdx = p * 2;
    const opt = document.createElement("option");
    opt.value = String(leftIdx);
    opt.textContent = `${leftIdx + 1}-${leftIdx + 2}`;
    selectEl.appendChild(opt);
  }
  // Round current value down to nearest even (left side of pair)
  const rounded = currentValue != null
    ? currentValue - (currentValue % 2)
    : (Number(selectEl.dataset.prev) || 0);
  if (rounded >= 0 && rounded / 2 < pairs) {
    selectEl.value = String(rounded);
  }
  selectEl.dataset.prev = selectEl.value;
}

let editInputsBuilt = false;
/**
 * Once the initial state burst is complete, the Input Patching table becomes
 * a frozen snapshot: console routing changes no longer touch it, but the
 * source/input selectors stay active so the user can still re-patch.
 */
let editInputsFrozen = false;

/**
 * Two editable INPUT PATCHING lists (A/B presets). Each slot holds a
 * serialized snapshot of the edit table: { inputs, stereoPairs }.
 * null = slot not used yet (seeded from the current list on first visit).
 */
let editSets: { A: SavedSet | null; B: SavedSet | null } = { A: null, B: null };
/** Currently displayed edit list: "A" or "B". */
let activeEditSet: "A" | "B" = "A";
/**
 * Which edit list ("A"/"B") was last uploaded to the console, or null.
 * Shown on the Active Patching title until the next upload or reconnect.
 */
let lastUploadedSet: "A" | "B" | null = null;

/** Read the on-screen edit table back into a serializable list snapshot. */
function captureEditSet(): SavedSet {
  return { inputs: readEditInputs(), stereoPairs: readEditStereoPairs() };
}

/** Reflect the active list on the A/B buttons and the panel title. */
function updateAbButtons(): void {
  elementRefs.abBtn.classList.toggle("active", activeEditSet === "A");
  elementRefs.bBtn.classList.toggle("active", activeEditSet === "B");
  elementRefs.inputPatchingTitle.innerHTML =
    `Input Patching · <span class="list-letter list-${activeEditSet.toLowerCase()}">${activeEditSet}</span>`;
}

/** Mark the Active Patching title with the list uploaded last, if any. */
function updateActivePatchingTitle(): void {
  elementRefs.activePatchingTitle.innerHTML = lastUploadedSet
    ? `Active Patching · <span class="list-letter list-${lastUploadedSet.toLowerCase()}">${lastUploadedSet}</span>`
    : "Active Patching";
}

/**
 * A fresh list snapshot seeded from the console's live routing, so an
 * untouched slot mirrors what the desk currently plays. Falls back to a copy
 * of the currently displayed list when the console has no routing to draw from.
 */
function seedSetFromConsole(): SavedSet {
  if (state.activeInputs.length) {
    return {
      inputs: state.activeInputs.map((p) => ({
        destB3: p.destB3,
        destLabel: p.destLabel,
        name: p.name,
        source: p.source,
        sourceChannel: p.sourceChannel,
      })),
      stereoPairs: state.stereoPairs.map((p) => [p[0], p[1]]),
    };
  }
  // No routing on the desk yet — mirror the currently displayed list if it
  // exists, otherwise start from an empty set.
  const fallback = editSets[activeEditSet];
  return fallback ? JSON.parse(JSON.stringify(fallback)) : { inputs: [], stereoPairs: [] };
}

/**
 * Switch the displayed INPUT PATCHING list. The current on-screen state is
 * preserved into its slot; the target slot is seeded from the current list
 * on its first visit so the user starts from a copy they can diverge from.
 */
function switchEditSet(target: "A" | "B"): void {
  if (target === activeEditSet) return;
  editSets[activeEditSet] = captureEditSet();
  if (!editSets[target]) {
    // Seed an untouched list from the console's live routing, not from the
    // currently displayed list — loading a saved routing into A must not
    // leak into B.
    editSets[target] = seedSetFromConsole();
  }
  activeEditSet = target;
  updateAbButtons();
  const targetSet = editSets[target]!;
  buildEditInputs(targetSet.inputs || [], targetSet.stereoPairs || []);
}

/** Whether an input row for a given channel carries a checked "send" flag. */
function checkedForInputs(inputs: PatchInput[], b3: number): boolean {
  for (const inp of inputs) {
    if (inp.destB3 === b3 && (inp as EditRow).checked) return true;
  }
  return false;
}

/**
 * Pre-select rows of a freshly loaded routing that differ from the console's
 * current routing, so Upload has something to send right away.
 */
function markDifferingChecked(set: SavedSet): void {
  const active = new Map(
    state.activeInputs.map((p) => [p.destB3, { source: p.source, sourceChannel: p.sourceChannel }])
  );
  for (const r of set.inputs) {
    const a = active.get(r.destB3);
    r.checked = !!a && (a.source !== r.source || a.sourceChannel !== r.sourceChannel);
  }
}

/** Sync the header "select all" checkbox with the row checkboxes. */
function updateSelectAllCheckbox(): void {
  const rows = elementRefs.editInputTbody.querySelectorAll<HTMLInputElement>(".patch-send-chk");
  let checked = 0;
  for (const chk of rows) if (chk.checked) checked++;
  elementRefs.editSelAll.checked = rows.length > 0 && checked === rows.length;
  elementRefs.editSelAll.indeterminate = checked > 0 && checked < rows.length;
}

/** Build the full editable input-patching table from a snapshot. */
function buildEditInputs(inputs: PatchInput[], pairs: number[][]): void {
  const merged = mergeStereoInputs(inputs, pairs || []);
  elementRefs.editInputTbody.innerHTML = "";
  if (!merged.length) {
    elementRefs.editInEmpty.hidden = false;
    editInputsBuilt = false;
    return;
  }
  elementRefs.editInEmpty.hidden = true;
  const frag = document.createDocumentFragment();
  for (const r of merged) {
    const tr = document.createElement("tr");
    tr.dataset.b3 = String(r.destB3);
    if (r._stereo) {
      tr.dataset.stereo = "1";
      const p = stereoPairForLeft(r.destB3, pairs || []);
      tr.dataset.b3r = String(p ? p[1] : -1);
    }

    const sendTd = document.createElement("td");
    sendTd.className = "send-col";
    const chk = document.createElement("input");
    chk.type = "checkbox";
    chk.className = "patch-send-chk";
    chk.title = "Отметить канал для отправки на пульт";
    chk.addEventListener("change", updateSelectAllCheckbox);
    sendTd.appendChild(chk);
    tr.appendChild(sendTd);

    const chTd = document.createElement("td");
    chTd.className = "ch-cell";
    chTd.textContent = r.destLabel;
    tr.appendChild(chTd);

    const nameTd = document.createElement("td");
    nameTd.className = "name-cell edit-name";
    nameTd.textContent = r.name || "—";
    tr.appendChild(nameTd);

    const srcTd = document.createElement("td");
    const srcSel = document.createElement("select");
    srcSel.className = "patch-select source-sel";
    for (const s of INPUT_SOURCES) {
      const opt = document.createElement("option");
      opt.value = String(s.value);
      opt.textContent = s.label;
      srcSel.appendChild(opt);
    }
    srcSel.value = String(r.source);
    srcTd.appendChild(srcSel);
    tr.appendChild(srcTd);

    const inTd = document.createElement("td");
    const inSel = document.createElement("select");
    inSel.className = "patch-select input-sel";
    if (r._stereo) {
      populateStereoInputNumberSelect(inSel, r.source, r.sourceChannel);
    } else {
      populateInputNumberSelect(inSel, r.source, r.sourceChannel);
    }
    inTd.appendChild(inSel);
    tr.appendChild(inTd);

    const isStereo = !!r._stereo;

    // The Input Patching list is a frozen startup snapshot — changing the
    // selectors updates only the local display and never touches the console.
    const repopulateInSel = (): void => {
      const source = Number(srcSel.value);
      const prev = Number(inSel.dataset.prev || "0");
      if (isStereo) {
        populateStereoInputNumberSelect(inSel, source, prev);
      } else {
        populateInputNumberSelect(inSel, source, Math.min(prev, maxSourceChannel(source) - 1));
      }
    };

    srcSel.addEventListener("change", () => {
      repopulateInSel();
      chk.checked = true;
      updateSelectAllCheckbox();
      updateTransferButtons();
    });
    inSel.addEventListener("change", () => {
      inSel.dataset.prev = inSel.value;
      chk.checked = true;
      updateSelectAllCheckbox();
      updateTransferButtons();
    });

    // Restore the saved selection (unchecked when the row carries no flag).
    chk.checked = checkedForInputs(inputs, r.destB3);

    frag.appendChild(tr);
  }
  elementRefs.editInputTbody.appendChild(frag);
  editInputsBuilt = true;
  updateSelectAllCheckbox();
  updateTransferButtons();
}

/**
 * Sync selector values from a routing update without rebuilding the table,
 * so any in-progress user edit (focused select) is preserved.
 * No-op once the table is frozen after the initial state burst.
 */
export function syncEditInputs(inputs: SnapshotInput[], pairs: number[][]): void {
  if (editInputsFrozen) return;
  if (!editInputsBuilt) {
    buildEditInputs(inputs, pairs);
    return;
  }
  const merged = mergeStereoInputs(inputs, pairs || []);
  for (const r of merged) {
    const tr = elementRefs.editInputTbody.querySelector(`tr[data-b3="${r.destB3}"]`);
    if (!tr) continue;
    const nameEl = tr.querySelector(".edit-name");
    if (nameEl) nameEl.textContent = r.name || "—";
    const srcSel = tr.querySelector<HTMLSelectElement>(".source-sel");
    const inSel = tr.querySelector<HTMLSelectElement>(".input-sel");
    // Skip rows the user is actively editing.
    if (document.activeElement === srcSel || document.activeElement === inSel) continue;
    if (srcSel) srcSel.value = String(r.source);
    if (inSel) {
      if (r._stereo) {
        populateStereoInputNumberSelect(inSel, r.source, r.sourceChannel);
      } else {
        populateInputNumberSelect(inSel, r.source, r.sourceChannel);
      }
    }
  }
  updateTransferButtons();
}

// ── transfer button enable/disable ────────────────────────────────────

/**
 * Build a comparable map from the current Input Patching table selectors:
 * destB3 → { source, sourceChannel } (stereo rows cover both channels).
 */
function readEditTable(): Map<number, { source: number; sourceChannel: number }> {
  const map = new Map<number, { source: number; sourceChannel: number }>();
  for (const tr of elementRefs.editInputTbody.querySelectorAll<HTMLTableRowElement>("tr[data-b3]")) {
    const destB3 = Number(tr.dataset.b3);
    const srcSel = tr.querySelector<HTMLSelectElement>(".source-sel");
    const inSel = tr.querySelector<HTMLSelectElement>(".input-sel");
    if (!srcSel || !inSel) continue;
    const source = Number(srcSel.value);
    const sourceChannel = Number(inSel.value);
    map.set(destB3, { source, sourceChannel });
    const b3r = tr.dataset.b3r ? Number(tr.dataset.b3r) : -1;
    if (b3r >= 0) {
      map.set(b3r, { source, sourceChannel: sourceChannel + 1 });
    }
  }
  return map;
}

/** Whether the Input Patching table equals the console's Active Patching. */
function listsEqual(): boolean {
  const edit = readEditTable();
  const active = new Map(
    state.activeInputs.map((p) => [p.destB3, { source: p.source, sourceChannel: p.sourceChannel }])
  );
  if (edit.size !== active.size) return false;
  for (const [b3, a] of active) {
    const e = edit.get(b3);
    if (!e) return false;
    if (e.source !== a.source || e.sourceChannel !== a.sourceChannel) return false;
  }
  return true;
}

/** Read the stereo pairs currently shown in the Input Patching table. */
function readEditStereoPairs(): number[][] {
  const pairs: number[][] = [];
  for (const tr of elementRefs.editInputTbody.querySelectorAll<HTMLTableRowElement>('tr[data-stereo="1"]')) {
    const l = Number(tr.dataset.b3);
    const r = Number(tr.dataset.b3r);
    if (r >= 0) pairs.push([l, r]);
  }
  return pairs;
}

/** Disable Upload/Download when both routing lists match, enable otherwise. */
function updateTransferButtons(): void {
  const equal = listsEqual();
  // Upload must not run when the stereo/mono layout of the editable table
  // differs from the console's current stereo pairs — patching would be wrong.
  const stereoDiffers =
    stereoConfigKey(readEditStereoPairs()) !== stereoConfigKey(state.stereoPairs);
  if (elementRefs.uploadBtn) elementRefs.uploadBtn.disabled = equal || stereoDiffers;
  if (elementRefs.downloadBtn) elementRefs.downloadBtn.disabled = equal;
  updateTransferTooltips(equal, stereoDiffers);
  updateSwapButton();
  // Red-highlight the Input Patching title and add a hover tooltip while the
  // editable table's stereo layout differs from the console's.
  if (elementRefs.inputPatchingTitle) {
    if (stereoDiffers) {
      elementRefs.inputPatchingTitle.classList.add("stereo-diff");
      elementRefs.inputPatchingTitle.dataset.tooltip =
        "Конфигурации стерео-каналов различаются";
    } else {
      elementRefs.inputPatchingTitle.classList.remove("stereo-diff");
      delete elementRefs.inputPatchingTitle.dataset.tooltip;
    }
  }
}

/** Canonical routing-identity string for a saved edit list. */
function routingKey(set: SavedSet): string {
  const map = new Map<number, string>();
  for (const r of set.inputs) {
    const prev = map.get(r.destB3);
    map.set(r.destB3, prev ? `${prev};${r.source}:${r.sourceChannel}` : `${r.source}:${r.sourceChannel}`);
  }
  const entries = [...map.entries()].sort((x, y) => x[0] - y[0]);
  return JSON.stringify([entries, set.stereoPairs]);
}

/**
 * Whether the two editable lists currently differ (routing-wise). The current
 * on-screen table is collapsed into its slot first so the comparison (and the
 * swap button) reflects live edits. Slots are only ever seeded at well-defined
 * points (connection/freeze, switching, loading) — never from inside this
 * read-style check, which would lock partial mid-burst data into a slot.
 */
function abListsDiffer(): boolean {
  editSets[activeEditSet] = captureEditSet();
  const a = editSets.A;
  const b = editSets.B;
  if (!a || !b) return false;
  return routingKey(a) !== routingKey(b);
}

/** Enable the A/B swap button only while the two lists differ. */
function updateSwapButton(): void {
  const differ = abListsDiffer();
  elementRefs.abSwapBtn.disabled = !differ;
  elementRefs.abSwapBtn.dataset.tooltip = differ
    ? "Быстрая смена роутинга"
    : "Списки A и B одинаковые";
}

/**
 * Swap the live routing without touching the displayed A/B list:
 * - if a list was uploaded before, push the opposite one onto the console;
 * - if neither list has been uploaded yet, push the currently selected list.
 * Blocked when the target list's stereo layout differs from the console's —
 * same guard as Upload.
 */
async function swapRouting(): Promise<void> {
  // Fold the on-screen table into its slot first so the sent list is fresh.
  editSets[activeEditSet] = captureEditSet();
  const live: "A" | "B" | null = lastUploadedSet;
  const target: "A" | "B" = live ? (live === "A" ? "B" : "A") : activeEditSet;
  const set = editSets[target];
  if (!set) return;
  if (stereoConfigKey(set.stereoPairs) !== stereoConfigKey(state.stereoPairs)) {
    showSaveFeedback("Разная конфигурация каналов", "");
    return;
  }
  elementRefs.uploadBtn.disabled = true;
  try {
    await sendPatchesToConsole(set.inputs);
    showSaveFeedback("Отправлено", "✓ ");
    lastUploadedSet = target;
    updateActivePatchingTitle();
    flashActivePatching(target);
  } catch (err) {
    showSaveFeedback(`Swap: ошибка — ${(err && (err as Error).message) || String(err)}`, "");
  } finally {
    elementRefs.uploadBtn.disabled = false;
    updateTransferButtons();
  }
}

/**
 * Send a flat patch list (stereo right channels already expanded) to the
 * console, one setInputPatch call per channel.
 */
async function sendPatchesToConsole(
  inputs: ReadonlyArray<{ destB3: number; source: number; sourceChannel: number }>
): Promise<void> {
  for (const p of inputs) {
    await window.sq.setInputPatch(p.destB3, p.source, p.sourceChannel);
  }
}

/** Explain why the transfer buttons are disabled via their tooltips. */
function updateTransferTooltips(equal: boolean, stereoDiffers: boolean): void {
  if (elementRefs.downloadBtn) {
    elementRefs.downloadBtn.dataset.tooltip = equal
      ? "Уже загружено"
      : "Download — перенести с пульта";
  }
  if (elementRefs.uploadBtn) {
    elementRefs.uploadBtn.dataset.tooltip = stereoDiffers
      ? "Разная конфигурация каналов"
      : equal
        ? "Уже загружено"
        : "Upload — перенести на пульт";
  }
}

// ── save-routing ─────────────────────────────────────────────────────

const SAVED_ROUTING_KEY = "sq_saved_routing";
let saveFeedbackTimer: ReturnType<typeof setTimeout> | null = null;

/** Default save name: "гггг.мм.дд {scene}" (scene omitted if unknown). */
function defaultSaveName(): string {
  return state.currentSceneName ? `${todayStr()} ${state.currentSceneName}` : todayStr();
}

function getSavedRouting(): SavedRoutingEntry[] {
  try {
    return JSON.parse(localStorage.getItem(SAVED_ROUTING_KEY) || "[]");
  } catch {
    return [];
  }
}

function addSavedRouting(entry: SavedRoutingEntry): void {
  const list = getSavedRouting();
  list.unshift(entry);
  localStorage.setItem(SAVED_ROUTING_KEY, JSON.stringify(list.slice(0, 100)));
}

function openSaveModal(): void {
  elementRefs.saveNameInput.value = defaultSaveName();
  elementRefs.saveModal.hidden = false;
  // Pre-select the prefilled text so the user can quickly overwrite or keep it.
  elementRefs.saveNameInput.focus();
  elementRefs.saveNameInput.select();
}

function closeSaveModal(): void {
  elementRefs.saveModal.hidden = true;
}

function showSaveFeedback(text: string, prefix = "✓ Сохранено: "): void {
  if (saveFeedbackTimer) clearTimeout(saveFeedbackTimer);
  elementRefs.saveFeedback.textContent = prefix + text;
  elementRefs.saveFeedback.classList.add("show");
  saveFeedbackTimer = setTimeout(() => {
    elementRefs.saveFeedback.classList.remove("show");
    saveFeedbackTimer = null;
  }, 3500);
}

async function confirmSaveRouting(): Promise<void> {
  const name = elementRefs.saveNameInput.value.trim();
  if (!name) {
    elementRefs.saveNameInput.focus();
    return;
  }
  let snapshot: SnapshotPayload | null = null;
  try {
    snapshot = await window.sq.getSnapshot();
  } catch {
    snapshot = null;
  }
  const pairs = readEditStereoPairs();
  addSavedRouting({
    name,
    savedAt: new Date().toISOString(),
    model: elementRefs.topbarTitle.textContent || undefined,
    inputs: readEditInputs(),
    // The saved routing carries the active list's own stereo layout; fall back
    // to the console config when the table is empty.
    stereoPairs: pairs.length ? pairs : (snapshot ? snapshot.stereoPairs : []),
  });
  closeSaveModal();
  showSaveFeedback("Сохранено", "");
}

/**
 * Read the current INPUT PATCHING table (selectors) back into an inputs array.
 * Stereo rows are expanded into left + right channel patches. When
 * `onlySelected` is true, rows whose checkbox is not checked are skipped.
 */
function readEditInputs(onlySelected = false): EditRow[] {
  const inputs: EditRow[] = [];
  for (const tr of elementRefs.editInputTbody.querySelectorAll<HTMLTableRowElement>("tr[data-b3]")) {
    const chk = tr.querySelector<HTMLInputElement>(".patch-send-chk");
    if (onlySelected && (!chk || !chk.checked)) continue;
    const destB3 = Number(tr.dataset.b3);
    const srcSel = tr.querySelector<HTMLSelectElement>(".source-sel");
    const inSel = tr.querySelector<HTMLSelectElement>(".input-sel");
    if (!srcSel || !inSel) continue;
    const source = Number(srcSel.value);
    const sourceChannel = Number(inSel.value);
    const nameEl = tr.querySelector(".edit-name");
    const name = nameEl && nameEl.textContent !== "—" ? nameEl.textContent : "";
    const b3r = tr.dataset.b3r ? Number(tr.dataset.b3r) : -1;
    const checked = chk ? chk.checked : false;
    // Store the base label ("Input 7") — stereo rows get merged at load time.
    inputs.push({
      destB3,
      destLabel: `Input ${destB3 + 1}`,
      name: name || "",
      source,
      sourceChannel,
      checked,
    });
    if (b3r >= 0) {
      inputs.push({
        destB3: b3r,
        destLabel: `Input ${b3r + 1}`,
        name: name || "",
        source,
        sourceChannel: sourceChannel + 1,
        checked,
      });
    }
  }
  return inputs;
}

// ── load-routing ─────────────────────────────────────────────────────

let selectedLoadIndex = -1;

function stereoConfigKey(pairs?: number[][] | null): string {
  const arr = Array.isArray(pairs) ? pairs.map((p) => [p[0], p[1]]) : [];
  arr.sort((a, b) => a[0] - b[0] || a[1] - b[1]);
  return JSON.stringify(arr);
}

function configDiffers(entry: SavedRoutingEntry): boolean {
  const currentModel = (state.modelSpec && state.modelSpec.name) || elementRefs.topbarTitle.textContent || "";
  const modelDiffers = Boolean(entry.model) && Boolean(currentModel) && entry.model !== currentModel;
  const stereoDiffers = stereoConfigKey(entry.stereoPairs) !== stereoConfigKey(state.stereoPairs);
  return modelDiffers || stereoDiffers;
}

function formatSavedDate(iso: string): string {
  try {
    const d = new Date(iso);
    if (isNaN(d.getTime())) return "";
    const p = (n: number): string => String(n).padStart(2, "0");
    return `${p(d.getDate())}.${p(d.getMonth() + 1)}.${d.getFullYear()} ${p(d.getHours())}:${p(d.getMinutes())}`;
  } catch {
    return "";
  }
}

function removeSavedRouting(index: number): void {
  const list = getSavedRouting();
  if (index < 0 || index >= list.length) return;
  list.splice(index, 1);
  localStorage.setItem(SAVED_ROUTING_KEY, JSON.stringify(list));
}

function renderLoadList(): void {
  const list = getSavedRouting();
  elementRefs.loadList.innerHTML = "";
  if (!list.length) {
    elementRefs.loadEmpty.hidden = false;
    selectedLoadIndex = -1;
    updateLoadConfirmState();
    return;
  }
  elementRefs.loadEmpty.hidden = true;
  const frag = document.createDocumentFragment();
  list.forEach((entry, i) => {
    const row = document.createElement("div");
    row.className = "load-row";
    if (i === selectedLoadIndex) row.classList.add("selected");
    row.dataset.index = String(i);

    const main = document.createElement("div");
    main.className = "load-row-main";
    const nameEl = document.createElement("span");
    nameEl.className = "load-row-name";
    nameEl.textContent = entry.name || "(без названия)";
    main.appendChild(nameEl);
    const meta = document.createElement("span");
    meta.className = "load-row-meta";
    const parts: string[] = [];
    if (entry.savedAt) parts.push(formatSavedDate(entry.savedAt));
    if (entry.model) parts.push(entry.model);
    meta.textContent = parts.join(" · ");
    if (configDiffers(entry)) {
      const diff = document.createElement("span");
      diff.className = "load-row-diff";
      diff.textContent = " · Отличие конфигураций";
      meta.appendChild(diff);
    }
    main.appendChild(meta);
    row.appendChild(main);

    const del = document.createElement("button");
    del.type = "button";
    del.className = "load-row-del";
    del.title = "Удалить";
    del.textContent = "×";
    del.addEventListener("click", (ev: MouseEvent) => {
      ev.stopPropagation();
      removeSavedRouting(i);
      if (selectedLoadIndex === i) selectedLoadIndex = -1;
      else if (selectedLoadIndex > i) selectedLoadIndex--;
      renderLoadList();
    });
    row.appendChild(del);

    row.addEventListener("click", () => selectLoadRow(i));
    row.addEventListener("dblclick", () => {
      selectLoadRow(i);
      confirmLoadRouting();
    });
    frag.appendChild(row);
  });
  elementRefs.loadList.appendChild(frag);
  updateLoadConfirmState();
}

/**
 * Update the "Загрузить" button and the ignore-config checkbox based on the
 * currently selected entry. The checkbox is only shown when the selected
 * entry differs in configuration; checking it re-enables the button.
 */
function updateLoadConfirmState(): void {
  const list = getSavedRouting();
  const entry = selectedLoadIndex >= 0 ? list[selectedLoadIndex] : null;
  if (!entry) {
    elementRefs.loadIgnoreConfig.hidden = true;
    elementRefs.loadIgnoreConfigInput.checked = false;
    elementRefs.loadConfirmBtn.disabled = true;
    return;
  }
  const differs = configDiffers(entry);
  elementRefs.loadIgnoreConfig.hidden = !differs;
  if (!differs) elementRefs.loadIgnoreConfigInput.checked = false;
  elementRefs.loadConfirmBtn.disabled = differs && !elementRefs.loadIgnoreConfigInput.checked;
}

function selectLoadRow(i: number): void {
  selectedLoadIndex = i;
  for (const row of elementRefs.loadList.querySelectorAll<HTMLElement>(".load-row")) {
    row.classList.toggle("selected", Number(row.dataset.index) === i);
  }
  updateLoadConfirmState();
}

function openLoadModal(): void {
  selectedLoadIndex = -1;
  renderLoadList();
  elementRefs.loadModal.hidden = false;
}

function closeLoadModal(): void {
  elementRefs.loadModal.hidden = true;
}

async function confirmLoadRouting(): Promise<void> {
  const list = getSavedRouting();
  const entry = list[selectedLoadIndex];
  // Block direct invocation (e.g. dblclick) unless compatible or the
  // ignore-config checkbox is checked.
  if (!entry || (configDiffers(entry) && !elementRefs.loadIgnoreConfigInput.checked)) return;
  elementRefs.loadConfirmBtn.disabled = true;
  try {
    // Load the saved patch list into the currently active INPUT PATCHING list
    // only — nothing is sent to the console. The user can then apply it via
    // Upload. The list keeps the saved entry's own stereo layout.
    const set: SavedSet = {
      inputs: (entry.inputs || []).map((r) => ({ ...r })),
      stereoPairs: (entry.stereoPairs || []).map((p) => [p[0], p[1]]),
    };
    markDifferingChecked(set);
    editSets[activeEditSet] = set;
    // Ensure the sibling slot exists so the swap button can activate — an
    // untouched side is seeded from the console's routing.
    const other: "A" | "B" = activeEditSet === "A" ? "B" : "A";
    if (!editSets[other]) editSets[other] = seedSetFromConsole();
    buildEditInputs(set.inputs, set.stereoPairs);
    closeLoadModal();
    showSaveFeedback("Обновлено", "");
    updateTransferButtons();
  } catch (err) {
    showSaveFeedback(`Ошибка: ${(err && (err as Error).message) || String(err)}`);
  }
}

// ── Upload / Download ────────────────────────────────────────────────

/** Make the "Active Patching" title blink once in the applied list's color. */
function flashActivePatching(list?: "A" | "B"): void {
  flashTitle(elementRefs.activePatchingTitle, list === "A" ? "flash-a" : "flash-b");
}

/** Make the "Input Patching" title blink green once. */
function flashInputPatching(): void {
  flashTitle(elementRefs.inputPatchingTitle);
}

/**
 * Read the current source/input selectors from the Input Patching table and
 * send each patch to the console. Stereo rows patch both channels (L → N,
 * R → N+1).
 */
async function uploadInputPatching(): Promise<void> {
  const inputs = readEditInputs(true);
  if (!inputs.length) {
    showSaveFeedback("Не выбран ни один канал", "");
    return;
  }
  elementRefs.uploadBtn.disabled = true;
  try {
    await sendPatchesToConsole(inputs);
    showSaveFeedback("Отправлено", "✓ ");
    // The console now reflects the list that was uploaded — mark Active
    // Patching with that list's letter.
    lastUploadedSet = activeEditSet;
    updateActivePatchingTitle();
    flashActivePatching();
  } catch (err) {
    showSaveFeedback(`Upload: ошибка — ${(err && (err as Error).message) || String(err)}`, "");
  } finally {
    elementRefs.uploadBtn.disabled = false;
    updateTransferButtons();
  }
}

/**
 * Pull the current routing from the console and rebuild the Input Patching
 * table to match the Active Patching list.
 */
async function downloadInputPatching(): Promise<void> {
  elementRefs.downloadBtn.disabled = true;
  try {
    const snapshot = await window.sq.getSnapshot();
    buildEditInputs(snapshot.inputs, snapshot.stereoPairs || []);
    // Download replaces the currently active INPUT PATCHING list.
    editSets[activeEditSet] = captureEditSet();
    showSaveFeedback("Загружено", "✓ ");
    flashInputPatching();
  } catch (err) {
    showSaveFeedback(`Download: ошибка — ${(err && (err as Error).message) || String(err)}`, "");
  } finally {
    elementRefs.downloadBtn.disabled = false;
    updateTransferButtons();
  }
}

// ── sync scroll between the two routing lists ─────────────────────────

let syncScrollEnabled = false;
let syncingScroll = false;

/**
 * Mirror one list's scrollTop onto the other. Guarded so a programmatic
 * scroll event doesn't bounce back and forth forever.
 */
function mirrorScroll(srcWrap: HTMLElement, dstWrap: HTMLElement): void {
  if (!syncScrollEnabled || syncingScroll) return;
  syncingScroll = true;
  dstWrap.scrollTop = srcWrap.scrollTop;
  // Release the guard on the next tick so the echoed scroll event is ignored.
  requestAnimationFrame(() => {
    syncingScroll = false;
  });
}

// ── snapshot handling ────────────────────────────────────────────────

/**
 * Apply a routing snapshot to the tab: update stereo pairs first (rebuilding
 * the monitor channel grid if they changed), then both tables.
 */
export function onRoutingSnapshot(snapshot: SnapshotPayload): void {
  // Update stereo pairs FIRST so table merging uses fresh data.
  const pairsKey = JSON.stringify(snapshot.stereoPairs || []);
  if (pairsKey !== JSON.stringify(state.stereoPairs)) {
    state.stereoPairs = snapshot.stereoPairs || [];
    buildChannelButtons();
    if (!editInputsFrozen) editInputsBuilt = false; // force rebuild of editable table
  }
  renderInputs(snapshot.inputs);
  // After the initial burst the Input Patching table is frozen — later console
  // routing changes must not alter it (selectors stay active for editing).
  syncEditInputs(snapshot.inputs, snapshot.stereoPairs);
}

/**
 * Freeze the Input Patching snapshot after the initial state burst. Both A
 * and B are loaded from the console's full routing right on connection, so
 * neither slot is empty and the swap button is immediately meaningful. Slots
 * that were collapsed to an empty state mid-burst (before the console data
 * had fully streamed in) are replaced with the real routing here.
 */
export function freezeEditTable(): void {
  editInputsFrozen = true;
  if (!state.activeInputs.length) return;
  if (!editSets.A || editSets.A.inputs.length === 0) editSets.A = seedSetFromConsole();
  if (!editSets.B || editSets.B.inputs.length === 0) editSets.B = seedSetFromConsole();
}

/** Reset the tab state for a fresh dashboard session. */
export function reset(): void {
  editInputsBuilt = false;
  editInputsFrozen = false;
  editSets = { A: null, B: null };
  activeEditSet = "A";
  updateAbButtons();
  lastUploadedSet = null;
  updateActivePatchingTitle();
  state.activeInputs = [];
  elementRefs.editInputTbody.innerHTML = "";
  elementRefs.editSelAll.checked = false;
  elementRefs.editSelAll.indeterminate = false;
  if (elementRefs.uploadBtn) elementRefs.uploadBtn.disabled = false;
  if (elementRefs.downloadBtn) elementRefs.downloadBtn.disabled = false;
  updateSwapButton();
}

// ── bindings ─────────────────────────────────────────────────────────

// save-routing modal
elementRefs.saveRoutingBtn.addEventListener("click", openSaveModal);
elementRefs.saveConfirmBtn.addEventListener("click", confirmSaveRouting);
elementRefs.saveCancelBtn.addEventListener("click", closeSaveModal);
elementRefs.saveNameInput.addEventListener("keydown", (e: KeyboardEvent) => {
  if (e.key === "Enter") {
    e.preventDefault();
    confirmSaveRouting();
  }
});
// Click on the overlay backdrop (outside the card) closes the modal.
elementRefs.saveModal.addEventListener("click", (e: MouseEvent) => {
  if (e.target === elementRefs.saveModal) closeSaveModal();
});
// Esc closes the modal (separate from the monitor-view Esc handler).
window.addEventListener("keydown", (e: KeyboardEvent) => {
  if (!elementRefs.saveModal.hidden && e.key === "Escape") {
    e.preventDefault();
    closeSaveModal();
  }
});

// load-routing modal
elementRefs.loadRoutingBtn.addEventListener("click", openLoadModal);
elementRefs.loadConfirmBtn.addEventListener("click", confirmLoadRouting);
elementRefs.loadCancelBtn.addEventListener("click", closeLoadModal);
elementRefs.loadIgnoreConfigInput.addEventListener("change", updateLoadConfirmState);
elementRefs.loadModal.addEventListener("click", (e: MouseEvent) => {
  if (e.target === elementRefs.loadModal) closeLoadModal();
});
window.addEventListener("keydown", (e: KeyboardEvent) => {
  if (!elementRefs.loadModal.hidden && e.key === "Escape") {
    e.preventDefault();
    closeLoadModal();
  }
});

// Upload / Download / A/B / sync scroll
elementRefs.uploadBtn.addEventListener("click", uploadInputPatching);
elementRefs.downloadBtn.addEventListener("click", downloadInputPatching);
elementRefs.abBtn.addEventListener("click", () => switchEditSet("A"));
elementRefs.bBtn.addEventListener("click", () => switchEditSet("B"));
elementRefs.abSwapBtn.addEventListener("click", swapRouting);
// Header "select all" checkbox of the Input Patching table.
elementRefs.editSelAll.addEventListener("change", () => {
  const checked = elementRefs.editSelAll.checked;
  for (const chk of elementRefs.editInputTbody.querySelectorAll<HTMLInputElement>(".patch-send-chk")) {
    chk.checked = checked;
  }
});
elementRefs.syncScrollBtn.addEventListener("click", () => {
  syncScrollEnabled = !syncScrollEnabled;
  elementRefs.syncScrollBtn.classList.toggle("active", syncScrollEnabled);
  elementRefs.syncScrollBtn.setAttribute("aria-pressed", String(syncScrollEnabled));
  if (syncScrollEnabled) {
    // Align both lists immediately on enable.
    mirrorScroll(elementRefs.editTableWrap, elementRefs.activeTableWrap);
  }
});
elementRefs.editTableWrap.addEventListener("scroll", () =>
  mirrorScroll(elementRefs.editTableWrap, elementRefs.activeTableWrap)
);
elementRefs.activeTableWrap.addEventListener("scroll", () =>
  mirrorScroll(elementRefs.activeTableWrap, elementRefs.editTableWrap)
);
