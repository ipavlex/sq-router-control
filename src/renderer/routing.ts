/**
 * SQ Router Control — Routing tab.
 * Active Patching, editable Input Patching (A/B presets), Upload/Download,
 * sync scroll, and the save/load routing modals.
 */
import { els, state, escapeHtml, flashTitle, todayStr } from "./utils";
import { buildChannelButtons } from "./monitor";
import type { SnapshotInput, SnapshotPayload } from "../shared/ipc";

// ── stereo merge helpers ─────────────────────────────────────────────

interface EditRow {
  destB3: number;
  destLabel: string;
  name: string;
  source: number;
  sourceChannel: number;
}

/** Anything mergeStereoInputs can consume: live snapshots or edit-table rows. */
type PatchInput = SnapshotInput | EditRow;

interface MergedInput extends SnapshotInput {
  _stereo?: boolean;
  _rightSourceChannel?: number;
}

/** Set of b3 values that are the RIGHT side of a stereo pair (to be skipped). */
function stereoRightSet(pairs: number[][]): Set<number> {
  const s = new Set<number>();
  for (const [l, r] of pairs) s.add(r);
  return s;
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
  els.inputTbody.innerHTML = "";
  if (!merged.length) {
    els.inEmpty.hidden = false;
    return;
  }
  els.inEmpty.hidden = true;
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
  els.inputTbody.appendChild(frag);
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

interface EditRow {
  destB3: number;
  destLabel: string;
  name: string;
  source: number;
  sourceChannel: number;
}

interface SavedSet {
  inputs: EditRow[];
  stereoPairs: number[][];
}

interface SavedRoutingEntry extends SavedSet {
  name: string;
  savedAt: string;
  model?: string;
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
  els.abBtn.classList.toggle("active", activeEditSet === "A");
  els.bBtn.classList.toggle("active", activeEditSet === "B");
  els.inputPatchingTitle.innerHTML =
    `Input Patching · <span class="list-letter list-${activeEditSet.toLowerCase()}">${activeEditSet}</span>`;
}

/** Mark the Active Patching title with the list uploaded last, if any. */
function updateActivePatchingTitle(): void {
  els.activePatchingTitle.innerHTML = lastUploadedSet
    ? `Active Patching · <span class="list-letter list-${lastUploadedSet.toLowerCase()}">${lastUploadedSet}</span>`
    : "Active Patching";
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
    editSets[target] = JSON.parse(JSON.stringify(editSets[activeEditSet]));
  }
  activeEditSet = target;
  updateAbButtons();
  const targetSet = editSets[target]!;
  buildEditInputs(targetSet.inputs || [], targetSet.stereoPairs || []);
}

