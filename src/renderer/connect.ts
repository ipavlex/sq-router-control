/**
 * SQ Router Control — connection screen.
 * Connect / demo / disconnect / refresh flows.
 */
import { els, state, addRecent, isValidHost, setLoading, setMsg, showScreen, updateSceneHint } from "./utils";
import { renderInputs, syncEditInputs } from "./tabs/routing";
import { updateStat } from "./tabs/log";
import { enterDashboard } from "./dashboard";

let demoStarting = false;

export async function doStartDemo(): Promise<void> {
  if (demoStarting) return;
  demoStarting = true;
  els.demoBtn.disabled = true;
  setMsg("", "");
  try {
    const res = await window.sq.startDemo();
    if (res && res.ok) {
      state.isDemoMode = true;
      enterDashboard(res.version, res.spec ?? null, "demo");
      await doRefresh();
    } else {
      setMsg((res && res.error) || "Не удалось запустить демо.", "error");
    }
  } catch (err) {
    setMsg(err instanceof Error ? err.message : String(err), "error");
  } finally {
    demoStarting = false;
  }
}

export async function doConnect(): Promise<void> {
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
      state.isDemoMode = false;
      addRecent(host);
      enterDashboard(res.version, res.spec ?? null, host);
      await doRefresh();
    } else {
      setLoading(false);
      setMsg((res && res.error) || "Не удалось подключиться.", "error");
    }
  } catch (err) {
    setLoading(false);
    setMsg(err instanceof Error ? err.message : String(err), "error");
  }
}

export async function doDisconnect(): Promise<void> {
  await window.sq.disconnect();
  setMsg("", "");
  els.ip.value = "";
  showScreen("connect");
}

export async function doRefresh(): Promise<void> {
  // In demo mode "Обновить" regenerates a completely new simulated routing
  // (different names, stereo pairs and patching) instead of re-reading state.
  const snap = state.isDemoMode
    ? await window.sq.demoRefresh()
    : await window.sq.getSnapshot();
  renderInputs(snap.inputs);
  // The Input Patching table is a startup snapshot — a manual refresh must not
  // re-sync it either (selectors stay active for editing).
  syncEditInputs(snap.inputs, snap.stereoPairs);
  updateStat(snap);
  state.currentSceneName = snap.currentSceneName ?? null;
  updateSceneHint();
}

// ── bindings ─────────────────────────────────────────────────────────
els.connectBtn.addEventListener("click", doConnect);
els.demoBtn.addEventListener("click", doStartDemo);
els.ip.addEventListener("keydown", (e: KeyboardEvent) => {
  if (e.key === "Enter") doConnect();
});
els.port.addEventListener("keydown", (e: KeyboardEvent) => {
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
