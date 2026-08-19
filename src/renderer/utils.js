"use strict";
/* SQ Router Control — shared core.
 * DOM element refs, cross-tab state, and generic helpers.
 * Loaded first; exposes `window.SQ` for the tab modules. */

window.SQ = window.SQ || {};

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

/** Cross-tab state shared by all modules. */
const state = {
  /** Current model spec; drives input/output count adaptation. */
  modelSpec: null,
  /** Stereo pairs from snapshot: [[leftB3, rightB3], ...] */
  stereoPairs: [],
  /** Last routing snapshot received from the console (Active Patching data). */
  activeInputs: [],
  /** Name of the console's currently-active scene (from snapshot), or null. */
  currentSceneName: null,
  /** Whether the current session is running in demo (simulated) mode. */
  isDemoMode: false,
};

const RECENT_KEY = "sq_recent_hosts";

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

function escapeHtml(s) {
  return String(s)
    .replace(/&/g, "&amp;")
    .replace(/</g, "&lt;")
    .replace(/>/g, "&gt;")
    .replace(/"/g, "&quot;");
}

function todayStr() {
  const d = new Date();
  const p = (n) => String(n).padStart(2, "0");
  return `${d.getFullYear()}.${p(d.getMonth() + 1)}.${p(d.getDate())}`;
}

/** Show the current scene name in the topbar, if any. */
function updateSceneHint() {
  els.topbarScene.textContent = state.currentSceneName
    ? ` · 🎬 ${state.currentSceneName}`
    : "";
}

/** Switch between the routing / log / monitor views. */
function showView(which) {
  els.viewRouting.hidden = which !== "routing";
  els.viewLog.hidden = which !== "log";
  els.viewMonitor.hidden = which !== "monitor";
  els.logBtn.textContent = which === "log" ? "← Назад" : "📋 Журнал";
  // Highlight active tab
  els.routingBtn.classList.toggle("active", which === "routing");
  els.monitorBtn.classList.toggle("active", which === "monitor");
}

/** Make a panel title blink green once (one-shot animation). */
function flashTitle(el) {
  if (!el) return;
  el.classList.remove("flash-green");
  void el.offsetWidth; // restart the animation if it just ran
  el.classList.add("flash-green");
  el.addEventListener("animationend", () => el.classList.remove("flash-green"), {
    once: true,
  });
}

SQ.els = els;
SQ.state = state;
SQ.utils = {
  $,
  els,
  state,
  isValidHost,
  setMsg,
  setLoading,
  getRecent,
  addRecent,
  renderRecent,
  showScreen,
  fmtTime,
  escapeHtml,
  todayStr,
  updateSceneHint,
  showView,
  flashTitle,
};