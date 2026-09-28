/**
 * SQ Router Control — dashboard module.
 * Boots the dashboard, subscribes to the console event stream and routes it
 * to the tab modules, and handles view switching. The renderer entry point
 * imports this module for its side effects.
 */
import { elementRefs, state, setLoading, setMessage, showScreen, showView, updateSceneHint, todayStr } from "../core/utils";
import * as routing from "../tabs/routing";
import * as monitor from "../tabs/monitor";
import * as log from "../tabs/log";
import { buildReaperTracks, buildReaperTrackTemplate } from "../../shared/reaper-template";
import type { LogPayload, ModelSpec, ReconnectInfo, SnapshotPayload, StatusPayload, VersionInfo } from "../../shared/ipc";

export function enterDashboard(
  version: VersionInfo | undefined,
  spec: ModelSpec | null,
  host: string
): void {
  dismissReconnectUi();
  setLoading(false);
  showScreen("dash");
  const v = version;
  elementRefs.topbarTitle.textContent = (spec && spec.name) || v?.modelName || "SQ";
  elementRefs.topbarSub.textContent = `${host} · FW ${v?.fwA ?? "?"}.${v?.fwB ?? "?"}${
    v?.build !== undefined ? "." + v.build : ""
  }`;
  state.modelSpec = spec || null;
  state.currentSceneName = null;

  routing.reset();
  monitor.reset();
  log.clear();

  updateSceneHint();
  showView("routing");
}

// ── console event stream ────────────────────────────────────────────

// ── auto-reconnect indicator ───────────────────────────────────────

/** Live countdown to the next reconnect attempt (null when idle). */
let reconnectTicker: number | null = null;

function stopReconnectTicker(): void {
  if (reconnectTicker !== null) {
    clearInterval(reconnectTicker);
    reconnectTicker = null;
  }
}

function hideReconnectBar(): void {
  stopReconnectTicker();
  elementRefs.reconnectBanner.hidden = true;
  elementRefs.connDot.classList.remove("reconnecting");
  elementRefs.connDot.classList.add("live");
}

/** Clear the reconnect indicator (used when leaving the dashboard). */
export function dismissReconnectUi(): void {
  hideReconnectBar();
}

/** Show retry progress over the dashboard, with a live countdown. */
function showReconnectBar(info: ReconnectInfo): void {
  stopReconnectTicker();
  elementRefs.reconnectBanner.hidden = false;
  elementRefs.connDot.classList.remove("live");
  elementRefs.connDot.classList.add("reconnecting");
  const total = info.maxAttempts;
  const attempt = Math.min(info.attempt, total);
  let remaining = Math.max(0, Math.ceil(info.delayMs / 1000));
  const render = (): void => {
    const head = `Соединение с пультом потеряно. Переподключение… ${attempt}/${total}`;
    elementRefs.reconnectText.textContent =
      remaining > 0 ? `${head} · через ${remaining} с` : `${head} · подключение…`;
  };
  render();
  if (remaining > 0) {
    reconnectTicker = window.setInterval(() => {
      remaining--;
      render();
      if (remaining <= 0) stopReconnectTicker();
    }, 1000);
  }
}

elementRefs.reconnectCancel.addEventListener("click", () => {
  elementRefs.reconnectCancel.disabled = true;
  window.sq.cancelReconnect().finally(() => {
    elementRefs.reconnectCancel.disabled = false;
  });
});

window.sq.onStatus((p: StatusPayload) => {
  // Keep model spec in sync in case it arrives via a status update.
  if (p.spec) state.modelSpec = p.spec;

  if (p.connected) {
    // Connected (fresh or restored) — drop any reconnect indicator.
    hideReconnectBar();
    if (p.reconnected) {
      // The console re-floods its state; clear stale meters until it arrives.
      routing.clearMeters();
      monitor.clearMeters();
      setMessage("", "");
    }
    return;
  }

  routing.clearMeters();
  monitor.clearMeters();

  if (p.reconnect?.active) {
    // Unexpected drop with auto-reconnect running: stay on the dashboard and
    // show retry progress instead of bouncing back to the connect screen.
    if (!elementRefs.dashScreen.hidden) showReconnectBar(p.reconnect);
    return;
  }

  // No reconnect pending (gave up, cancelled, or plain drop) — return to the
  // connect screen with the reason.
  hideReconnectBar();
  if (!elementRefs.dashScreen.hidden) {
    showScreen("connect");
    state.modelSpec = null;
    setMessage(p.reconnect?.error || "Соединение с пультом разорвано.", "error");
  }
});

window.sq.onRouting((snapshot: SnapshotPayload) => {
  routing.onRoutingSnapshot(snapshot);
  monitor.updateChannelNames(snapshot.inputs);
  monitor.updateMixNames(snapshot.mixNames ?? []);
  monitor.updateFxNames(snapshot.fxNames ?? []);
  monitor.updateMatrixNames(snapshot.matrixNames ?? []);
  monitor.updateOutputUsage(snapshot.outputs);
  log.updateStat(snapshot);
  state.currentSceneName = snapshot.currentSceneName ?? null;
  updateSceneHint();
});

window.sq.onInitialState(() => {
  // Initial fill complete — freeze the Input Patching snapshot from now on.
  routing.freezeEditTable();
});

window.sq.onLog((p: LogPayload) => log.pushLog(p.level, p.msg, p.raw));

// Live input meters (UDP, ~25-50 Hz) — the routing tab coalesces per frame.
window.sq.onMeters((p) => {
  routing.updateMeters(p);
  monitor.updateMeters(p);
});

// ── view switching (routing / log / monitor) ────────────────────────

elementRefs.logBtn.addEventListener("click", () => {
  showView("log");
  elementRefs.log.scrollTop = elementRefs.log.scrollHeight;
});
elementRefs.routingBtn.addEventListener("click", () => showView("routing"));
elementRefs.monitorBtn.addEventListener("click", () => showView("monitor"));

// ── REAPER track-template export (topbar) ───────────────────────────

/**
 * Export the console's USB output patch as a REAPER `.RTrackTemplate`:
 * one track per USB channel actually fed by the console, armed to record
 * from the matching hardware input. Declared stereo pairs become stereo
 * tracks. The file is written through the main process (save dialog).
 */
async function exportReaperTemplate(): Promise<void> {
  let snapshot: SnapshotPayload;
  try {
    snapshot = await window.sq.getSnapshot();
  } catch {
    setMessage("Не удалось получить роутинг", "error");
    return;
  }
  const tracks = buildReaperTracks(snapshot);
  if (!tracks.length) {
    setMessage("Нет каналов, назначенных на USB", "error");
    return;
  }
  const content = buildReaperTrackTemplate(tracks);
  const scene = state.currentSceneName ? ` ${state.currentSceneName}` : "";
  const defaultName = `${todayStr()}${scene} SQ multitrack.RTrackTemplate`;
  const res = await window.sq.exportFile(
    content,
    defaultName,
    "REAPER Track Template",
    "RTrackTemplate"
  );
  if (res.ok) {
    setMessage(`REAPER: сохранено ${tracks.length} трек(ов)`, "info");
  } else if (!res.canceled) {
    setMessage(res.error || "Ошибка записи файла", "error");
  }
}

elementRefs.exportReaperBtn.addEventListener("click", exportReaperTemplate);
