/**
 * SQ Router Control — connection screen module.
 * Connect / demo / disconnect / refresh flows.
 */
import { elementRefs, state, addRecent, isValidHost, setLoading, setMessage, showScreen, updateSceneHint } from "../core/utils";
import { renderInputs, syncEditInputs } from "../tabs/routing";
import { updateStat } from "../tabs/log";
import { enterDashboard, dismissReconnectUi } from "../dashboard";
import type { DiscoveredConsole } from "../../shared/ipc";

let demoStarting = false;

// ── Console discovery (CN-C1) ────────────────────────────────────────
let discovering = false;
/** Found consoles keyed by host:port, so streamed hits dedupe. */
const discovered = new Map<string, DiscoveredConsole>();

function setDiscoverStatus(text: string, kind?: "error" | "info"): void {
  const el = elementRefs.discoverStatus;
  if (!text) {
    el.hidden = true;
    el.textContent = "";
    return;
  }
  el.hidden = false;
  el.textContent = text;
  el.className = "hint discover-status" + (kind ? " " + kind : "");
}

function renderDiscovered(): void {
  const list = [...discovered.values()];
  elementRefs.discoverList.hidden = list.length === 0;
  elementRefs.discoverList.innerHTML = "";
  for (const c of list) {
    const item = document.createElement("button");
    item.type = "button";
    item.className = "discover-item";
    const name = document.createElement("span");
    name.className = "discover-name";
    name.textContent = c.modelName || "SQ";
    const addr = document.createElement("span");
    addr.className = "discover-addr";
    addr.textContent = `${c.host}:${c.port}${c.fw ? ` · FW ${c.fw}` : ""}`;
    item.append(name, addr);
    item.addEventListener("click", () => {
      elementRefs.ip.value = c.host;
      elementRefs.port.value = String(c.port);
      elementRefs.ip.focus();
      setMessage("", "");
    });
    elementRefs.discoverList.appendChild(item);
  }
}

async function doDiscover(): Promise<void> {
  if (discovering) return;
  discovering = true;
  discovered.clear();
  renderDiscovered();
  elementRefs.discoverBtn.disabled = true;
  elementRefs.discoverCancel.hidden = false;
  setDiscoverStatus("Поиск пультов в локальной сети…");
  try {
    const res = await window.sq.discoverConsoles();
    if (!res.ok) {
      setDiscoverStatus(res.error || "Не удалось выполнить поиск.", "error");
    } else if (res.cancelled) {
      setDiscoverStatus(`Поиск отменён. Найдено: ${discovered.size}.`);
    } else if (res.subnets.length === 0) {
      setDiscoverStatus(
        "Активные локальные сети не найдены. Подключите компьютер к сети или введите адрес вручную.",
        "error"
      );
    } else {
      setDiscoverStatus(
        discovered.size
          ? `Найдено пультов: ${discovered.size}.`
          : "Пульты не найдены. Проверьте, что пульт включён и находится в той же подсети."
      );
    }
  } catch (err) {
    setDiscoverStatus(err instanceof Error ? err.message : String(err), "error");
  } finally {
    discovering = false;
    elementRefs.discoverBtn.disabled = false;
    elementRefs.discoverCancel.hidden = true;
  }
}

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
  dismissReconnectUi();
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
elementRefs.discoverBtn.addEventListener("click", doDiscover);
elementRefs.discoverCancel.addEventListener("click", () => {
  window.sq.cancelDiscovery();
});
// Streamed discovery hits — keep the list live while the sweep runs.
window.sq.onConsoleFound((c) => {
  discovered.set(`${c.host}:${c.port}`, c);
  renderDiscovered();
  if (discovering) setDiscoverStatus(`Поиск… найдено: ${discovered.size}`);
});
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
