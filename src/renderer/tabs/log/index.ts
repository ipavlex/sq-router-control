/**
 * SQ Router Control — Log tab.
 * Frame/event log and the routing update stat.
 */
import { elementRefs, fmtTime, todayStr } from "../../core/utils";
import type { LogLevel, SnapshotPayload } from "../../../shared/ipc";

let logLineCount = 0;
const MAX_LOG_LINES = 400;

/** When true, lines that carry `raw` hex render the bytes instead of the text. */
let rawMode = false;

function span(className: string, text: string): HTMLSpanElement {
  const el = document.createElement("span");
  el.className = className;
  el.textContent = text;
  return el;
}

/** Text shown for a line: its raw hex when in raw mode and available, else parsed. */
function displayText(line: HTMLElement): string {
  const raw = line.dataset.raw;
  return rawMode && raw ? raw : line.dataset.parsed ?? "";
}

function appendLine(line: HTMLElement): void {
  elementRefs.log.appendChild(line);
  logLineCount++;
  while (logLineCount > MAX_LOG_LINES) {
    if (elementRefs.log.firstChild) elementRefs.log.removeChild(elementRefs.log.firstChild);
    logLineCount--;
  }
  elementRefs.log.scrollTop = elementRefs.log.scrollHeight;
}

export function pushLog(level: LogLevel, msg: string, raw?: string): void {
  const line = document.createElement("div");
  line.className = "line";
  line.dataset.parsed = msg;
  if (raw) line.dataset.raw = raw;
  line.append(
    span("ts", fmtTime()),
    span(`lvl ${level}`, level.toUpperCase()),
    span("msg", displayText(line))
  );
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
  const text = `——— метка №${markCount} ———`;
  const line = document.createElement("div");
  line.className = "line mark";
  line.dataset.parsed = text;
  line.append(span("ts", fmtTime()), span("lvl mark", "MARK"), span("msg", text));
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

/**
 * Serialize the visible feed to plain text — one line per entry, in the same
 * `[HH:MM:SS] [LEVEL] message` shape the panel shows. The DOM is the source of
 * truth, so the file matches exactly what is on screen (including marks and the
 * FIFO-trimmed window).
 */
function buildLogText(): string {
  const lines = elementRefs.log.querySelectorAll<HTMLElement>(".line");
  const out: string[] = [];
  for (const line of Array.from(lines)) {
    const ts = line.querySelector<HTMLElement>(".ts")?.textContent ?? "";
    const lvl = line.querySelector<HTMLElement>(".lvl")?.textContent ?? "";
    const msg = line.querySelector<HTMLElement>(".msg")?.textContent ?? "";
    out.push(`[${ts}] ${lvl.padEnd(5)} ${msg}`.trimEnd());
  }
  return out.join("\n");
}

async function saveLogToFile(): Promise<void> {
  const content = buildLogText();
  if (!content) {
    pushLog("warn", "Журнал пуст — нечего сохранять.");
    return;
  }
  const res = await window.sq.exportFile(
    content,
    `${todayStr()} SQ log.txt`,
    "Text",
    "txt"
  );
  if (res.ok) {
    pushLog("ok", `Журнал сохранён: ${res.path ?? ""}`.trim());
  } else if (!res.canceled) {
    pushLog("error", res.error || "Не удалось сохранить журнал.");
  }
}

/** Render every line from its current mode (parsed text ↔ raw hex). */
function applyLogMode(): void {
  const lines = elementRefs.log.querySelectorAll<HTMLElement>(".line");
  for (const line of Array.from(lines)) {
    const msgEl = line.querySelector<HTMLElement>(".msg");
    if (msgEl) msgEl.textContent = displayText(line);
  }
  elementRefs.log.classList.toggle("raw-mode", rawMode);
  elementRefs.log.scrollTop = elementRefs.log.scrollHeight;
}

/** Toggle between parsed text (default) and raw hex bytes. */
elementRefs.logRawToggle.addEventListener("click", () => {
  rawMode = elementRefs.logRawToggle.getAttribute("aria-pressed") !== "true";
  elementRefs.logRawToggle.setAttribute("aria-pressed", String(rawMode));
  elementRefs.logRawToggle.classList.toggle("active", rawMode);
  applyLogMode();
});

elementRefs.clearLog.addEventListener("click", clear);
elementRefs.markLog.addEventListener("click", mark);
elementRefs.saveLog.addEventListener("click", saveLogToFile);

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
