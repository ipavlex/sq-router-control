"use strict";
/* SQ Router Control — renderer logic.
 * Talks to the main process exclusively through the `window.sq` bridge. */

const $ = (sel) => document.querySelector(sel);

const els = {
  connectScreen: $("#connect-screen"),
  dashScreen: $("#dash-screen"),
  ip: $("#ip-input"),
  port: $("#port-input"),
  connectBtn: $("#connect-btn"),
  demoBtn: $("#demo-btn"),
  connectMsg: $("#connect-msg"),
  recentRow: $("#recent-row"),
  recentList: $("#recent-list"),
  topbarTitle: $("#topbar-title"),
  topbarSub: $("#topbar-sub"),
  requestBtn: $("#request-btn"),
  logBtn: $("#log-btn"),
  viewRouting: $("#view-routing"),
  viewLog: $("#view-log"),
  viewMonitor: $("#view-monitor"),
  routingBtn: $("#routing-btn"),
  monitorBtn: $("#monitor-btn"),
  monLDest: $("#mon-l-dest"),
  monRDest: $("#mon-r-dest"),
  mixButtons: $("#mix-buttons"),
  chButtons: $("#ch-buttons"),
  mainlrBtn: $("#mainlr-btn"),
  monEnable: $("#mon-enable"),
  disconnectBtn: $("#disconnect-btn"),
  inputTbody: $("#input-table tbody"),
  inEmpty: $("#in-empty"),
  editInputTbody: $("#edit-input-table tbody"),
  editInEmpty: $("#edit-in-empty"),
  updateStat: $("#update-stat"),
  log: $("#log"),
  clearLog: $("#clear-log"),
  saveRoutingBtn: $("#save-routing-btn"),
  topbarScene: $("#topbar-scene"),
  saveFeedback: $("#save-feedback"),
  saveModal: $("#save-modal"),
  saveNameInput: $("#save-name-input"),
  saveCancelBtn: $("#save-cancel-btn"),
  saveConfirmBtn: $("#save-confirm-btn"),
  loadRoutingBtn: $("#load-routing-btn"),
  loadModal: $("#load-modal"),
  loadList: $("#load-list"),
  loadEmpty: $("#load-empty"),
  loadCancelBtn: $("#load-cancel-btn"),
  loadConfirmBtn: $("#load-confirm-btn"),
  loadIgnoreConfig: $("#load-ignore-config"),
  loadIgnoreConfigInput: $("#load-ignore-config-input"),
  uploadBtn: $("#upload-btn"),
  downloadBtn: $("#download-btn"),
  abBtn: $("#a-btn"),
  bBtn: $("#b-btn"),
  activePatchingTitle: $("#active-patching-title"),
  inputPatchingTitle: $("#input-patching-title"),
  syncScrollBtn: $("#sync-scroll-btn"),
  editTableWrap: $("#edit-table-wrap"),
  activeTableWrap: $("#active-table-wrap"),
};

const RECENT_KEY = "sq_recent_hosts";
let logLineCount = 0;
const MAX_LOG_LINES = 400;
/** Current model spec; drives input/output count adaptation. */
let modelSpec = null;
/** Stereo pairs from snapshot: [[leftB3, rightB3], ...] */
let stereoPairs = [];
/** Last routing snapshot received from the console (Active Patching data). */
let activeInputs = [];

/** Name of the console's currently-active scene (from snapshot), or null. */
let currentSceneName = null;

const SAVED_ROUTING_KEY = "sq_saved_routing";
let saveFeedbackTimer = null;

// ── helpers ──────────────────────────────────────────────────────────
function isValidHost(host) {
  if (!host) return false;
  // IPv4 or hostname.
  const ipv4 =
    /^(\d{1,3})\.(\d{1,3})\.(\d{1,3})\.(\d{1,3})$/.test(host) &&
    host.split(".").every((p) => Number(p) >= 0 && Number(p) <= 255);
  const hostname = /^[a-zA-Z0-9-]+(\.[a-zA-Z0-9-]+)*$/.test(host);
  return ipv4 || hostname;
}

function setMsg(text, kind) {
  if (!text) {
    els.connectMsg.hidden = true;
    els.connectMsg.textContent = "";
    return;
  }
  els.connectMsg.hidden = false;
  els.connectMsg.textContent = text;
  els.connectMsg.className = "msg " + (kind || "error");
}

