#!/usr/bin/env -S npx tsx
/**
 * sq-dump — standalone console dump CLI (no Electron).
 *
 * Verification workflow for docs/VERIFY-STEREO-MODES.md:
 *
 *   1. npx tsx tools/sq-dump.ts capture 192.168.1.30 --label baseline
 *   2. change exactly ONE setting on the console (e.g. break Matrix 3 to mono)
 *   3. npx tsx tools/sq-dump.ts capture 192.168.1.30 --label matrix3-mono
 *   4. npx tsx tools/sq-dump.ts diff pd-dumps/pd-*-baseline.bin pd-dumps/pd-*-matrix3-mono.bin
 *
 * Commands:
 *   capture <host> [port]  connect, wait for the ParamData flood, save a
 *                          timestamped .bin dump + .txt report, disconnect
 *   diff <a.bin> <b.bin>   byte diff with decoded offsets
 *   info <file.bin>        full stereo/link diagnostics report
 *
 * Options for capture: --out <dir> (default pd-dumps), --label <name>,
 * --timeout <ms> (default 15000).
 */
import { mkdirSync, readFileSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import { Connection } from "../src/main/transport/connection";
import { analyzeStereoTable } from "../src/main/paramdata-diagnostics";
import { diffParamData } from "../src/main/paramdata-diff";
import { decodeLinkedBuses, decodeMixModes } from "../src/main/stereo-links";

function usage(): never {
  console.log(`sq-dump — SQ console ParamData capture/diff CLI

  npx tsx tools/sq-dump.ts capture <host> [port] [--out dir] [--label name] [--timeout ms]
  npx tsx tools/sq-dump.ts diff <a.bin> <b.bin>
  npx tsx tools/sq-dump.ts info <file.bin>`);
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

/** Connect, wait for the first large ParamData blob, save it with a report. */
async function capture(
  host: string,
  port: number | undefined,
  outDir: string,
  label: string | undefined,
  timeoutMs: number
): Promise<void> {
  const conn = new Connection({ host, port });
  const blob = await new Promise<Buffer>((resolve, reject) => {
    const fail = (e: Error): void => {
      clearTimeout(timer);
      conn.disconnect();
      reject(e);
    };
    const timer = setTimeout(
      () => fail(new Error(`no ParamData within ${timeoutMs} ms (is the console at ${host}?`) ),
      timeoutMs
    );
    conn.on("error", fail);
    // Only the large blob (~97 KB) is the full ParamData; smaller frames of
    // the same subtype are ignored.
    conn.on("paramData", (payload: Buffer) => {
      if (payload.length < 90000) return;
      clearTimeout(timer);
      resolve(payload);
    });
    conn
      .connect()
      .then((v) => console.log(`connected: ${v.modelName} (fw ${v.fwA}.${v.fwB})`))
      .catch(fail);
  });
  conn.disconnect();

  mkdirSync(outDir, { recursive: true });
  const base = `pd-${timestamp()}${label ? `-${label}` : ""}`;
  const binPath = join(outDir, `${base}.bin`);
  const txtPath = join(outDir, `${base}.txt`);
  writeFileSync(binPath, blob);
  writeFileSync(txtPath, analyzeStereoTable(blob).report, "utf8");

  // Short digest right in the terminal.
  const modes = decodeMixModes(blob);
  const stereo = modes.filter((m) => m === 1).length;
  const linked = decodeLinkedBuses(blob)
    .map((b) => `0x${b.toString(16)}`)
    .join(", ");
  console.log(`saved: ${binPath}`);
  console.log(`report: ${txtPath}`);
  console.log(`blob: ${blob.length} bytes`);
  console.log(`mix modes: ${stereo}/12 stereo slots (${modes.join("")})`);
  console.log(`encoding-A linked buses: ${linked || "none"}`);
}

function main(): void {
  const [cmd, ...args] = process.argv.slice(2);
  if (cmd === "capture") {
    const host = args[0];
    if (!host) usage();
    let port: number | undefined;
    let outDir = "pd-dumps";
    let label: string | undefined;
    let timeoutMs = 15000;
    for (let i = 1; i < args.length; i++) {
      if (args[i] === "--out") outDir = args[++i];
      else if (args[i] === "--label") label = args[++i];
      else if (args[i] === "--timeout") timeoutMs = Number(args[++i]);
      else if (/^\d+$/.test(args[i])) port = Number(args[i]);
      else usage();
    }
    capture(host, port, outDir, label, timeoutMs).catch((e: Error) => {
      console.error(`error: ${e.message}`);
      process.exit(1);
    });
  } else if (cmd === "diff") {
    const [a, b] = args;
    if (!a || !b) usage();
    console.log(diffParamData(readFileSync(a), readFileSync(b)));
  } else if (cmd === "info") {
    const [f] = args;
    if (!f) usage();
    console.log(analyzeStereoTable(readFileSync(f)).report);
  } else {
    usage();
  }
}

main();
