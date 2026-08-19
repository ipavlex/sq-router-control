"use strict";
/* SQ Router Control — entry point.
 * Bootstraps the dashboard, wires the console event stream to the tab
 * modules, and handles view switching. Talks to the main process
 * exclusively through the `window.sq` bridge. */

(function () {
  const { els, state, utils } = SQ;

  // ── dashboard bootstrap ─────────────────────────────────────────────

  function enterDashboard(version, spec, host) {
    utils.setLoading(false);
    utils.showScreen("dash");
    const v = version || {};
    els.topbarTitle.textContent = (spec && spec.name) || v.modelName || "SQ";
    els.topbarSub.textContent = `${host} · FW ${v.fwA ?? "?"}.${v.fwB ?? "?"}${
      v.build !== undefined ? "." + v.build : ""
    }`;
    state.modelSpec = spec || null;
    state.currentSceneName = null;

    SQ.routing.reset();
    SQ.monitor.reset();
    SQ.log.clear();

    utils.updateSceneHint();
    utils.showView("routing");
  }

  // ── console event stream ────────────────────────────────────────────

  window.sq.onStatus((p) => {
    // Keep model spec in sync in case it arrives via a status update.
    if (p.spec) state.modelSpec = p.spec;
    if (!p.connected) {
      // unexpected drop
      if (!els.dashScreen.hidden) {
        utils.showScreen("connect");
        state.modelSpec = null;
        utils.setMsg("Соединение с пультом разорвано.", "error");
      }
    }
  });

  window.sq.onRouting((snap) => {
    SQ.routing.onRoutingSnapshot(snap);
    SQ.monitor.updateChannelNames(snap.inputs);
    SQ.log.updateStat(snap);
    state.currentSceneName = snap.currentSceneName ?? null;
    utils.updateSceneHint();
  });

  window.sq.onInitialState(() => {
    // Initial fill complete — freeze the Input Patching snapshot from now on.
    SQ.routing.freezeEditTable();
  });

  window.sq.onLog((p) => SQ.log.pushLog(p.level, p.msg));

  // ── view switching (routing / log / monitor) ────────────────────────

  els.logBtn.addEventListener("click", () => {
    const onLog = !els.viewLog.hidden;
    utils.showView(onLog ? "routing" : "log");
    if (!onLog) els.log.scrollTop = els.log.scrollHeight;
  });
  els.routingBtn.addEventListener("click", () => utils.showView("routing"));
  els.monitorBtn.addEventListener("click", () => utils.showView("monitor"));

  // ── init ─────────────────────────────────────────────────────────────

  window.addEventListener("error", (e) => {
    console.error("RENDERER ERROR:", e.error ? e.error.stack : e.message);
  });
  utils.renderRecent();
  const recent = utils.getRecent();
  if (recent.length) {
    els.ip.value = recent[0];
  }
  els.ip.focus();

  SQ.renderer = { enterDashboard };
})();