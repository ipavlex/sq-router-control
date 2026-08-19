/**
 * SQ Router Control — Log tab.
 * Frame/event log and the routing update stat.
 */
import { els, escapeHtml, fmtTime } from "../../utils";
import type { LogLevel, SnapshotPayload } from "../../../shared/ipc";

let logLineCount = 0;
const MAX_LOG_LINES = 400;

export function pushLog(level: LogLevel, msg: string): void {
  const line = document.createElement("div");
  line.className = "line";
  line.innerHTML =
    `<span class="ts">${fmtTime()}</span>` +
    `<span class="lvl ${level}">${level.toUpperCase()}</span>` +
    `<span class="msg">${escapeHtml(msg)}</span>`;
  els.log.appendChild(line);
  logLineCount++;
  while (logLineCount > MAX_LOG_LINES) {
    if (els.log.firstChild) els.log.removeChild(els.log.firstChild);
    logLineCount--;
  }
  els.log.scrollTop = els.log.scrollHeight;
}

export function clear(): void {
  els.log.innerHTML = "";
  logLineCount = 0;
  els.updateStat.textContent = "";
}

/** Show routing update counters in the log panel header. */
export function updateStat(snap: SnapshotPayload): void {
  const parts: string[] = [];
  parts.push(`обновлений: ${snap.updates}`);
  if (snap.routingBlockBytes) parts.push(`routing block: ${snap.routingBlockBytes} B`);
  els.updateStat.textContent = parts.join(" · ");
}

els.clearLog.addEventListener("click", clear);
