#!/usr/bin/env -S npx tsx
/**
 * sq-meters — standalone console meter-stream CLI (no Electron).
 *
 * Connects to an SQ console the same way the app does (TCP handshake with
 * the MeterSub UDP-port exchange) and processes the UDP meter stream — the
 * same datagrams Connection feeds into the app's meter decoders
 * (docs/SQ-PROTOCOL.md §8).
 *
 *   1. npx tsx tools/sq-meters.ts watch 192.168.1.30
 *   2. feed signal into ONE known bus on the console
 *   3. undecoded packet shapes print hot slots / change maps — the moving
 *      slot indices reveal where that bus's level lives
 *   4. npx tsx tools/sq-meters.ts capture 192.168.1.30 --label busH
 *   5. npx tsx tools/sq-meters.ts decode meter-dumps/cap-.../meter-packet-0x07-1416B.bin
 *
 * Commands:
 *   watch <host> [port]    live decoded meter view (inputs, Main LR, Mix 1-12)
 *                          plus a first-sight inventory of every packet shape;
 *                          undecoded shapes re-sample every ~4 s (dB snapshot,
 *                          hot slots, change map)
 *   capture <host> [port]  listen for a window and save one raw .bin per
 *                          packet shape (same naming as the app's
 *                          <userData>/diagnostics dumps) + a .txt report
 *   decode <file.bin>      offline analysis of a single raw datagram (works
 *                          with capture output and with the app's diagnostics
 *                          dumps)
 *
 * Packet framing: [0x7F] [id:u8] [len:u16LE] [00 00] [body × len], body is
 * u16 LE values, dBFS = (raw - 0x8000) / 256, floor sentinel 0x1201.
 * Decoded ids: 0x06 (48 inputs × 11 slots), 0x17 (48 input levels),
 * 0x18 (Main LR + Mix 1-12); 0x05 is a keepalive; 0x07/0x09/0x16 are not
 * decoded yet — watch/capture samples are the hunting tools for them.
 *
 * Options:
 *   watch:   --duration <ms> (default 10000), --every <ms> (default 500),
 *            --timeout <ms> (connect handshake, default 10000)
 *   capture: --duration <ms> (default 10000), --timeout <ms>, --out <dir>
 *            (default meter-dumps), --label <name>
 *   decode:  --full (dump every body slot: raw hex + dBFS)
 */
