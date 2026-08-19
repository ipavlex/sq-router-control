/**
 * SQ Router Control — dashboard wiring.
 * Boots the dashboard, subscribes to the console event stream and routes it
 * to the tab modules, and handles view switching. The renderer entry point
 * imports this module for its side effects.
 */
import { els, state, setLoading, setMsg, showScreen, showView, updateSceneHint } from "./utils";
import * as routing from "./routing";
import * as monitor from "./monitor";
import * as log from "./log";
import type { LogPayload, ModelSpec, SnapshotPayload, StatusPayload, VersionInfo } from "../shared/ipc";

export function enterDashboard(
  version: VersionInfo | undefined,
  spec: ModelSpec | null,
  host: string
): void {
  setLoading(false);
  showScreen("dash");
  const v = version;
  els.topbarTitle.textContent = (spec && spec.name) || v?.modelName || "SQ";
  els.topbarSub.textContent = `${host} · FW ${v?.fwA ?? "?"}.${v?.fwB ?? "?"}${
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
    // unexpected drop
    if (!els.dashScreen.hidden) {
      showScreen("connect");
      state.modelSpec = null;
      setMsg("Соединение с пультом разорвано.", "error");
    }
  }
});

window.sq.onRouting((snap: SnapshotPayload) => {
  routing.onRoutingSnapshot(snap);
  monitor.updateChannelNames(snap.inputs);
  log.updateStat(snap);
  state.currentSceneName = snap.currentSceneName ?? null;
  updateSceneHint();
});

window.sq.onInitialState(() => {
  // Initial fill complete — freeze the Input Patching snapshot from now on.
  routing.freezeEditTable();
});

window.sq.onLog((p: LogPayload) => log.pushLog(p.level, p.msg));

// ── view switching (routing / log / monitor) ────────────────────────

els.logBtn.addEventListener("click", () => {
  const onLog = !els.viewLog.hidden;
  showView(onLog ? "routing" : "log");
  if (!onLog) els.log.scrollTop = els.log.scrollHeight;
});
els.routingBtn.addEventListener("click", () => showView("routing"));
els.monitorBtn.addEventListener("click", () => showView("monitor"));
