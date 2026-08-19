/**
 * SQ Router Control — connection screen.
 * Connect / demo / disconnect / refresh flows.
 */
import { elementRefs, state, addRecent, isValidHost, setLoading, setMessage, showScreen, updateSceneHint } from "./utils";
import { renderInputs, syncEditInputs } from "./tabs/routing";
import { updateStat } from "./tabs/log";
import { enterDashboard } from "./dashboard";

let demoStarting = false;

export async function doStartDemo(): Promise<void> {
  if (demoStarting) return;
  demoStarting = true;
  elementRefs.demoBtn.disabled = true;
  setMessage("", "");
  try {
    const res = await window.sq.startDemo();
    if (res && res.ok) {
      state.isDemoMode = true;
      enterDashboard(res.version, res.spec ?? null, "demo");
      await doRefresh();
    } else {
      setMessage((res && res.error) || "Не удалось запустить демо.", "error");
    }
  } catch (err) {
    setMessage(err instanceof Error ? err.message : String(err), "error");
  } finally {
    demoStarting = false;
  }
}

export async function doConnect(): Promise<void> {
  const host = elementRefs.ip.value.trim();
  const port = Number(elementRefs.port.value) || undefined;

  if (!isValidHost(host)) {
    setMessage("Введите корректный IP-адрес или имя хоста.", "error");
    elementRefs.ip.focus();
    return;
  }

  setMessage("", "");
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
      setMessage((res && res.error) || "Не удалось подключиться.", "error");
    }
  } catch (err) {
    setLoading(false);
    setMessage(err instanceof Error ? err.message : String(err), "error");
  }
}

export async function doDisconnect(): Promise<void> {
  await window.sq.disconnect();
  setMessage("", "");
  elementRefs.ip.value = "";
  showScreen("connect");
}

export async function doRefresh(): Promise<void> {
  // In demo mode "Обновить" regenerates a completely new simulated routing
  // (different names, stereo pairs and patching) instead of re-reading state.
  const snapshot = state.isDemoMode
    ? await window.sq.demoRefresh()
    : await window.sq.getSnapshot();
  renderInputs(snapshot.inputs);
  // The Input Patching table is a startup snapshot — a manual refresh must not
  // re-sync it either (selectors stay active for editing).
  syncEditInputs(snapshot.inputs, snapshot.stereoPairs);
  updateStat(snapshot);
  state.currentSceneName = snapshot.currentSceneName ?? null;
  updateSceneHint();
}

// ── bindings ─────────────────────────────────────────────────────────
elementRefs.connectBtn.addEventListener("click", doConnect);
elementRefs.demoBtn.addEventListener("click", doStartDemo);
elementRefs.ip.addEventListener("keydown", (e: KeyboardEvent) => {
  if (e.key === "Enter") doConnect();
});
elementRefs.port.addEventListener("keydown", (e: KeyboardEvent) => {
  if (e.key === "Enter") doConnect();
});
elementRefs.disconnectBtn.addEventListener("click", doDisconnect);
elementRefs.requestBtn.addEventListener("click", async () => {
  elementRefs.requestBtn.disabled = true;
  try {
    if (state.isDemoMode) {
      // Demo: regenerate a completely new simulated routing.
      await doRefresh();
    } else {
      // Real console: ask for a fresh full dump.
      await window.sq.requestDump();
    }
  } finally {
    setTimeout(() => (elementRefs.requestBtn.disabled = false), 600);
  }
});
