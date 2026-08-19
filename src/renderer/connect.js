"use strict";
/* SQ Router Control — connection screen.
 * Connect / demo / disconnect / refresh flows. */

(function () {
  const { els, state, utils } = SQ;

  let demoStarting = false;

  async function doStartDemo() {
    if (demoStarting) return;
    demoStarting = true;
    els.demoBtn.disabled = true;
    utils.setMsg("", "");
    try {
      const res = await window.sq.startDemo();
      if (res && res.ok) {
        state.isDemoMode = true;
        SQ.renderer.enterDashboard(res.version, res.spec, "demo");
        await doRefresh();
      } else {
        utils.setMsg((res && res.error) || "Не удалось запустить демо.", "error");
      }
    } catch (err) {
      utils.setMsg((err && err.message) || String(err), "error");
    } finally {
      demoStarting = false;
    }
  }

  async function doConnect() {
    const host = els.ip.value.trim();
    const port = Number(els.port.value) || undefined;

    if (!utils.isValidHost(host)) {
      utils.setMsg("Введите корректный IP-адрес или имя хоста.", "error");
      els.ip.focus();
      return;
    }

    utils.setMsg("", "");
    utils.setLoading(true);

    try {
      const res = await window.sq.connect(host, port);
      if (res && res.ok) {
        state.isDemoMode = false;
        utils.addRecent(host);
        SQ.renderer.enterDashboard(res.version, res.spec, host);
        await doRefresh();
      } else {
        utils.setLoading(false);
        utils.setMsg((res && res.error) || "Не удалось подключиться.", "error");
      }
    } catch (err) {
      utils.setLoading(false);
      utils.setMsg((err && err.message) || String(err), "error");
    }
  }

  async function doDisconnect() {
    await window.sq.disconnect();
    utils.setMsg("", "");
    els.ip.value = "";
    utils.showScreen("connect");
  }

  async function doRefresh() {
    // In demo mode "Обновить" regenerates a completely new simulated routing
    // (different names, stereo pairs and patching) instead of re-reading state.
    const snap = state.isDemoMode
      ? await window.sq.demoRefresh()
      : await window.sq.getSnapshot();
    SQ.routing.renderInputs(snap.inputs);
    // The Input Patching table is a startup snapshot — a manual refresh must not
    // re-sync it either (selectors stay active for editing).
    SQ.routing.syncEditInputs(snap.inputs, snap.stereoPairs);
    SQ.log.updateStat(snap);
    state.currentSceneName = snap.currentSceneName ?? null;
    utils.updateSceneHint();
  }

  // ── bindings ─────────────────────────────────────────────────────────
  els.connectBtn.addEventListener("click", doConnect);
  els.demoBtn.addEventListener("click", doStartDemo);
  els.ip.addEventListener("keydown", (e) => {
    if (e.key === "Enter") doConnect();
  });
  els.port.addEventListener("keydown", (e) => {
    if (e.key === "Enter") doConnect();
  });
  els.disconnectBtn.addEventListener("click", doDisconnect);
  els.requestBtn.addEventListener("click", async () => {
    els.requestBtn.disabled = true;
    try {
      if (state.isDemoMode) {
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

  SQ.connect = { doConnect, doStartDemo, doDisconnect, doRefresh };
})();