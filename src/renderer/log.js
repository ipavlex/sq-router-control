"use strict";
/* SQ Router Control — Log tab.
 * Frame/event log and the routing update stat. */

(function () {
  const { els, utils } = SQ;

  let logLineCount = 0;
  const MAX_LOG_LINES = 400;

  function pushLog(level, msg) {
    const line = document.createElement("div");
    line.className = "line";
    line.innerHTML =
      `<span class="ts">${utils.fmtTime()}</span>` +
      `<span class="lvl ${level}">${level.toUpperCase()}</span>` +
      `<span class="msg">${utils.escapeHtml(msg)}</span>`;
    els.log.appendChild(line);
    logLineCount++;
    while (logLineCount > MAX_LOG_LINES) {
      if (els.log.firstChild) els.log.removeChild(els.log.firstChild);
      logLineCount--;
    }
    els.log.scrollTop = els.log.scrollHeight;
  }

  function clear() {
    els.log.innerHTML = "";
    logLineCount = 0;
    els.updateStat.textContent = "";
  }

  /** Show routing update counters in the log panel header. */
  function updateStat(snap) {
    const parts = [];
    parts.push(`обновлений: ${snap.updates}`);
    if (snap.routingBlockBytes) parts.push(`routing block: ${snap.routingBlockBytes} B`);
    els.updateStat.textContent = parts.join(" · ");
  }

  els.clearLog.addEventListener("click", clear);

  SQ.log = { pushLog, clear, updateStat };
})();