function setLoading(on) {
  els.connectBtn.disabled = on;
  const label = els.connectBtn.querySelector(".btn-label");
  const existing = els.connectBtn.querySelector(".spinner");
  if (on) {
    if (existing) return;
    const spin = document.createElement("span");
    spin.className = "spinner";
    els.connectBtn.insertBefore(spin, label);
    label.textContent = "Подключение…";
  } else {
    if (existing) existing.remove();
    label.textContent = "Подключиться";
  }
}

function getRecent() {
  try {
    return JSON.parse(localStorage.getItem(RECENT_KEY) || "[]");
  } catch {
    return [];
  }
}

function addRecent(host) {
  const list = getRecent().filter((h) => h !== host);
  list.unshift(host);
  localStorage.setItem(RECENT_KEY, JSON.stringify(list.slice(0, 6)));
  renderRecent();
}

function renderRecent() {
  const list = getRecent();
  if (!list.length) {
    els.recentRow.hidden = true;
    return;
  }
  els.recentRow.hidden = false;
  els.recentList.innerHTML = "";
  for (const h of list) {
    const chip = document.createElement("span");
    chip.className = "recent-chip";
    chip.textContent = h;
    chip.addEventListener("click", () => {
      els.ip.value = h;
      els.ip.focus();
    });
    els.recentList.appendChild(chip);
  }
}

function showScreen(which) {
  els.connectScreen.hidden = which !== "connect";
  els.dashScreen.hidden = which !== "dash";
}

function fmtTime() {
  const d = new Date();
  const p = (n) => String(n).padStart(2, "0");
  return `${p(d.getHours())}:${p(d.getMinutes())}:${p(d.getSeconds())}`;
}

// ── tables ───────────────────────────────────────────────────────────

/** Set of b3 values that are the RIGHT side of a stereo pair (to be skipped). */
function stereoRightSet(pairs) {
  const s = new Set();
  for (const [l, r] of pairs) s.add(r);
  return s;
}

/** Returns the stereo pair for a left b3, or null. */
function stereoPairForLeft(b3, pairs) {
  for (const [l, r] of pairs) if (l === b3) return [l, r];
  return null;
}

/**
 * Merge stereo pairs in an inputs array: right-side channels are removed,
 * left-side channels get a combined label and the right channel's info.
 * Returns a new array.
 */
function mergeStereoInputs(inputs, pairs) {
  const rightSet = stereoRightSet(pairs);
  const byB3 = {};
  for (const inp of inputs) byB3[inp.destB3] = inp;
  const result = [];
  for (const inp of inputs) {
    if (rightSet.has(inp.destB3)) continue; // skip right side
    const pair = stereoPairForLeft(inp.destB3, pairs);
    if (pair) {
      const right = byB3[pair[1]];
      const merged = { ...inp };
      merged.destLabel = `${inp.destLabel}-${pair[1] + 1}`;
      merged._stereo = true;
      merged._rightSourceChannel = right ? right.sourceChannel : inp.sourceChannel + 1;
      result.push(merged);
    } else {
      result.push(inp);
    }
  }
  return result;
}

