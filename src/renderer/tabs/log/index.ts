/**
 * SQ Router Control — Log tab.
 * Frame/event log and the routing update stat.
 */
import { elementRefs, escapeHtml, fmtTime } from "../../core/utils";
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
  elementRefs.log.appendChild(line);
  logLineCount++;
  while (logLineCount > MAX_LOG_LINES) {
    if (elementRefs.log.firstChild) elementRefs.log.removeChild(elementRefs.log.firstChild);
    logLineCount--;
  }
  elementRefs.log.scrollTop = elementRefs.log.scrollHeight;
}

export function clear(): void {
  elementRefs.log.innerHTML = "";
  logLineCount = 0;
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