/** Build the full editable input-patching table from a snapshot. */
function buildEditInputs(inputs: PatchInput[], pairs: number[][]): void {
  const merged = mergeStereoInputs(inputs, pairs || []);
  els.editInputTbody.innerHTML = "";
  if (!merged.length) {
    els.editInEmpty.hidden = false;
    editInputsBuilt = false;
    return;
  }
  els.editInEmpty.hidden = true;
  const frag = document.createDocumentFragment();
  for (const r of merged) {
    const tr = document.createElement("tr");
    tr.dataset.b3 = String(r.destB3);
    if (r._stereo) {
      tr.dataset.stereo = "1";
      const p = stereoPairForLeft(r.destB3, pairs || []);
      tr.dataset.b3r = String(p ? p[1] : -1);
    }

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
      updateTransferButtons();
    });
    inSel.addEventListener("change", () => {
      inSel.dataset.prev = inSel.value;
      updateTransferButtons();
    });

    frag.appendChild(tr);
  }
  els.editInputTbody.appendChild(frag);
  editInputsBuilt = true;
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
    const tr = els.editInputTbody.querySelector(`tr[data-b3="${r.destB3}"]`);
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
  for (const tr of els.editInputTbody.querySelectorAll<HTMLTableRowElement>("tr[data-b3]")) {
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
  for (const tr of els.editInputTbody.querySelectorAll<HTMLTableRowElement>('tr[data-stereo="1"]')) {
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
  if (els.uploadBtn) els.uploadBtn.disabled = equal || stereoDiffers;
  if (els.downloadBtn) els.downloadBtn.disabled = equal;
  updateTransferTooltips(equal, stereoDiffers);
  // Red-highlight the Input Patching title and add a hover tooltip while the
  // editable table's stereo layout differs from the console's.
  if (els.inputPatchingTitle) {
    if (stereoDiffers) {
      els.inputPatchingTitle.classList.add("stereo-diff");
      els.inputPatchingTitle.dataset.tooltip =
        "Конфигурации стерео-каналов различаются";
    } else {
      els.inputPatchingTitle.classList.remove("stereo-diff");
      delete els.inputPatchingTitle.dataset.tooltip;
    }
  }
}

/** Explain why the transfer buttons are disabled via their tooltips. */
function updateTransferTooltips(equal: boolean, stereoDiffers: boolean): void {
  if (els.downloadBtn) {
    els.downloadBtn.dataset.tooltip = equal
      ? "Уже загружено"
      : "Download — перенести с пульта";
  }
  if (els.uploadBtn) {
    els.uploadBtn.dataset.tooltip = stereoDiffers
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
  els.saveNameInput.value = defaultSaveName();
  els.saveModal.hidden = false;
  // Pre-select the prefilled text so the user can quickly overwrite or keep it.
  els.saveNameInput.focus();
  els.saveNameInput.select();
}

function closeSaveModal(): void {
  els.saveModal.hidden = true;
}

function showSaveFeedback(text: string, prefix = "✓ Сохранено: "): void {
  if (saveFeedbackTimer) clearTimeout(saveFeedbackTimer);
  els.saveFeedback.textContent = prefix + text;
  els.saveFeedback.classList.add("show");
  saveFeedbackTimer = setTimeout(() => {
    els.saveFeedback.classList.remove("show");
    saveFeedbackTimer = null;
  }, 3500);
}

async function confirmSaveRouting(): Promise<void> {
  const name = els.saveNameInput.value.trim();
  if (!name) {
    els.saveNameInput.focus();
    return;
  }
  let snap: SnapshotPayload | null = null;
  try {
    snap = await window.sq.getSnapshot();
  } catch {
    snap = null;
  }
  const pairs = readEditStereoPairs();
  addSavedRouting({
    name,
    savedAt: new Date().toISOString(),
    model: els.topbarTitle.textContent || undefined,
    inputs: readEditInputs(),
    // The saved routing carries the active list's own stereo layout; fall back
    // to the console config when the table is empty.
    stereoPairs: pairs.length ? pairs : (snap ? snap.stereoPairs : []),
  });
  closeSaveModal();
  showSaveFeedback("Сохранено", "");
}

/**
 * Read the current INPUT PATCHING table (selectors) back into an inputs array.
 * Stereo rows are expanded into left + right channel patches.
 */
function readEditInputs(): EditRow[] {
  const inputs: EditRow[] = [];
  for (const tr of els.editInputTbody.querySelectorAll<HTMLTableRowElement>("tr[data-b3]")) {
    const destB3 = Number(tr.dataset.b3);
    const srcSel = tr.querySelector<HTMLSelectElement>(".source-sel");
    const inSel = tr.querySelector<HTMLSelectElement>(".input-sel");
    if (!srcSel || !inSel) continue;
    const source = Number(srcSel.value);
    const sourceChannel = Number(inSel.value);
    const nameEl = tr.querySelector(".edit-name");
    const name = nameEl && nameEl.textContent !== "—" ? nameEl.textContent : "";
    const b3r = tr.dataset.b3r ? Number(tr.dataset.b3r) : -1;
    // Store the base label ("Input 7") — stereo rows get merged at load time.
    inputs.push({
      destB3,
      destLabel: `Input ${destB3 + 1}`,
      name: name || "",
      source,
      sourceChannel,
    });
    if (b3r >= 0) {
      inputs.push({
        destB3: b3r,
        destLabel: `Input ${b3r + 1}`,
        name: name || "",
        source,
        sourceChannel: sourceChannel + 1,
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
  const currentModel = (state.modelSpec && state.modelSpec.name) || els.topbarTitle.textContent || "";
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
  els.loadList.innerHTML = "";
  if (!list.length) {
    els.loadEmpty.hidden = false;
    selectedLoadIndex = -1;
    updateLoadConfirmState();
    return;
  }
  els.loadEmpty.hidden = true;
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
  els.loadList.appendChild(frag);
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
    els.loadIgnoreConfig.hidden = true;
    els.loadIgnoreConfigInput.checked = false;
    els.loadConfirmBtn.disabled = true;
    return;
  }
  const differs = configDiffers(entry);
  els.loadIgnoreConfig.hidden = !differs;
  if (!differs) els.loadIgnoreConfigInput.checked = false;
  els.loadConfirmBtn.disabled = differs && !els.loadIgnoreConfigInput.checked;
}

function selectLoadRow(i: number): void {
  selectedLoadIndex = i;
  for (const row of els.loadList.querySelectorAll<HTMLElement>(".load-row")) {
    row.classList.toggle("selected", Number(row.dataset.index) === i);
  }
  updateLoadConfirmState();
}

function openLoadModal(): void {
  selectedLoadIndex = -1;
  renderLoadList();
  els.loadModal.hidden = false;
}

function closeLoadModal(): void {
  els.loadModal.hidden = true;
}

async function confirmLoadRouting(): Promise<void> {
  const list = getSavedRouting();
  const entry = list[selectedLoadIndex];
  // Block direct invocation (e.g. dblclick) unless compatible or the
  // ignore-config checkbox is checked.
  if (!entry || (configDiffers(entry) && !els.loadIgnoreConfigInput.checked)) return;
  els.loadConfirmBtn.disabled = true;
  try {
    // Load the saved patch list into the currently active INPUT PATCHING list
    // only — nothing is sent to the console. The user can then apply it via
    // Upload. The list keeps the saved entry's own stereo layout.
    const set: SavedSet = {
      inputs: entry.inputs || [],
      stereoPairs: entry.stereoPairs || [],
    };
    editSets[activeEditSet] = set;
    buildEditInputs(set.inputs, set.stereoPairs);
    closeLoadModal();
    showSaveFeedback("Обновлено", "");
  } catch (err) {
    showSaveFeedback(`Ошибка: ${(err && (err as Error).message) || String(err)}`);
  }
}

// ── Upload / Download ────────────────────────────────────────────────

/** Make the "Active Patching" title blink green once. */
function flashActivePatching(): void {
  flashTitle(els.activePatchingTitle);
}

/** Make the "Input Patching" title blink green once. */
function flashInputPatching(): void {
  flashTitle(els.inputPatchingTitle);
}

/**
 * Read the current source/input selectors from the Input Patching table and
 * send each patch to the console. Stereo rows patch both channels (L → N,
 * R → N+1).
 */
async function uploadInputPatching(): Promise<void> {
  const rows = els.editInputTbody.querySelectorAll<HTMLTableRowElement>("tr[data-b3]");
  if (!rows.length) return;
  els.uploadBtn.disabled = true;
  let sent = 0;
  try {
    for (const tr of rows) {
      const destB3 = Number(tr.dataset.b3);
      const srcSel = tr.querySelector<HTMLSelectElement>(".source-sel");
      const inSel = tr.querySelector<HTMLSelectElement>(".input-sel");
      if (!srcSel || !inSel) continue;
      const source = Number(srcSel.value);
      const sourceChannel = Number(inSel.value);
      await window.sq.setInputPatch(destB3, source, sourceChannel);
      sent++;
      // Stereo row: also patch the right channel (N+1).
      const b3r = tr.dataset.b3r ? Number(tr.dataset.b3r) : -1;
      if (b3r >= 0) {
        await window.sq.setInputPatch(b3r, source, sourceChannel + 1);
        sent++;
      }
    }
    showSaveFeedback("Отправлено", "✓ ");
    // The console now reflects the list that was uploaded — mark Active
    // Patching with that list's letter.
    lastUploadedSet = activeEditSet;
    updateActivePatchingTitle();
    flashActivePatching();
  } catch (err) {
    showSaveFeedback(`Upload: ошибка — ${(err && (err as Error).message) || String(err)}`, "");
  } finally {
    els.uploadBtn.disabled = false;
    updateTransferButtons();
  }
}

/**
 * Pull the current routing from the console and rebuild the Input Patching
 * table to match the Active Patching list.
 */
async function downloadInputPatching(): Promise<void> {
  els.downloadBtn.disabled = true;
  try {
    const snap = await window.sq.getSnapshot();
    buildEditInputs(snap.inputs, snap.stereoPairs || []);
    // Download replaces the currently active INPUT PATCHING list.
    editSets[activeEditSet] = captureEditSet();
    showSaveFeedback("Загружено", "✓ ");
    flashInputPatching();
  } catch (err) {
    showSaveFeedback(`Download: ошибка — ${(err && (err as Error).message) || String(err)}`, "");
  } finally {
    els.downloadBtn.disabled = false;
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
export function onRoutingSnapshot(snap: SnapshotPayload): void {
  // Update stereo pairs FIRST so table merging uses fresh data.
  const pairsKey = JSON.stringify(snap.stereoPairs || []);
  if (pairsKey !== JSON.stringify(state.stereoPairs)) {
    state.stereoPairs = snap.stereoPairs || [];
    buildChannelButtons();
    if (!editInputsFrozen) editInputsBuilt = false; // force rebuild of editable table
  }
  renderInputs(snap.inputs);
  // After the initial burst the Input Patching table is frozen — later console
  // routing changes must not alter it (selectors stay active for editing).
  syncEditInputs(snap.inputs, snap.stereoPairs);
}

/** Freeze the Input Patching snapshot after the initial state burst. */
export function freezeEditTable(): void {
  editInputsFrozen = true;
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
  els.editInputTbody.innerHTML = "";
  if (els.uploadBtn) els.uploadBtn.disabled = false;
  if (els.downloadBtn) els.downloadBtn.disabled = false;
}

// ── bindings ─────────────────────────────────────────────────────────

// save-routing modal
els.saveRoutingBtn.addEventListener("click", openSaveModal);
els.saveConfirmBtn.addEventListener("click", confirmSaveRouting);
els.saveCancelBtn.addEventListener("click", closeSaveModal);
els.saveNameInput.addEventListener("keydown", (e: KeyboardEvent) => {
  if (e.key === "Enter") {
    e.preventDefault();
    confirmSaveRouting();
  }
});
// Click on the overlay backdrop (outside the card) closes the modal.
els.saveModal.addEventListener("click", (e: MouseEvent) => {
  if (e.target === els.saveModal) closeSaveModal();
});
// Esc closes the modal (separate from the monitor-view Esc handler).
window.addEventListener("keydown", (e: KeyboardEvent) => {
  if (!els.saveModal.hidden && e.key === "Escape") {
    e.preventDefault();
    closeSaveModal();
  }
});

// load-routing modal
els.loadRoutingBtn.addEventListener("click", openLoadModal);
els.loadConfirmBtn.addEventListener("click", confirmLoadRouting);
els.loadCancelBtn.addEventListener("click", closeLoadModal);
els.loadIgnoreConfigInput.addEventListener("change", updateLoadConfirmState);
els.loadModal.addEventListener("click", (e: MouseEvent) => {
  if (e.target === els.loadModal) closeLoadModal();
});
window.addEventListener("keydown", (e: KeyboardEvent) => {
  if (!els.loadModal.hidden && e.key === "Escape") {
    e.preventDefault();
    closeLoadModal();
  }
});

// Upload / Download / A/B / sync scroll
els.uploadBtn.addEventListener("click", uploadInputPatching);
els.downloadBtn.addEventListener("click", downloadInputPatching);
els.abBtn.addEventListener("click", () => switchEditSet("A"));
els.bBtn.addEventListener("click", () => switchEditSet("B"));
els.syncScrollBtn.addEventListener("click", () => {
  syncScrollEnabled = !syncScrollEnabled;
  els.syncScrollBtn.classList.toggle("active", syncScrollEnabled);
  els.syncScrollBtn.setAttribute("aria-pressed", String(syncScrollEnabled));
  if (syncScrollEnabled) {
    // Align both lists immediately on enable.
    mirrorScroll(els.editTableWrap, els.activeTableWrap);
  }
});
els.editTableWrap.addEventListener("scroll", () =>
  mirrorScroll(els.editTableWrap, els.activeTableWrap)
);
els.activeTableWrap.addEventListener("scroll", () =>
  mirrorScroll(els.activeTableWrap, els.editTableWrap)
);