function renderInputs(inputs) {
  activeInputs = inputs;
  const merged = mergeStereoInputs(inputs, stereoPairs);
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
      ? `${r.sourceChannel + 1}-${r._rightSourceChannel + 1}`
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

/**
 * Show the 1-based source channel number. The wire value is 0-indexed
 * (matching the SQ b3 address space), but inputs on the console surface
 * are labelled 1..N, so we display 1-based.
 */
function formatSourceChannel(patch) {
  return String(patch.sourceChannel + 1);
}

// ── editable input patching ──────────────────────────────────────────
const INPUT_SOURCES = [
  { value: 0x01, label: "Local" },
  { value: 0x02, label: "dSnake / SLink" },
  { value: 0x03, label: "USB" },
  { value: 0x04, label: "I/O Port" },
];

/** Max channels available for a given source type (1-based count). */
function maxSourceChannel(source) {
  switch (source) {
    case 0x01: return modelSpec ? modelSpec.localInputs : 48;
    case 0x02: return 48;
    case 0x03: return modelSpec ? modelSpec.usbChannels : 32;
    case 0x04: return 64;
    default: return 48;
  }
}

/** Populate the input-number <select> with options 1..max for a source type. */
function populateInputNumberSelect(selectEl, source, currentValue) {
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
function populateStereoInputNumberSelect(selectEl, source, currentValue) {
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
let editSets = { A: null, B: null };
/** Currently displayed edit list: "A" or "B". */
let activeEditSet = "A";
/**
 * Which edit list ("A"/"B") was last uploaded to the console, or null.
 * Shown on the Active Patching title until the next upload or reconnect.
 */
let lastUploadedSet = null;

/** Read the on-screen edit table back into a serializable list snapshot. */
function captureEditSet() {
  return { inputs: readEditInputs(), stereoPairs: readEditStereoPairs() };
}

/** Reflect the active list on the A/B buttons and the panel title. */
function updateAbButtons() {
  els.abBtn.classList.toggle("active", activeEditSet === "A");
  els.bBtn.classList.toggle("active", activeEditSet === "B");
  els.inputPatchingTitle.innerHTML =
    `Input Patching · <span class="list-letter list-${activeEditSet.toLowerCase()}">${activeEditSet}</span>`;
}

/** Mark the Active Patching title with the list uploaded last, if any. */
function updateActivePatchingTitle() {
  els.activePatchingTitle.innerHTML = lastUploadedSet
    ? `Active Patching · <span class="list-letter list-${lastUploadedSet.toLowerCase()}">${lastUploadedSet}</span>`
    : "Active Patching";
}

/**
 * Switch the displayed INPUT PATCHING list. The current on-screen state is
 * preserved into its slot; the target slot is seeded from the current list
 * on its first visit so the user starts from a copy they can diverge from.
 */
function switchEditSet(target) {
  if (target === activeEditSet) return;
  editSets[activeEditSet] = captureEditSet();
  if (!editSets[target]) {
    editSets[target] = JSON.parse(JSON.stringify(editSets[activeEditSet]));
  }
  activeEditSet = target;
  updateAbButtons();
  buildEditInputs(editSets[target].inputs || [], editSets[target].stereoPairs || []);
}

/** Build the full editable input-patching table from a snapshot. */
function buildEditInputs(inputs, pairs) {
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
    const repopulateInSel = () => {
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
 */
function syncEditInputs(inputs, pairs) {
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
    const srcSel = tr.querySelector(".source-sel");
    const inSel = tr.querySelector(".input-sel");
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
function readEditTable() {
  const map = new Map();
  for (const tr of els.editInputTbody.querySelectorAll("tr[data-b3]")) {
    const destB3 = Number(tr.dataset.b3);
    const srcSel = tr.querySelector(".source-sel");
    const inSel = tr.querySelector(".input-sel");
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
function listsEqual() {
  const edit = readEditTable();
  const active = new Map(
    activeInputs.map((p) => [p.destB3, { source: p.source, sourceChannel: p.sourceChannel }])
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
function readEditStereoPairs() {
  const pairs = [];
  for (const tr of els.editInputTbody.querySelectorAll('tr[data-stereo="1"]')) {
    const l = Number(tr.dataset.b3);
    const r = Number(tr.dataset.b3r);
    if (r >= 0) pairs.push([l, r]);
  }
  return pairs;
}

/** Disable Upload/Download when both routing lists match, enable otherwise. */
function updateTransferButtons() {
  const equal = listsEqual();
  // Upload must not run when the stereo/mono layout of the editable table
  // differs from the console's current stereo pairs — patching would be wrong.
  const stereoDiffers =
    stereoConfigKey(readEditStereoPairs()) !== stereoConfigKey(stereoPairs);
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
function updateTransferTooltips(equal, stereoDiffers) {
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

function escapeHtml(s) {
  return String(s)
    .replace(/&/g, "&amp;")
    .replace(/</g, "&lt;")
    .replace(/>/g, "&gt;")
    .replace(/"/g, "&quot;");
}

// ── log ──────────────────────────────────────────────────────────────
function pushLog(level, msg) {
  const line = document.createElement("div");
  line.className = "line";
  line.innerHTML =
    `<span class="ts">${fmtTime()}</span>` +
    `<span class="lvl ${level}">${level.toUpperCase()}</span>` +
    `<span class="msg">${escapeHtml(msg)}</span>`;
  els.log.appendChild(line);
  logLineCount++;
  while (logLineCount > MAX_LOG_LINES) {
    if (els.log.firstChild) els.log.removeChild(els.log.firstChild);
    logLineCount--;
  }
  els.log.scrollTop = els.log.scrollHeight;
}

// ── demo flow ───────────────────────────────────────────────────────
let demoStarting = false;
/** Whether the current session is running in demo (simulated) mode. */
let isDemoMode = false;
async function doStartDemo() {
  if (demoStarting) return;
  demoStarting = true;
  els.demoBtn.disabled = true;
  setMsg("", "");
  try {
    const res = await window.sq.startDemo();
    if (res && res.ok) {
      isDemoMode = true;
      enterDashboard(res.version, res.spec, "demo");
      await doRefresh();
    } else {
      setMsg((res && res.error) || "Не удалось запустить демо.", "error");
    }
  } catch (err) {
    setMsg((err && err.message) || String(err), "error");
  } finally {
    demoStarting = false;
  }
}

// ── connect flow ─────────────────────────────────────────────────────
async function doConnect() {
  const host = els.ip.value.trim();
  const port = Number(els.port.value) || undefined;

  if (!isValidHost(host)) {
    setMsg("Введите корректный IP-адрес или имя хоста.", "error");
    els.ip.focus();
    return;
  }

  setMsg("", "");
  setLoading(true);

  try {
    const res = await window.sq.connect(host, port);
    if (res && res.ok) {
      isDemoMode = false;
      addRecent(host);
      enterDashboard(res.version, res.spec, host);
      await doRefresh();
    } else {
      setLoading(false);
      setMsg((res && res.error) || "Не удалось подключиться.", "error");
    }
  } catch (err) {
    setLoading(false);
    setMsg((err && err.message) || String(err), "error");
  }
}

function enterDashboard(version, spec, host) {
  setLoading(false);
  showScreen("dash");
  const v = version || {};
  els.topbarTitle.textContent = (spec && spec.name) || v.modelName || "SQ";
  els.topbarSub.textContent = `${host} · FW ${v.fwA ?? "?"}.${v.fwB ?? "?"}${
    v.build !== undefined ? "." + v.build : ""
  }`;
  modelSpec = spec || null;
  currentSceneName = null;
  editInputsBuilt = false;
  editInputsFrozen = false;
  editSets = { A: null, B: null };
  activeEditSet = "A";
  updateAbButtons();
  lastUploadedSet = null;
  updateActivePatchingTitle();
  activeInputs = [];
  els.editInputTbody.innerHTML = "";
  els.log.innerHTML = "";
  logLineCount = 0;
  els.updateStat.textContent = "";
  if (els.uploadBtn) els.uploadBtn.disabled = false;
  if (els.downloadBtn) els.downloadBtn.disabled = false;
  populateMonitorSelects();
  buildMixButtons();
  stereoPairs = [];
  buildChannelButtons();
  // Main LR active by default (UI-only — no command sent unless enabled)
  activeSourceB3 = 0x68;
  leftChannelB3 = null;
  rightChannelB3 = null;
  els.mainlrBtn.classList.add("active");
  updateSceneHint();
  showView("routing");
}

async function doDisconnect() {
  await window.sq.disconnect();
  setMsg("", "");
  els.ip.value = "";
  showScreen("connect");
}

async function doRefresh() {
  // In demo mode "Обновить" regenerates a completely new simulated routing
  // (different names, stereo pairs and patching) instead of re-reading state.
  const snap = isDemoMode
    ? await window.sq.demoRefresh()
    : await window.sq.getSnapshot();
  renderInputs(snap.inputs);
  // The Input Patching table is a startup snapshot — a manual refresh must not
  // re-sync it either (selectors stay active for editing).
  if (!editInputsFrozen) syncEditInputs(snap.inputs, snap.stereoPairs);
  updateStat(snap);
  currentSceneName = snap.currentSceneName ?? null;
  updateSceneHint();
}

function updateStat(snap) {
  const parts = [];
  parts.push(`обновлений: ${snap.updates}`);
  if (snap.routingBlockBytes) parts.push(`routing block: ${snap.routingBlockBytes} B`);
  els.updateStat.textContent = parts.join(" · ");
}

// ── scene hint + save-routing ────────────────────────────────────────
function updateSceneHint() {
  els.topbarScene.textContent = currentSceneName
    ? ` · 🎬 ${currentSceneName}`
    : "";
}

function todayStr() {
  const d = new Date();
  const p = (n) => String(n).padStart(2, "0");
  return `${d.getFullYear()}.${p(d.getMonth() + 1)}.${p(d.getDate())}`;
}

/** Default save name: "гггг.мм.дд {scene}" (scene omitted if unknown). */
function defaultSaveName() {
  return currentSceneName ? `${todayStr()} ${currentSceneName}` : todayStr();
}

function getSavedRouting() {
  try {
    return JSON.parse(localStorage.getItem(SAVED_ROUTING_KEY) || "[]");
  } catch {
    return [];
  }
}

function addSavedRouting(entry) {
  const list = getSavedRouting();
  list.unshift(entry);
  localStorage.setItem(SAVED_ROUTING_KEY, JSON.stringify(list.slice(0, 100)));
}

function openSaveModal() {
  els.saveNameInput.value = defaultSaveName();
  els.saveModal.hidden = false;
  // Pre-select the prefilled text so the user can quickly overwrite or keep it.
  els.saveNameInput.focus();
  els.saveNameInput.select();
}

function closeSaveModal() {
  els.saveModal.hidden = true;
}

function showSaveFeedback(text, prefix = "✓ Сохранено: ") {
  if (saveFeedbackTimer) clearTimeout(saveFeedbackTimer);
  els.saveFeedback.textContent = prefix + text;
  els.saveFeedback.classList.add("show");
  saveFeedbackTimer = setTimeout(() => {
    els.saveFeedback.classList.remove("show");
    saveFeedbackTimer = null;
  }, 3500);
}

async function confirmSaveRouting() {
  const name = els.saveNameInput.value.trim();
  if (!name) {
    els.saveNameInput.focus();
    return;
  }
  let snap = null;
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
function readEditInputs() {
  const inputs = [];
  for (const tr of els.editInputTbody.querySelectorAll("tr[data-b3]")) {
    const destB3 = Number(tr.dataset.b3);
    const srcSel = tr.querySelector(".source-sel");
    const inSel = tr.querySelector(".input-sel");
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
      name,
      source,
      sourceChannel,
    });
    if (b3r >= 0) {
      inputs.push({
        destB3: b3r,
        destLabel: `Input ${b3r + 1}`,
        name,
        source,
        sourceChannel: sourceChannel + 1,
      });
    }
  }
  return inputs;
}

// ── load-routing ─────────────────────────────────────────────────────
let selectedLoadIndex = -1;

function stereoConfigKey(pairs) {
  const arr = Array.isArray(pairs) ? pairs.map((p) => [p[0], p[1]]) : [];
  arr.sort((a, b) => a[0] - b[0] || a[1] - b[1]);
  return JSON.stringify(arr);
}

function configDiffers(entry) {
  const currentModel = (modelSpec && modelSpec.name) || els.topbarTitle.textContent || "";
  const modelDiffers = Boolean(entry.model) && Boolean(currentModel) && entry.model !== currentModel;
  const stereoDiffers = stereoConfigKey(entry.stereoPairs) !== stereoConfigKey(stereoPairs);
  return modelDiffers || stereoDiffers;
}

function formatSavedDate(iso) {
  try {
    const d = new Date(iso);
    if (isNaN(d.getTime())) return "";
    const p = (n) => String(n).padStart(2, "0");
    return `${p(d.getDate())}.${p(d.getMonth() + 1)}.${d.getFullYear()} ${p(d.getHours())}:${p(d.getMinutes())}`;
  } catch {
    return "";
  }
}

function removeSavedRouting(index) {
  const list = getSavedRouting();
  if (index < 0 || index >= list.length) return;
  list.splice(index, 1);
  localStorage.setItem(SAVED_ROUTING_KEY, JSON.stringify(list));
}

function renderLoadList() {
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
    const parts = [];
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
    del.addEventListener("click", (ev) => {
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
function updateLoadConfirmState() {
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

function selectLoadRow(i) {
  selectedLoadIndex = i;
  for (const row of els.loadList.querySelectorAll(".load-row")) {
    row.classList.toggle("selected", Number(row.dataset.index) === i);
  }
  updateLoadConfirmState();
}

function openLoadModal() {
  selectedLoadIndex = -1;
  renderLoadList();
  els.loadModal.hidden = false;
}

function closeLoadModal() {
  els.loadModal.hidden = true;
}

async function confirmLoadRouting() {
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
    const set = {
      inputs: entry.inputs || [],
      stereoPairs: entry.stereoPairs || [],
    };
    editSets[activeEditSet] = set;
    buildEditInputs(set.inputs, set.stereoPairs);
    closeLoadModal();
    showSaveFeedback("Обновлено", "");
  } catch (err) {
    showSaveFeedback(`Ошибка: ${(err && err.message) || String(err)}`);
  }
}

// ── monitor output selectors ────────────────────────────────────────
/**
 * Build the list of all available physical outputs from the model spec.
 * Returns array of {value, label} where value = "destType:channel".
 */
function buildOutputOptions() {
  const opts = [];
  const spec = modelSpec;
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

function populateMonitorSelects() {
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
    const groups = {};
    for (const o of opts) {
      const type = o.label.split(" Out")[0];
      if (!groups[type]) groups[type] = document.createElement("optgroup");
      groups[type].label = type + " Out";
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
function monEnabled() {
  return els.monEnable.checked;
}

/** Parse an L/R destination selector value into {destType, destChannel}. */
function parseDest(sel) {
  const val = sel.value;
  if (!val) return null;
  const [destTypeHex, chStr] = val.split(":");
  return { destType: parseInt(destTypeHex, 16), destChannel: Number(chStr) };
}

/** Route a source b3 to a physical output (output patch). */
async function routeSourceToOutput(sourceB3, dest) {
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
async function routeActiveSelection() {
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

// ── mix group buttons ───────────────────────────────────────────────
let activeSourceB3 = null;
let leftChannelB3 = null;
let rightChannelB3 = null;

/** Clear the active mix highlight and selection. */
function clearActiveMix() {
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
async function toggleMixRoute(b3, btn) {
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
function clearChannelSelection() {
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
async function onChannelClick(b3, btn) {
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

function buildMixButtons() {
  const container = els.mixButtons;
  container.innerHTML = "";
  const items = [];
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

/** Check if a b3 is the left side of a stereo pair. Returns the pair or null. */
function getStereoPair(b3) {
  for (const pair of stereoPairs) {
    if (pair[0] === b3) return pair;
  }
  return null;
}

/** Check if a b3 is the right side of a stereo pair (skip it — merged into left). */
function isStereoRight(b3) {
  return stereoPairs.some((p) => p[1] === b3);
}

/**
 * Create the 48 channel buttons once. Stereo pairs are merged into one cell
 * spanning 2 grid columns. Called from enterDashboard / buildChannelButtons.
 */
function buildChannelButtons() {
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
async function onStereoClick(b3L, b3R, btn) {
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
async function clearAllChannels() {
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
function updateChannelNames(inputs) {
  const nameMap = {};
  for (const inp of inputs) nameMap[inp.destB3] = inp.name || "";

  for (const btn of els.chButtons.querySelectorAll(".ch-btn")) {
    const b3 = Number(btn.dataset.b3);
    const b3r = btn.dataset.b3r ? Number(btn.dataset.b3r) : null;

    if (b3r !== null) {
      // Stereo: show combined name from left channel
      const name = nameMap[b3] || "";
      const nameEl = btn.querySelector(".ch-btn-name");
      if (nameEl) nameEl.textContent = name;
    } else {
      const name = nameMap[b3] || "";
      const nameEl = btn.querySelector(".ch-btn-name");
      if (nameEl) nameEl.textContent = name;
    }
  }
}

// Main LR button — routes Main LR like a mix selection
els.mainlrBtn.addEventListener("click", () => toggleMixRoute(0x68, els.mainlrBtn));

// ── wire events ──────────────────────────────────────────────────────
window.sq.onStatus((p) => {
  // Keep model spec in sync in case it arrives via a status update.
  if (p.spec) modelSpec = p.spec;
  if (!p.connected) {
    // unexpected drop
    if (!els.dashScreen.hidden) {
      showScreen("connect");
      modelSpec = null;
      setMsg("Соединение с пультом разорвано.", "error");
    }
  }
});

window.sq.onRouting((snap) => {
  // Update stereo pairs FIRST so table merging uses fresh data.
  const pairsKey = JSON.stringify(snap.stereoPairs || []);
  if (pairsKey !== JSON.stringify(stereoPairs)) {
    stereoPairs = snap.stereoPairs || [];
    buildChannelButtons();
    if (!editInputsFrozen) editInputsBuilt = false; // force rebuild of editable table
  }
  renderInputs(snap.inputs);
  // After the initial burst the Input Patching table is frozen — later console
  // routing changes must not alter it (selectors stay active for editing).
  if (!editInputsFrozen) syncEditInputs(snap.inputs, snap.stereoPairs);
  updateChannelNames(snap.inputs);
  updateStat(snap);
  currentSceneName = snap.currentSceneName ?? null;
  updateSceneHint();
});

window.sq.onInitialState(() => {
  // Initial fill complete — freeze the Input Patching snapshot from now on.
  editInputsFrozen = true;
});

window.sq.onLog((p) => pushLog(p.level, p.msg));

// ── bindings ─────────────────────────────────────────────────────────
els.connectBtn.addEventListener("click", doConnect);
els.demoBtn.addEventListener("click", doStartDemo);
els.ip.addEventListener("keydown", (e) => {
  if (e.key === "Enter") doConnect();
});
els.port.addEventListener("keydown", (e) => {
  if (e.key === "Enter") doConnect();
});
// ── view switching (routing / log / monitor) ────────────────────────
function showView(which) {
  els.viewRouting.hidden = which !== "routing";
  els.viewLog.hidden = which !== "log";
  els.viewMonitor.hidden = which !== "monitor";
  els.logBtn.textContent = which === "log" ? "← Назад" : "📋 Журнал";
  // Highlight active tab
  els.routingBtn.classList.toggle("active", which === "routing");
  els.monitorBtn.classList.toggle("active", which === "monitor");
}

els.disconnectBtn.addEventListener("click", doDisconnect);
els.logBtn.addEventListener("click", () => {
  const onLog = !els.viewLog.hidden;
  showView(onLog ? "routing" : "log");
  if (!onLog) els.log.scrollTop = els.log.scrollHeight;
});
els.routingBtn.addEventListener("click", () => showView("routing"));
els.monitorBtn.addEventListener("click", () => showView("monitor"));
els.requestBtn.addEventListener("click", async () => {
  els.requestBtn.disabled = true;
  try {
    if (isDemoMode) {
      // Demo: regenerate a completely new simulated routing.
      await doRefresh();
    } else {
      // Real console: ask for a fresh full dump.
      await window.sq.requestDump();
    }
  } finally {
    setTimeout(() => (els.requestBtn.disabled = false), 600);
  }
});
els.clearLog.addEventListener("click", () => {
  els.log.innerHTML = "";
  logLineCount = 0;
});

// ── save-routing modal ───────────────────────────────────────────────
els.saveRoutingBtn.addEventListener("click", openSaveModal);
els.saveConfirmBtn.addEventListener("click", confirmSaveRouting);
els.saveCancelBtn.addEventListener("click", closeSaveModal);
els.saveNameInput.addEventListener("keydown", (e) => {
  if (e.key === "Enter") {
    e.preventDefault();
    confirmSaveRouting();
  }
});
// Click on the overlay backdrop (outside the card) closes the modal.
els.saveModal.addEventListener("click", (e) => {
  if (e.target === els.saveModal) closeSaveModal();
});
// Esc closes the modal (separate from the monitor-view Esc handler).
window.addEventListener("keydown", (e) => {
  if (!els.saveModal.hidden && e.key === "Escape") {
    e.preventDefault();
    closeSaveModal();
  }
});

// ── load-routing modal ───────────────────────────────────────────────
els.loadRoutingBtn.addEventListener("click", openLoadModal);
els.loadConfirmBtn.addEventListener("click", confirmLoadRouting);
els.loadCancelBtn.addEventListener("click", closeLoadModal);
els.loadIgnoreConfigInput.addEventListener("change", updateLoadConfirmState);
els.loadModal.addEventListener("click", (e) => {
  if (e.target === els.loadModal) closeLoadModal();
});
window.addEventListener("keydown", (e) => {
  if (!els.loadModal.hidden && e.key === "Escape") {
    e.preventDefault();
    closeLoadModal();
  }
});

// ── Upload: send the Input Patching list to the console ───────────────
/**
 * Make a panel title blink green once (one-shot animation).
 */
function flashTitle(el) {
  if (!el) return;
  el.classList.remove("flash-green");
  void el.offsetWidth; // restart the animation if it just ran
  el.classList.add("flash-green");
  el.addEventListener("animationend", () => el.classList.remove("flash-green"), {
    once: true,
  });
}

/** Make the "Active Patching" title blink green once. */
function flashActivePatching() {
  flashTitle(els.activePatchingTitle);
}

/** Make the "Input Patching" title blink green once. */
function flashInputPatching() {
  flashTitle(els.inputPatchingTitle);
}

/**
 * Read the current source/input selectors from the Input Patching table and
 * send each patch to the console. Stereo rows patch both channels (L → N,
 * R → N+1).
 */
async function uploadInputPatching() {
  const rows = els.editInputTbody.querySelectorAll("tr[data-b3]");
  if (!rows.length) return;
  els.uploadBtn.disabled = true;
  let sent = 0;
  try {
    for (const tr of rows) {
      const destB3 = Number(tr.dataset.b3);
      const srcSel = tr.querySelector(".source-sel");
      const inSel = tr.querySelector(".input-sel");
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
    showSaveFeedback(`Upload: ошибка — ${(err && err.message) || String(err)}`, "");
  } finally {
    els.uploadBtn.disabled = false;
    updateTransferButtons();
  }
}

els.uploadBtn.addEventListener("click", uploadInputPatching);

// ── A/B preset lists: switch the displayed INPUT PATCHING list ───────
els.abBtn.addEventListener("click", () => switchEditSet("A"));
els.bBtn.addEventListener("click", () => switchEditSet("B"));

// ── Download: refresh the Input Patching list from the console ────────
/**
 * Pull the current routing from the console and rebuild the Input Patching
 * table to match the Active Patching list.
 */
async function downloadInputPatching() {
  els.downloadBtn.disabled = true;
  try {
    const snap = await window.sq.getSnapshot();
    buildEditInputs(snap.inputs, snap.stereoPairs || []);
    // Download replaces the currently active INPUT PATCHING list.
    editSets[activeEditSet] = captureEditSet();
    showSaveFeedback("Загружено", "✓ ");
    flashInputPatching();
  } catch (err) {
    showSaveFeedback(`Download: ошибка — ${(err && err.message) || String(err)}`, "");
  } finally {
    els.downloadBtn.disabled = false;
    updateTransferButtons();
  }
}

els.downloadBtn.addEventListener("click", downloadInputPatching);

// ── Sync scroll between the two routing lists ─────────────────────────
let syncScrollEnabled = false;
let syncingScroll = false;

/**
 * Mirror one list's scrollTop onto the other. Guarded so a programmatic
 * scroll event doesn't bounce back and forth forever.
 */
function mirrorScroll(srcWrap, dstWrap) {
  if (!syncScrollEnabled || syncingScroll) return;
  syncingScroll = true;
  dstWrap.scrollTop = srcWrap.scrollTop;
  // Release the guard on the next tick so the echoed scroll event is ignored.
  requestAnimationFrame(() => {
    syncingScroll = false;
  });
}

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

// ── arrow key navigation (left/right) on monitor view ────────────────
// If a channel is active → arrows cycle through channels only.
// If a mix is active → arrows cycle through mixes only.
// Main LR and nothing-selected → arrows do nothing.

window.addEventListener("keydown", (e) => {
  if (els.viewMonitor.hidden) return;
  if (e.key !== "ArrowLeft" && e.key !== "ArrowRight") return;
  if (e.target.tagName === "SELECT" || e.target.tagName === "INPUT") return;

  e.preventDefault();

  const channelBtns = [...els.chButtons.querySelectorAll(".ch-btn")];
  const mixBtns = [...els.mixButtons.querySelectorAll(".mix-btn")];

  // Determine active group: channels or mixes
  let group, groupActive;
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
  let next;
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
window.addEventListener("keydown", (e) => {
  if (els.viewMonitor.hidden) return;
  if (e.target.tagName === "SELECT" || e.target.tagName === "INPUT") return;

  const num = parseInt(e.key, 10);
  if (isNaN(num)) return;

  // 1-9 → Mix 1-9, 0 → Mix 10
  const mixNum = num === 0 ? 10 : num;
  if (mixNum < 1 || mixNum > 12) return;

  const mixBtns = [...els.mixButtons.querySelectorAll(".mix-btn")];
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
window.addEventListener("keydown", (e) => {
  if (els.viewMonitor.hidden) return;
  if (e.key !== "Escape") return;
  if (!monEnabled()) return;
  if (e.target.tagName === "SELECT" || e.target.tagName === "INPUT") return;
  e.preventDefault();

  // Clear all selections and highlights. The routing is left as-is — the
  // outputs keep the last selected source.
  clearActiveMix();
  clearChannelSelection();
  els.mainlrBtn.classList.remove("active");

  // Uncheck the enable checkbox
  els.monEnable.checked = false;
});

// ── init ─────────────────────────────────────────────────────────────
window.addEventListener("error", (e) => {
  console.error("RENDERER ERROR:", e.error ? e.error.stack : e.message);
});
renderRecent();
const recent = getRecent();
if (recent.length) {
  els.ip.value = recent[0];
}
els.ip.focus();
