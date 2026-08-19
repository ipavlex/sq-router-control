/**
 * SQ Router Control — dashboard module.
 * Boots the dashboard, subscribes to the console event stream and routes it
 * to the tab modules, and handles view switching. The renderer entry point
 * imports this module for its side effects.
 */
import { elementRefs, state, setLoading, setMessage, showScreen, showView, updateSceneHint } from "../utils";
import * as routing from "../tabs/routing";
import * as monitor from "../tabs/monitor";
import * as log from "../tabs/log";
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
  log.updateStat(snapshot);
  state.currentSceneName = snapshot.currentSceneName ?? null;
  updateSceneHint();
});

window.sq.onInitialState(() => {
  // Initial fill complete — freeze the Input Patching snapshot from now on.
  routing.freezeEditTable();
});

window.sq.onLog((p: LogPayload) => log.pushLog(p.level, p.msg));

// ── view switching (routing / log / monitor) ────────────────────────

elementRefs.logBtn.addEventListener("click", () => {
  const onLog = !elementRefs.viewLog.hidden;
  showView(onLog ? "routing" : "log");
  if (!onLog) elementRefs.log.scrollTop = elementRefs.log.scrollHeight;
});
elementRefs.routingBtn.addEventListener("click", () => showView("routing"));
elementRefs.monitorBtn.addEventListener("click", () => showView("monitor"));