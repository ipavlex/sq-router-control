/**
 * SQ Router Control — shared renderer core.
 * DOM element refs, cross-tab state, and generic helpers.
 * Every tab module imports from here.
 */
import type { ElementRefs, RendererState } from "./types";

const $ = <T extends HTMLElement = HTMLElement>(selector: string): T =>
  document.querySelector(selector) as T;

export const elementRefs: ElementRefs = {
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
  fxButtons: $("#fx-buttons"),
  mainlrBtn: $("#mainlr-btn"),
  monEnable: $("#mon-enable"),
  monLockBtn: $("#mon-lock-btn"),
  monLockModal: $("#mon-lock-modal"),
  monLockTabs: $("#mon-lock-tabs"),
  monLockPanels: $("#mon-lock-panels"),
  monLockClose: $("#mon-lock-close"),
  disconnectBtn: $("#disconnect-btn"),
  inputTbody: $("#input-table tbody"),
  inEmpty: $("#in-empty"),
  editInputTbody: $("#edit-input-table tbody"),
  editInEmpty: $("#edit-in-empty"),
  editSelAll: $("#edit-sel-all") as HTMLInputElement,
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
  abSwapBtn: $("#ab-swap-btn"),
  activePatchingTitle: $("#active-patching-title"),
  inputPatchingTitle: $("#input-patching-title"),
  syncScrollBtn: $("#sync-scroll-btn"),
  editTableWrap: $("#edit-table-wrap"),
  activeTableWrap: $("#active-table-wrap"),
};

/** Cross-tab state shared by all renderer modules. */
export const state: RendererState = {
  modelSpec: null,
  stereoPairs: [],
  activeInputs: [],
  currentSceneName: null,
  isDemoMode: false,
};

const RECENT_KEY = "sq_recent_hosts";

export function isValidHost(host: string): boolean {
  if (!host) return false;
  // IPv4 or hostname.
  const ipv4 =
    /^(\d{1,3})\.(\d{1,3})\.(\d{1,3})\.(\d{1,3})$/.test(host) &&
    host.split(".").every((p) => Number(p) >= 0 && Number(p) <= 255);
  const hostname = /^[a-zA-Z0-9-]+(\.[a-zA-Z0-9-]+)*$/.test(host);
  return ipv4 || hostname;
}

export function setMessage(text: string, kind?: string): void {
  if (!text) {
    elementRefs.connectMsg.hidden = true;
    elementRefs.connectMsg.textContent = "";
    return;
  }
  elementRefs.connectMsg.hidden = false;
  elementRefs.connectMsg.textContent = text;
  elementRefs.connectMsg.className = "msg " + (kind || "error");
}

export function setLoading(on: boolean): void {
  elementRefs.connectBtn.disabled = on;
  const label = elementRefs.connectBtn.querySelector(".btn-label");
  const existing = elementRefs.connectBtn.querySelector(".spinner");
  if (on) {
    if (existing) return;
    const spin = document.createElement("span");
    spin.className = "spinner";
    elementRefs.connectBtn.insertBefore(spin, label);
    if (label) label.textContent = "Подключение…";
  } else {
    if (existing) existing.remove();
    if (label) label.textContent = "Подключиться";
  }
}

export function getRecent(): string[] {
  try {
    return JSON.parse(localStorage.getItem(RECENT_KEY) || "[]");
  } catch {
    return [];
  }
}

export function addRecent(host: string): void {
  const list = getRecent().filter((h) => h !== host);
  list.unshift(host);
  localStorage.setItem(RECENT_KEY, JSON.stringify(list.slice(0, 6)));
  renderRecent();
}

export function renderRecent(): void {
  const list = getRecent();
  if (!list.length) {
    elementRefs.recentRow.hidden = true;
    return;
  }
  elementRefs.recentRow.hidden = false;
  elementRefs.recentList.innerHTML = "";
  for (const h of list) {
    const chip = document.createElement("span");
    chip.className = "recent-chip";
    chip.textContent = h;
    chip.addEventListener("click", () => {
      elementRefs.ip.value = h;
      elementRefs.ip.focus();
    });
    elementRefs.recentList.appendChild(chip);
  }
}

export function showScreen(which: "connect" | "dash"): void {
  elementRefs.connectScreen.hidden = which !== "connect";
  elementRefs.dashScreen.hidden = which !== "dash";
}

export function fmtTime(): string {
  const d = new Date();
  const p = (n: number): string => String(n).padStart(2, "0");
  return `${p(d.getHours())}:${p(d.getMinutes())}:${p(d.getSeconds())}`;
}

export function escapeHtml(s: string): string {
  return String(s)
    .replace(/&/g, "&amp;")
    .replace(/</g, "&lt;")
    .replace(/>/g, "&gt;")
    .replace(/"/g, "&quot;");
}

export function todayStr(): string {
  const d = new Date();
  const p = (n: number): string => String(n).padStart(2, "0");
  return `${d.getFullYear()}.${p(d.getMonth() + 1)}.${p(d.getDate())}`;
}

/** Show the current scene name in the topbar, if any. */
export function updateSceneHint(): void {
  elementRefs.topbarScene.textContent = state.currentSceneName
    ? ` · 🎬 ${state.currentSceneName}`
    : "";
}

/** Switch between the routing / log / monitor views. */
export function showView(which: "routing" | "log" | "monitor"): void {
  elementRefs.viewRouting.hidden = which !== "routing";
  elementRefs.viewLog.hidden = which !== "log";
  elementRefs.viewMonitor.hidden = which !== "monitor";
  elementRefs.logBtn.textContent = which === "log" ? "← Назад" : "📋 Журнал";
  // Highlight active tab
  elementRefs.routingBtn.classList.toggle("active", which === "routing");
  elementRefs.monitorBtn.classList.toggle("active", which === "monitor");
}

/**
 * Make a panel title blink once (one-shot animation).
 * @param flashClass optional extra; "flash-green" by default, use "flash-a"/"flash-b"
 * to blink in the A (accent) or B (green) list color.
 */
export function flashTitle(
  el: HTMLElement | null | undefined,
  flashClass: "flash-green" | "flash-a" | "flash-b" = "flash-green"
): void {
  if (!el) return;
  el.classList.remove("flash-green", "flash-a", "flash-b");
  void el.offsetWidth; // restart the animation if it just ran
  el.classList.add(flashClass);
  el.addEventListener("animationend", () => el.classList.remove(flashClass), {
    once: true,
  });
}