import { mkdirSync, readFileSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import { Connection } from "../src/main/transport/connection";
import {
  MetersPayload,
  decodeMeterMessage,
  formatMeterChanges,
  hotMeterSlots,
  meterSamplePreview,
  rawToDb,
} from "../src/main/meters";

/** Body shapes decoded by the app (meters.ts) — everything else is hunting. */
const DECODED_IDS: Record<number, string> = {
  0x06: "48 inputs × 11 slots (channel detail)",
  0x17: "48 input levels",
  0x18: "40 buses × 6 slots (Main LR + Mix 1-12)",
};

/** Shape of the meterPacketInfo event emitted by Connection (structural). */
interface MeterPacketInfo {
  id: number;
  len: number;
  decoded: boolean;
  sample?: string;
  changes?: string;
  hot?: string;
  raw?: Buffer;
}

/** Per-shape stats collected from the UDP stream. */
interface ShapeStat {
  id: number;
  len: number;
  count: number;
  decoded: boolean;
  keepalive: boolean;
  firstRaw: Buffer | null;
  logged: boolean;
}

function usage(): never {
  console.log(`sq-meters — SQ console UDP meter stream CLI

  npx tsx tools/sq-meters.ts watch <host> [port] [--duration ms] [--every ms] [--timeout ms]
  npx tsx tools/sq-meters.ts capture <host> [port] [--out dir] [--label name] [--duration ms] [--timeout ms]
  npx tsx tools/sq-meters.ts decode <file.bin> [--full]`);
  process.exit(1);
}

function timestamp(): string {
  const d = new Date();
  const p = (n: number, w = 2) => String(n).padStart(w, "0");
  return (
    `${d.getFullYear()}${p(d.getMonth() + 1)}${p(d.getDate())}` +
    `-${p(d.getHours())}${p(d.getMinutes())}${p(d.getSeconds())}`
  );
}

function clock(): string {
  const d = new Date();
  const p = (n: number) => String(n).padStart(2, "0");
  return `${p(d.getHours())}:${p(d.getMinutes())}:${p(d.getSeconds())}`;
}

const sleep = (ms: number): Promise<void> => new Promise((r) => setTimeout(r, ms));

/** "0x07" for a meter packet id, "raw" for non-meter datagrams (id = -1). */
function fmtId(id: number): string {
  return id >= 0 ? `0x${id.toString(16)}` : "raw";
}

/** Parse meter framing, or null for datagrams without it. */
function framing(msg: Buffer): { id: number; len: number; body: Buffer } | null {
  if (msg.length < 6 || msg[0] !== 0x7f) return null;
  const len = msg.readUInt16LE(2);
  const body = msg.subarray(6, 6 + len);
  return body.length === len ? { id: msg[1], len, body } : null;
}

// ── formatting ────────────────────────────────────────────────────────────

/** Non-floor slots as "[3]-12.4 [8]-0.1!" (1-based, "!" on clip), capped. */
function fmtLevels(
  levels: (number | null)[],
  clip?: boolean[],
  max = 12
): string {
  const parts: string[] = [];
  for (let i = 0; i < levels.length && parts.length < max; i++) {
    const d = levels[i];
    if (d == null) continue;
    parts.push(`[${i + 1}]${d.toFixed(1)}${clip?.[i] ? "!" : ""}`);
  }
  return parts.join(" ");
}

/** "L-6.5 R-7.8" with clip marks; "-inf" when both sides sit at the floor. */
function fmtStereo(
  l: number | null | undefined,
  r: number | null | undefined,
  clipL?: boolean,
  clipR?: boolean
): string {
  const parts: string[] = [];
  if (l != null) parts.push(`L${l.toFixed(1)}${clipL ? "!" : ""}`);
  if (r != null) parts.push(`R${r.toFixed(1)}${clipR ? "!" : ""}`);
  return parts.length ? parts.join(" ") : "-inf";
}

/** One compact decoded-meters line: "In: … | LR: … | Mix: 1:… 2:…". */
function fmtPayload(m: MetersPayload): string {
  const seg: string[] = [];
  seg.push(`In: ${fmtLevels(m.inputs, m.clip) || "floor"}`);
  if (m.mainLR !== undefined) {
    seg.push(
      `LR: ${fmtStereo(m.mainLRL, m.mainLRR, m.mainLRClipL, m.mainLRClipR)}`
    );
  }
  if (m.mixes) {
    const mix: string[] = [];
    for (let i = 0; i < m.mixes.length; i++) {
      const l = m.mixesL?.[i] ?? null;
      const r = m.mixesR?.[i] ?? null;
      if (l == null && r == null) continue;
      const cl = m.mixClipL?.[i] || m.mixClipR?.[i];
      mix.push(
        `${i + 1}:${l == null ? "-" : l.toFixed(1)}/${r == null ? "-" : r.toFixed(1)}${cl ? "!" : ""}`
      );
    }
    seg.push(`Mix: ${mix.join(" ") || "floor"}`);
  }
  return seg.join("  |  ");
}

function shapeLine(s: ShapeStat): string {
  const kind = s.keepalive ? "keepalive" : s.decoded ? "decoded" : "undecoded";
  return `  id=${fmtId(s.id)} body=${s.len}B × ${s.count} (${kind})`;
}

// ── shared session plumbing ───────────────────────────────────────────────

let activeConn: Connection | null = null;
process.on("SIGINT", () => {
  console.log("\ninterrupted");
  try {
    activeConn?.disconnect();
  } catch {
    /* ignore */
  }
  process.exit(0);
});

interface SessionHooks {
  /** Fired for every decoded meters payload (merged inputs + mixes). */
  onMeters?: (m: MetersPayload) => void;
  /** Fired on first sight of a shape and for undecoded re-samples. */
  onPacketInfo?: (info: MeterPacketInfo) => void;
}

interface SessionStats {
  total: number;
  decoded: number;
  last: MetersPayload | null;
  shapes: Map<string, ShapeStat>;
}

/** Connect (handshake includes the MeterSub UDP-port exchange) and wire the
 * meter events into per-shape stats. The caller disconnects when done. */
async function openSession(
  host: string,
  port: number | undefined,
  timeoutMs: number,
  hooks: SessionHooks
): Promise<{ conn: Connection; version: { modelName: string; fwA: number; fwB: number }; stats: SessionStats }> {
  const conn = new Connection({ host, port, connectTimeoutMs: timeoutMs });
  const stats: SessionStats = {
    total: 0,
    decoded: 0,
    last: null,
    shapes: new Map(),
  };

  conn.on("meterData", (msg: Buffer) => {
    stats.total++;
    const f = framing(msg);
    const id = f ? f.id : -1;
    const len = f ? f.len : msg.length;
    const key = `${id}:${len}`;
    let s = stats.shapes.get(key);
    if (!s) {
      s = {
        id,
        len,
        count: 0,
        decoded: false,
        keepalive: id === 0x05 && len === 0,
        firstRaw: Buffer.from(msg),
        logged: false,
      };
      stats.shapes.set(key, s);
    }
    s.count++;
  });

  conn.on("meters", (m: MetersPayload) => {
    stats.decoded++;
    stats.last = m;
    hooks.onMeters?.(m);
  });

  conn.on("meterPacketInfo", (info: MeterPacketInfo) => {
    const key = `${info.id}:${info.len}`;
    const s = stats.shapes.get(key);
    if (s) s.decoded = info.decoded;
    hooks.onPacketInfo?.(info);
  });

  const version = await conn.connect();
  activeConn = conn;
  return { conn, version, stats };
}

// ── watch ─────────────────────────────────────────────────────────────────

async function watch(
  host: string,
  port: number | undefined,
  durationMs: number,
  everyMs: number,
  timeoutMs: number
): Promise<void> {
  const { conn, version, stats } = await openSession(host, port, timeoutMs, {
    onPacketInfo: (info) => {
      const s = stats.shapes.get(`${info.id}:${info.len}`);
      const first = !s || !s.logged;
      if (s) s.logged = true;
      if (info.decoded) {
        if (first) console.log(`  shape id=${fmtId(info.id)} body=${info.len}B (decoded)`);
      } else if (first || info.changes) {
        const kind = s?.keepalive ? "keepalive" : "undecoded";
        const bits = [
          info.sample ? `dB ${info.sample}` : "",
          info.hot ? `hot: ${info.hot}` : "",
          info.changes ? `chg: ${info.changes}` : "",
        ]
          .filter(Boolean)
          .join("  ");
        console.log(
          `  shape id=${fmtId(info.id)} body=${info.len}B (${kind})${bits ? `  ${bits}` : ""}`
        );
      }
    },
  });
  console.log(`connected: ${version.modelName} (fw ${version.fwA}.${version.fwB})`);
  console.log(
    `udp local :${conn.localUdpPort} ← mixer announced :${conn.mixerMeterPort} — watching ${durationMs} ms`
  );

  const timer = setInterval(() => {
    console.log(`${clock()} ${stats.last ? fmtPayload(stats.last) : "(no decoded packets yet)"}`);
  }, everyMs);
  await sleep(durationMs);
  clearInterval(timer);
  conn.disconnect();

  console.log(`\ndatagrams: ${stats.total} (decoded payloads: ${stats.decoded})`);
  const sorted = [...stats.shapes.values()].sort((a, b) => a.id - b.id || a.len - b.len);
  for (const s of sorted) console.log(shapeLine(s));
}

// ── capture ───────────────────────────────────────────────────────────────

async function capture(
  host: string,
  port: number | undefined,
  outDir: string,
  label: string | undefined,
  durationMs: number,
  timeoutMs: number
): Promise<void> {
  const { conn, version, stats } = await openSession(host, port, timeoutMs, {});
  console.log(`connected: ${version.modelName} (fw ${version.fwA}.${version.fwB})`);
  console.log(
    `udp local :${conn.localUdpPort} ← mixer announced :${conn.mixerMeterPort} — capturing ${durationMs} ms`
  );

  const progress = setInterval(() => {
    console.log(`  … ${stats.total} datagrams, ${stats.shapes.size} shapes`);
  }, 2000);
  await sleep(durationMs);
  clearInterval(progress);
  conn.disconnect();

  const base = `cap-${timestamp()}${label ? `-${label}` : ""}`;
  const dir = join(outDir, base);
  mkdirSync(dir, { recursive: true });

  const report: string[] = [];
  const now = new Date();
  report.push(`sq-meters capture — ${now.toISOString()}`);
  report.push(`host: ${host}${port ? `:${port}` : ""}   console: ${version.modelName} (fw ${version.fwA}.${version.fwB})`);
  report.push(`listen: ${durationMs} ms   datagrams: ${stats.total}   decoded payloads: ${stats.decoded}`);
  report.push(`udp: local :${conn.localUdpPort} ← mixer announced :${conn.mixerMeterPort}`);
  report.push("");
  report.push("== Shapes ==");
  const sorted = [...stats.shapes.values()].sort((a, b) => a.id - b.id || a.len - b.len);
  const fileByShape = new Map<string, string>();
  for (const s of sorted) {
    const key = `${s.id}:${s.len}`;
    const kind = s.keepalive ? "keepalive" : s.decoded ? "decoded" : "undecoded";
    let file = "-";
    if (s.firstRaw) {
      const name = `meter-packet-${s.id >= 0 ? `0x${s.id.toString(16)}` : "raw"}-${s.len}B.bin`;
      writeFileSync(join(dir, name), s.firstRaw);
      fileByShape.set(key, name);
      file = name;
    }
    report.push(`id=${fmtId(s.id)}  body=${s.len}B  count=${s.count}  ${kind}  raw=${file}`);
  }

  report.push("");
  report.push("== Last decoded payload ==");
  report.push(stats.last ? fmtPayload(stats.last) : "(none received)");

  report.push("");
  report.push("== Undecoded samples (first raw per shape) ==");
  let anyUndecoded = false;
  for (const s of sorted) {
    if (s.decoded || s.keepalive || !s.firstRaw) continue;
    anyUndecoded = true;
    report.push(`id=${fmtId(s.id)} body=${s.len}B (raw=${fileByShape.get(`${s.id}:${s.len}`)}):`);
    const preview = meterSamplePreview(s.firstRaw);
    if (preview) report.push(`  dB: ${preview}`);
    const hot = hotMeterSlots(framing(s.firstRaw)!.body);
    if (hot.length) report.push(`  hot: ${formatMeterChanges(hot)}`);
  }
  if (!anyUndecoded) report.push("(all shapes decoded)");

  const txtPath = join(dir, "report.txt");
  writeFileSync(txtPath, report.join("\n") + "\n", "utf8");

  console.log(`saved: ${dir} (${fileByShape.size} shape files + report.txt)`);
  for (const s of sorted) console.log(shapeLine(s));
}

// ── decode ────────────────────────────────────────────────────────────────

function decodeFile(path: string, full: boolean): void {
  const msg = readFileSync(path);
  console.log(`file: ${path} (${msg.length} bytes)`);
  const f = framing(msg);
  if (!f) {
    console.log("framing: NOT a meter datagram (expected [0x7F] [id:u8] [len:u16LE] [00 00] [body])");
    return;
  }
  console.log(`framing: [0x7F] id=${fmtId(f.id)} len=${f.len}  ✔ body ok`);
  if (f.id === 0x05 && f.len === 0) {
    console.log("status: keepalive (empty body)");
    return;
  }
  const known = DECODED_IDS[f.id];
  if (!known) {
    console.log(`status: undecoded (decoded ids: 0x06=1056B inputs, 0x17=96B input levels, 0x18=480B Main LR+Mix)`);
    const preview = meterSamplePreview(msg);
    if (preview) console.log(`dB preview: ${preview}`);
    const hot = hotMeterSlots(f.body);
    if (hot.length) console.log(`hot slots: ${formatMeterChanges(hot)}`);
  } else {
    console.log(`status: decoded — ${known}`);
    const m = decodeMeterMessage(msg);
    if (m) {
      if (f.id === 0x18) {
        console.log(`Main LR: ${fmtStereo(m.mainLRL, m.mainLRR, m.mainLRClipL, m.mainLRClipR)}`);
        for (let i = 0; i < (m.mixes?.length ?? 0); i++) {
          const cl = m.mixClipL?.[i] || m.mixClipR?.[i];
          console.log(
            `Mix ${i + 1}: ${fmtDb(m.mixesL?.[i])}/${fmtDb(m.mixesR?.[i])}${cl ? "!" : ""}`
          );
        }
      } else {
        console.log(`In: ${fmtLevels(m.inputs, m.clip, m.inputs.length) || "all floor"}`);
      }
    }
  }
  if (full) {
    const n = Math.floor(f.body.length / 2);
    console.log(`body slots: ${n} u16 (raw hex + dBFS)`);
    const row: string[] = [];
    for (let i = 0; i < n; i++) {
      const raw = f.body.readUInt16LE(i * 2);
      row.push(`[${i}]${raw.toString(16).padStart(4, "0")}(${fmtDb(rawToDb(raw))})`);
      if (row.length === 4) {
        console.log(`  ${row.join(" ")}`);
        row.length = 0;
      }
    }
    if (row.length) console.log(`  ${row.join(" ")}`);
  }
}

function fmtDb(d: number | null | undefined): string {
  return d == null ? "-inf" : d.toFixed(1);
}

// ── main ──────────────────────────────────────────────────────────────────

function main(): void {
  const [cmd, ...args] = process.argv.slice(2);
  if (cmd === "watch" || cmd === "capture") {
    const host = args[0];
    if (!host) usage();
    let port: number | undefined;
    let durationMs = 10000;
    let timeoutMs = 10000;
    let everyMs = 500;
    let outDir = "meter-dumps";
    let label: string | undefined;
    for (let i = 1; i < args.length; i++) {
      if (args[i] === "--duration") durationMs = Number(args[++i]);
      else if (args[i] === "--timeout") timeoutMs = Number(args[++i]);
      else if (cmd === "watch" && args[i] === "--every") everyMs = Math.max(100, Number(args[++i]));
      else if (cmd === "capture" && args[i] === "--out") outDir = args[++i];
      else if (cmd === "capture" && args[i] === "--label") label = args[++i];
      else if (/^\d+$/.test(args[i])) port = Number(args[i]);
      else usage();
    }
    const run =
      cmd === "watch"
        ? watch(host, port, durationMs, everyMs, timeoutMs)
        : capture(host, port, outDir, label, durationMs, timeoutMs);
    run.catch((e: Error) => {
      console.error(`error: ${e.message}`);
      process.exit(1);
    });
  } else if (cmd === "decode") {
    const [file] = args;
    if (!file) usage();
    let full = false;
    for (let i = 1; i < args.length; i++) {
      if (args[i] === "--full") full = true;
      else usage();
    }
    decodeFile(file, full);
  } else {
    usage();
  }
}

main();
