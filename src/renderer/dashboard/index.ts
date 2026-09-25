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
import type { LogPayload, ModelSpec, SnapshotPayload, StatusPayload, VersionInfo } from "../../shared/ipc";

export function enterDashboard(
  version: VersionInfo | undefined,
  spec: ModelSpec | null,
  host: string
): void {
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

window.sq.onStatus((p: StatusPayload) => {
  // Keep model spec in sync in case it arrives via a status update.
  if (p.spec) state.modelSpec = p.spec;
  if (!p.connected) {
    routing.clearMeters();
    monitor.clearMeters();
    // unexpected drop
    if (!elementRefs.dashScreen.hidden) {
      showScreen("connect");
      state.modelSpec = null;
      setMessage("Соединение с пультом разорвано.", "error");
    }
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

window.sq.onLog((p: LogPayload) => log.pushLog(p.level, p.msg));

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
