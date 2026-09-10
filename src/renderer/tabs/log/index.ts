/**
 * SQ Router Control — Log tab.
 * Frame/event log and the routing update stat.
 */
import { elementRefs, escapeHtml, fmtTime } from "../../core/utils";
import type { LogLevel, SnapshotPayload } from "../../../shared/ipc";

let logLineCount = 0;
const MAX_LOG_LINES = 400;

function appendLine(line: HTMLElement): void {
  elementRefs.log.appendChild(line);
  logLineCount++;
  while (logLineCount > MAX_LOG_LINES) {
    if (elementRefs.log.firstChild) elementRefs.log.removeChild(elementRefs.log.firstChild);
    logLineCount--;
  }
  elementRefs.log.scrollTop = elementRefs.log.scrollHeight;
}

export function pushLog(level: LogLevel, msg: string): void {
  const line = document.createElement("div");
  line.className = "line";
  line.innerHTML =
    `<span class="ts">${fmtTime()}</span>` +
    `<span class="lvl ${level}">${level.toUpperCase()}</span>` +
    `<span class="msg">${escapeHtml(msg)}</span>`;
  appendLine(line);
}

let markCount = 0;

/**
 * Insert a visible separator into the log. Used to bracket experiment steps
 * on a real console ("pressed M right when the signal moved to Mix 5"), so
 * meter-packet lines can be correlated with the actions afterwards.
 */
export function mark(): void {
  markCount++;
  const line = document.createElement("div");
  line.className = "line mark";
  line.innerHTML =
    `<span class="ts">${fmtTime()}</span>` +
    `<span class="lvl mark">MARK</span>` +
    `<span class="msg">——— метка №${markCount} ———</span>`;
  appendLine(line);
}

export function clear(): void {
  elementRefs.log.innerHTML = "";
  logLineCount = 0;
  markCount = 0;
  elementRefs.updateStat.textContent = "";
}

/** Show routing update counters in the log panel header. */
export function updateStat(snapshot: SnapshotPayload): void {
  const parts: string[] = [];
  parts.push(`обновлений: ${snapshot.updates}`);
  if (snapshot.routingBlockBytes) parts.push(`routing block: ${snapshot.routingBlockBytes} B`);
  elementRefs.updateStat.textContent = parts.join(" · ");
}

elementRefs.clearLog.addEventListener("click", clear);
elementRefs.markLog.addEventListener("click", mark);

// M (layout-independent) — drop a mark while the log tab is visible.
window.addEventListener("keydown", (e: KeyboardEvent) => {
  if (elementRefs.viewLog.hidden) return;
  if (e.code !== "KeyM") return;
  const t = e.target as HTMLElement | null;
  if (t instanceof HTMLInputElement || t instanceof HTMLSelectElement || t instanceof HTMLTextAreaElement) {
    return;
  }
  mark();
});
