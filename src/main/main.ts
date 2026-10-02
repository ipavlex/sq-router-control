/**
 * SQ Router Control — Electron main process.
 *
 * Owns the SQ TCP connection and the routing model, and bridges them to the
 * renderer over IPC. The renderer never touches the network directly.
 */
import { app, BrowserWindow, dialog, ipcMain, Menu } from "electron";
import * as path from "node:path";
import * as fs from "node:fs";
import { Connection, VersionInfo, DspFrame } from "./transport/connection";
import { RoutingModel, InputPatch, OutputPatch, labelToB3, b3ToLabel, MONITOR_LABEL_TO_SOURCE } from "./routing";
import { MixerState } from "./state";
import { modelSpec, SQModelSpec } from "./models";
import { MetersPayload } from "./meters";
import { DemoSession, DEMO_HOST } from "./demo";
import { analyzeStereoTable } from "./paramdata-diagnostics";
import { scanNetwork } from "./discovery";
import type {
  DiscoveredConsole,
  DiscoveryResult,
  ExportFileResult,
  OutputKey,
} from "../shared/ipc";

let mainWindow: BrowserWindow | null = null;

/**
 * Auto-reconnect tuning for unexpected connection drops. Retries use an
 * exponential backoff (1s, 2s, 4s … capped at 30s) and give up after
 * RECONNECT_MAX_ATTEMPTS so the user can retry manually from the connect
 * screen. The renderer shows progress and offers a cancel button.
 */
const RECONNECT_MAX_ATTEMPTS = 8;
const RECONNECT_BASE_DELAY_MS = 1000;
const RECONNECT_MAX_DELAY_MS = 30000;

function reconnectDelay(attempt: number): number {
  return Math.min(RECONNECT_BASE_DELAY_MS * 2 ** (attempt - 1), RECONNECT_MAX_DELAY_MS);
}

/** Space-separated lowercase hex — the log's "raw" view of a frame. */
function hexDump(buf: Buffer): string {
  return Array.from(buf)
    .map((b) => b.toString(16).padStart(2, "0"))
    .join(" ");
}

class SQController {
  private conn: Connection | null = null;
  private model = new RoutingModel();
  /** Live channel state (fader/mute/gain/…) fed by DSP frames + ParamData. */
  private mixer = new MixerState();
  private host = "";
  private port: number | undefined;
  private localInterface = "";
  private statusTimer: NodeJS.Timeout | null = null;

  /** Auto-reconnect after an unexpected drop (only for established sessions). */
  private autoReconnect = false;
  /** 1-based retry counter of the active reconnect sequence (0 = idle). */
  private reconnectAttempt = 0;
  private reconnectTimer: NodeJS.Timeout | null = null;
  /** Invalidates pending reconnect callbacks after cancel / manual reconnect. */
  private reconnectGen = 0;

  /** Non-null while a local-network discovery sweep is running (abort handle). */
  private discoveryAbort: AbortController | null = null;

  // Scene tracking — sceneNames maps sceneId → name; currentSceneId is the
  // most recently recalled scene (null until a recall is observed).
  private sceneNames = new Map<number, string>();
  private currentSceneId: number | null = null;

  /** Fully simulated console session (see demo.ts). Declared after the state
   *  it bridges so its host object can capture the model/mixer/scene refs. */
  private demo = new DemoSession({
    model: this.model,
    mixer: this.mixer,
    sceneNames: this.sceneNames,
    send: (channel, payload) => this.send(channel, payload),
    applyInputPatch: (destB3, source, srcChannel) =>
      this.applyInputPatch(destB3, source, srcChannel),
    getSceneId: () => this.currentSceneId,
    setSceneId: (id) => {
      this.currentSceneId = id;
    },
    snapshot: () => this.snapshot(),
  });

  get connected(): boolean {
    return this.demo.isActive || this.conn?.connected || false;
  }

  get version(): VersionInfo | null {
    return this.demo.isActive ? this.demo.deviceVersion : this.conn?.version ?? null;
  }

  connect(
    host: string,
    port?: number
  ): Promise<
    | { ok: true; version: VersionInfo; spec: SQModelSpec }
    | { ok: false; error: string }
  > {
    // A manual connect supersedes any automatic reconnect sequence.
    this.stopReconnect();
    // Tear down any previous session.
    this.teardown();

    const trimmed = (host || "").trim();
    if (!trimmed) return Promise.resolve({ ok: false, error: "Empty host" });

    this.host = trimmed;
    this.port = port;
    this.model.reset();
    this.mixer.reset();
    this.resetSceneState();
    const conn = new Connection({ host: trimmed, port, localInterface: this.localInterface || undefined });
    this.conn = conn;

    this.wireEvents(conn);

    return conn
      .connect()
      .then((version) => ({
        ok: true as const,
        version,
        // The renderer derives Local/SLink/USB input counts and labels from
        // the spec — without it the Input Patching selects fall back to 48.
        spec: modelSpec(version.model),
      }))
      .catch((err: NodeJS.ErrnoException) => {
        // A failed initial connect never triggers auto-reconnect: the error is
        // surfaced on the connect screen so the user can fix host/port.
        conn.disconnect();
        const msg =
          err && err.code === "ECONNREFUSED"
            ? `Connection refused by ${trimmed}:51326. Is the mixer online and MixPad disabled?`
            : err && err.code === "ENOTFOUND"
            ? `Host not found: ${trimmed}`
            : err && err.code === "ETIMEDOUT"
            ? `Connection timed out: ${trimmed}`
            : (err && err.message) || String(err);
        return { ok: false as const, error: msg };
      });
  }

  /** Tear down the live connection and its flush timer (keeps reconnect flags). */
  private teardown(): void {
    this.demo.stop();
    if (this.statusTimer) {
      clearInterval(this.statusTimer);
      this.statusTimer = null;
    }
    if (this.conn) {
      this.conn.disconnect();
      this.conn = null;
    }
  }

  disconnect(): void {
    // Manual disconnect: no auto-retry.
    this.stopReconnect();
    this.teardown();
  }

  // ── console discovery (CN-C1) ─────────────────────────────────────

  /**
   * Sweep the local subnet(s) for SQ consoles on the SQ TCP port. Results are
   * streamed to the renderer via `sq:discovered`; the returned promise resolves
   * once every candidate has been probed (or the scan is cancelled). Only one
   * sweep runs at a time.
   */
  async discover(subnets?: string[], port?: number): Promise<DiscoveryResult> {
    if (this.discoveryAbort) {
      return {
        ok: false,
        subnets: [],
        found: [],
        scanned: 0,
        durationMs: 0,
        error: "Сканирование уже выполняется.",
      };
    }
    const ctrl = new AbortController();
    this.discoveryAbort = ctrl;
    const started = Date.now();
    this.send("sq:log", { level: "frame", msg: "Discovery: scanning local network for SQ consoles…" });
    try {
      const { found, scanned, subnets: swept } = await scanNetwork(
        { subnets, port, signal: ctrl.signal },
        (c: DiscoveredConsole) => {
          this.send("sq:discovered", c);
          this.send("sq:log", {
            level: "ok",
            msg: `Discovery: found ${c.modelName ?? "SQ"} (FW ${c.fw ?? "?"}) at ${c.host}:${c.port}`,
          });
        }
      );
      const durationMs = Date.now() - started;
      this.send("sq:log", {
        level: "ok",
        msg: `Discovery: ${found.length} console(s) on ${scanned} host(s) in ${Math.round(
          durationMs / 1000
        )}s.`,
      });
      return {
        ok: true,
        subnets: swept,
        found,
        scanned,
        durationMs,
        cancelled: ctrl.signal.aborted,
      };
    } catch (err) {
      return {
        ok: false,
        subnets: [],
        found: [],
        scanned: 0,
        durationMs: Date.now() - started,
        error: err instanceof Error ? err.message : String(err),
      };
    } finally {
      this.discoveryAbort = null;
    }
  }

  /** Abort an in-progress discovery sweep. Returns false if none is running. */
  cancelDiscovery(): boolean {
    if (!this.discoveryAbort) return false;
    this.discoveryAbort.abort();
    return true;
  }

  // ── auto-reconnect ────────────────────────────────────────────────

  /** Stop and invalidate any pending reconnect sequence (no status emitted). */
  private stopReconnect(): void {
    this.reconnectGen++;
    if (this.reconnectTimer) {
      clearTimeout(this.reconnectTimer);
      this.reconnectTimer = null;
    }
    this.autoReconnect = false;
    this.reconnectAttempt = 0;
  }

  /**
   * User-initiated cancel of the reconnect sequence (renderer button). Tears
   * the dead connection down and returns the UI to the connect screen.
   */
  cancelReconnect(): void {
    const wasActive = this.autoReconnect && (this.reconnectAttempt > 0 || this.reconnectTimer !== null);
    this.stopReconnect();
    this.teardown();
    if (wasActive) {
      this.send("sq:status", {
        connected: false,
        host: this.host,
        reconnect: {
          active: false,
          attempt: 0,
          maxAttempts: RECONNECT_MAX_ATTEMPTS,
          delayMs: 0,
          error: "Переподключение отменено.",
        },
      });
      this.send("sq:log", { level: "warn", msg: "Auto-reconnect cancelled by user." });
    }
  }

  /** Schedule the next reconnect attempt with exponential backoff. */
  private scheduleReconnect(): void {
    this.reconnectAttempt++;
    const attempt = this.reconnectAttempt;

    if (attempt > RECONNECT_MAX_ATTEMPTS) {
      this.autoReconnect = false;
      this.reconnectAttempt = 0;
      const error = `Не удалось переподключиться к ${this.host}.`;
      this.send("sq:status", {
        connected: false,
        host: this.host,
        reconnect: {
          active: false,
          attempt: RECONNECT_MAX_ATTEMPTS,
          maxAttempts: RECONNECT_MAX_ATTEMPTS,
          delayMs: 0,
          error,
        },
      });
      this.send("sq:log", {
        level: "error",
        msg: `Auto-reconnect gave up after ${RECONNECT_MAX_ATTEMPTS} attempts.`,
      });
      return;
    }

    const delayMs = reconnectDelay(attempt);
    this.send("sq:status", {
      connected: false,
      host: this.host,
      reconnect: { active: true, attempt, maxAttempts: RECONNECT_MAX_ATTEMPTS, delayMs },
    });
    this.send("sq:log", {
      level: "warn",
      msg: `Reconnect attempt ${attempt}/${RECONNECT_MAX_ATTEMPTS} in ${Math.round(delayMs / 1000)}s…`,
    });

    const gen = this.reconnectGen;
    this.reconnectTimer = setTimeout(() => {
      this.reconnectTimer = null;
      if (gen !== this.reconnectGen) return;
      this.attemptReconnect(gen);
    }, delayMs);
    this.reconnectTimer.unref();
  }

  /** Run one reconnect attempt against the remembered host/port. */
  private attemptReconnect(gen: number): void {
    const attempt = this.reconnectAttempt;
    // Tell the UI an attempt is now in flight (no countdown).
    this.send("sq:status", {
      connected: false,
      host: this.host,
      reconnect: { active: true, attempt, maxAttempts: RECONNECT_MAX_ATTEMPTS, delayMs: 0 },
    });

    this.model.reset();
    this.mixer.reset();
    this.resetSceneState();
    const conn = new Connection({
      host: this.host,
      port: this.port,
      localInterface: this.localInterface || undefined,
    });
    this.conn = conn;
    this.wireEvents(conn);

    conn
      .connect()
      .then(() => {
        // Success is announced by the connection's own "connect" handler. If the
        // attempt was superseded in the meantime, drop the now-stale socket.
        if (this.conn !== conn) conn.disconnect();
      })
      .catch((err: NodeJS.ErrnoException) => {
        if (gen !== this.reconnectGen) return;
        conn.disconnect();
        this.send("sq:log", {
          level: "warn",
          msg: `Reconnect attempt ${attempt} failed: ${(err && err.message) || err}`,
        });
        if (this.autoReconnect) this.scheduleReconnect();
      });
  }

  /** Current scene name, or null when no scene recall has been observed. */
  private currentSceneName(): string | null {
    return this.currentSceneId !== null
      ? this.sceneNames.get(this.currentSceneId) ?? null
      : null;
  }

  /** Reset collected scene state (called on connect / demo start). */
  private resetSceneState(): void {
    this.sceneNames.clear();
    this.currentSceneId = null;
  }

  snapshot() {
    return {
      ...this.model.snapshot(),
      currentSceneName: this.currentSceneName(),
      channels: this.mixer.snapshot(),
    };
  }

  /**
   * Patch a monitor source (PAFL L / PAFL R) to a physical output.
   * side: "L" or "R" (maps to PAFL L=0x00 / PAFL R=0x01).
   * destType: 0x1a Local, 0x1c SLink, 0x1d USB, 0x1e IOPort.
   * destChannel: 1-based channel number on that output bus.
   */
  setMonitorOutput(side: "L" | "R", destType: number, destChannel: number): void {
    const ch0 = destChannel - 1;
    const srcLabel = side === "L" ? "PAFL L" : "PAFL R";
    const destName =
      destType === 0x1a ? "Local" :
      destType === 0x1c ? "SLink" :
      destType === 0x1d ? "USB" :
      destType === 0x1e ? "IOPort" : `0x${destType.toString(16)}`;

    // Monitor output patch: source 0x00 = PAFL L, 0x01 = PAFL R (modifier 0x11).
    const frame = this.sendPatchFrame(side === "L" ? 0x00 : 0x01, 0x11, ch0 & 0xff, destType & 0xff);
    this.send("sq:log", {
      level: "dsp",
      msg: `Monitor ${srcLabel} → ${destName} Out ${destChannel}`,
      raw: hexDump(frame),
    });
    // In demo mode the model changed locally — flush so the UI reflects it.
    if (this.demo.isActive) {
      this.send("sq:routing", this.snapshot());
    }
  }

  /**
   * PAFL (solo) a mix bus or main LR to the monitor outputs.
   * b3: channel address (0x58-0x63 = Mix 1-12, 0x68 = Main LR).
   */
  setPafl(b3: number, on: boolean): void {
    const label =
      b3 === 0x68 ? "Main LR" :
      b3 >= 0x58 && b3 <= 0x63 ? `Mix ${b3 - 0x58 + 1}` :
      `b3 0x${b3.toString(16)}`;

    const val = on ? 0x0001 : 0x0000;
    const frame = Buffer.from([0xf7, 0x08, 0x15, 0x0c, b3, 0x00, val & 0xff, (val >> 8) & 0xff]);
    const entry = {
      level: "dsp" as const,
      msg: `PAFL ${label}: ${on ? "ON" : "OFF"}`,
      raw: hexDump(frame),
    };

    if (this.demo.isActive) {
      this.send("sq:log", entry);
      return;
    }
    if (this.conn?.connected) {
      this.conn.send(frame);
      this.send("sq:log", entry);
    }
  }

  /**
   * Route a source (input channel, mix bus, or Main LR) to a physical output.
   * sourceB3: channel address (0x00–0x2f inputs, 0x58–0x63 Mix 1-12, 0x68 Main LR).
   * destType: 0x1a Local, 0x1b ME, 0x1c SLink, 0x1d USB, 0x1e IOPort.
   * destChannel: 1-based channel number on that output bus.
   * rightHalf: right half of a console-linked stereo source — same master b3,
   *   output-patch modifier 0x10 instead of the default 0x0f. Confirmed on a
   *   real SQ-5: the console patches a linked pair to two sockets as
   *   `<master> 0f <L> 1a` and `<master> 10 <R> 1a`.
   */
  setOutputPatch(
    sourceB3: number,
    destType: number,
    destChannel: number,
    rightHalf = false
  ): void {
    const ch0 = destChannel - 1;
    const destName =
      destType === 0x1a ? "Local" :
      destType === 0x1b ? "ME" :
      destType === 0x1c ? "SLink" :
      destType === 0x1d ? "USB" :
      destType === 0x1e ? "IOPort" : `0x${destType.toString(16)}`;

    const modifier = rightHalf ? 0x10 : 0x0f;
    const frame = this.sendPatchFrame(sourceB3, modifier, ch0 & 0xff, destType & 0xff);
    this.send("sq:log", {
      level: "dsp",
      msg: `Route ${b3ToLabel(sourceB3)}${rightHalf ? " R" : ""} → ${destName} Out ${destChannel}`,
      raw: hexDump(frame),
    });
    // In demo mode the model changed locally — flush so the UI reflects it.
    if (this.demo.isActive) {
      this.send("sq:routing", this.snapshot());
    }
  }

  /**
   * Route one side of an FX return to a physical output.
   * fxIndex: 0-based FX engine (FX 1-4).
   * side: "L" | "R" — FX returns are patched per side (modifier 0x16 / 0x17).
   * destType: 0x1a Local, 0x1b ME, 0x1c SLink, 0x1d USB, 0x1e IOPort.
   * destChannel: 1-based channel number on that output bus.
   */
  setFxOutputPatch(fxIndex: number, side: "L" | "R", destType: number, destChannel: number): void {
    const ch0 = destChannel - 1;
    const destName =
      destType === 0x1a ? "Local" :
      destType === 0x1b ? "ME" :
      destType === 0x1c ? "SLink" :
      destType === 0x1d ? "USB" :
      destType === 0x1e ? "IOPort" : `0x${destType.toString(16)}`;

    const frame = this.sendPatchFrame(fxIndex, side === "L" ? 0x16 : 0x17, ch0 & 0xff, destType & 0xff);
    this.send("sq:log", {
      level: "dsp",
      msg: `Route FX${fxIndex + 1} ${side} → ${destName} Out ${destChannel}`,
      raw: hexDump(frame),
    });
    // In demo mode the model changed locally — flush so the UI reflects it.
    if (this.demo.isActive) {
      this.send("sq:routing", this.snapshot());
    }
  }

  /**
   * Patch a single input channel to a new physical source.
   * destB3: mixer input channel address (0x00–0x2f).
   * source: InputPatchSource (0x01 Local, 0x02 SLink, 0x03 USB, 0x04 IOPort).
   * sourceChannel: 0-based channel number on that source bus.
   */
  setInputPatch(destB3: number, source: number, sourceChannel: number): void {
    const destLabel = `${destB3 + 1}`;
    const srcLabel =
      source === 0x01 ? "Local" :
      source === 0x02 ? "SLink" :
      source === 0x03 ? "USB" :
      source === 0x04 ? "I/O Port" : `0x${source.toString(16)}`;

    const frame = this.sendPatchFrame(sourceChannel, source, destB3, 0x20);
    this.send("sq:log", {
      level: "dsp",
      msg: `Input ${destLabel} → ${srcLabel} ${sourceChannel + 1}`,
      raw: hexDump(frame),
    });
    // Demo: sendPatchFrame already updated the local model above. Live: the
    // mixer does not echo app-initiated input patches back on the
    // subscription stream, so the model (and with it the Active Patching
    // table) would stay stale forever. Apply the patch optimistically to the
    // local model — any later echo or full dump simply re-asserts the
    // console's truth over this value.
    if (!this.demo.isActive && this.conn?.connected) {
      this.applyInputPatch(destB3, source, sourceChannel);
    }
    // The model now reflects the requested routing — flush so the UI
    // (Active Patching) updates immediately.
    this.send("sq:routing", this.snapshot());
  }

  /** Force the mixer to re-send its full routing/state dump. */
  requestDump(): void {
    if (this.demo.isActive) {
      this.send("sq:log", { level: "frame", msg: "Requested full routing/state dump (demo)…" });
      this.send("sq:routing", this.snapshot());
      return;
    }
    if (this.conn?.connected) {
      this.conn.requestFullDump();
      this.send("sq:log", {
        level: "frame",
        msg: "Requested full routing/state dump from mixer…",
      });
    }
  }

  /** Current model spec, or null if not connected. */
  getSpec(): SQModelSpec | null {
    if (this.demo.isActive) {
      const v = this.demo.deviceVersion;
      return v ? modelSpec(v.model) : null;
    }
    const v = this.conn?.version;
    return v ? modelSpec(v.model) : null;
  }

  // ── Apply (load) saved routing into the mixer ──────────────────────

  /**
   * Reconstruct and send patch frames for a previously-saved routing.
   * Each input/output patch is turned back into a 0x0b/0x0d DSP frame and
   * either sent to the mixer (live) or applied to the model (demo).
   */
  applyRouting(data: { inputs?: InputPatch[]; outputs?: OutputPatch[] }): {
    ok: boolean;
    applied: number;
    skipped: number;
    error?: string;
  } {
    if (!this.connected) {
      return { ok: false, applied: 0, skipped: 0, error: "Not connected" };
    }
    const inputs = data.inputs ?? [];
    const outputs = data.outputs ?? [];
    let applied = 0;
    let skipped = 0;

    for (const inp of inputs) {
      if (
        typeof inp.sourceChannel !== "number" ||
        typeof inp.source !== "number" ||
        typeof inp.destB3 !== "number"
      ) {
        skipped++;
        continue;
      }
      // Input patch frame: [srcChannel] [source] [destB3] [0x20]
      this.sendPatchFrame(inp.sourceChannel, inp.source, inp.destB3, 0x20);
      applied++;
    }

    for (const out of outputs) {
      const record = this.encodeOutputPatch(out);
      if (!record) {
        skipped++;
        continue;
      }
      this.sendPatchFrame(record.ch, record.modifier, record.valLo, record.valHi);
      applied++;
    }

    this.send("sq:log", {
      level: "ok",
      msg: `Загружен роутинг: ${applied} патчей применено${skipped ? `, ${skipped} пропущено` : ""}.`,
    });

    // In demo mode the model just changed — flush so the UI updates. In live
    // mode the mixer echoes the patches back and the normal DSP path updates
    // the model, but we nudge the UI immediately as well.
    if (this.demo.isActive) {
      this.send("sq:routing", this.snapshot());
    }

    return { ok: true, applied, skipped };
  }

  /**
   * Restore previously captured output patches — used when the monitor tab's
   * "Применять" session ends, to return the borrowed outputs to the routing
   * they had before the session started.
   */
  restoreOutputs(outputs: OutputPatch[]): {
    ok: boolean;
    applied: number;
    skipped: number;
    error?: string;
  } {
    if (!this.connected) {
      return { ok: false, applied: 0, skipped: 0, error: "Not connected" };
    }
    let applied = 0;
    let skipped = 0;
    for (const out of outputs ?? []) {
      const record = this.encodeOutputPatch(out);
      if (!record) {
        skipped++;
        continue;
      }
      this.sendPatchFrame(record.ch, record.modifier, record.valLo, record.valHi);
      applied++;
    }
    this.send("sq:log", {
      level: "ok",
      msg: `Восстановлен роутинг выходов: ${applied} патчей${skipped ? `, ${skipped} пропущено` : ""}.`,
    });
    // In demo mode the model just changed — flush so the UI updates. In live
    // mode the mixer echoes the patches back and the normal DSP path updates
    // the model.
    if (this.demo.isActive) {
      this.send("sq:routing", this.snapshot());
    }
    return { ok: true, applied, skipped };
  }

  /**
   * Clear the given physical outputs in the local model — the monitor session
   * restore uses this for borrowed outputs that had no known routing before
   * the session. There is no documented "no source" output-patch frame, so on
   * live hardware this only fixes the app's view; in demo mode the model is
   * authoritative and the UI updates immediately.
   */
  clearOutputs(outputs: OutputKey[]): { ok: boolean; cleared: number } {
    let cleared = 0;
    for (const o of outputs ?? []) {
      if (typeof o?.dest === "number" && typeof o?.destChannel === "number") {
        this.model.clearOutput(o.dest, o.destChannel);
        cleared++;
      }
    }
    this.send("sq:log", {
      level: "ok",
      msg: `Очищено выходов: ${cleared}.`,
    });
    if (this.demo.isActive) {
      this.send("sq:routing", this.snapshot());
    }
    return { ok: true, cleared };
  }

  /** Reconstruct the 4 payload fields of an output-patch frame from a saved record. */
  private encodeOutputPatch(out: OutputPatch): {
    ch: number;
    modifier: number;
    valLo: number;
    valHi: number;
  } | null {
    const valLo = Math.max(0, (out.destChannel ?? 1) - 1);
    const valHi = out.dest;
    if (out.kind === "bus") {
      const b3 = labelToB3(out.sourceLabel);
      if (b3 === null) return null;
      return { ch: b3, modifier: out.rightHalf ? 0x10 : 0x0f, valLo, valHi };
    }
    if (out.kind === "fx") {
      const m = /^FX(\d+)\s+([LR])$/.exec(out.sourceLabel || "");
      if (!m) return null;
      const fxIndex = Number(m[1]) - 1;
      const modifier = m[2] === "L" ? 0x16 : 0x17;
      return { ch: fxIndex, modifier, valLo, valHi };
    }
    if (out.kind === "monitor") {
      const src = MONITOR_LABEL_TO_SOURCE[out.sourceLabel];
      if (src === undefined) return null;
      return { ch: src, modifier: 0x11, valLo, valHi };
    }
    return null;
  }

  /**
   * Send a single routing patch as a 0xF7 + 7-byte DSP frame. In demo mode
   * the frame is fed straight into the routing model instead of the network.
   */
  private sendPatchFrame(ch: number, modifier: number, valLo: number, valHi: number): Buffer {
    const payload = Buffer.from([0x0b, 0x0b, 0x0d, ch, modifier, valLo, valHi]);
    const frame = Buffer.concat([Buffer.from([0xf7]), payload]);
    if (this.demo.isActive) {
      this.model.handleDsp({
        ch,
        category: 0x0b,
        register: 0x0d,
        modifier,
        value: (valLo & 0xff) | ((valHi & 0xff) << 8),
        raw: payload,
      });
    } else if (this.conn?.connected) {
      this.conn.send(frame);
    }
    return frame;
  }

  /** Apply an input patch straight to the routing model (optimistic / demo). */
  private applyInputPatch(destB3: number, source: number, srcChannel: number): void {
    const raw = Buffer.from([0x0b, 0x0b, 0x0d, srcChannel, source, destB3, 0x20]);
    this.model.handleDsp({ ch: srcChannel, category: 0x0b, register: 0x0d, modifier: source, value: destB3 | (0x20 << 8), raw });
  }

  // ── Demo mode (simulation lives in demo.ts) ────────────────────────

  /**
   * Start the fully simulated session — no mixer required. The demo session
   * owns the show data, timers and meter stream; this only drops any live
   * session/reconnect sequence and hands the models over.
   */
  startDemo(): { ok: true; version: VersionInfo; spec: SQModelSpec } | { ok: false; error: string } {
    this.stopReconnect();
    this.teardown();
    this.host = DEMO_HOST;
    return this.demo.start();
  }

  /** Demo-mode "Обновить": regenerate a completely new simulated routing/show. */
  demoRefresh() {
    return this.demo.refresh();
  }

  private send(channel: string, payload: unknown): void {
    if (mainWindow && !mainWindow.isDestroyed()) {
      mainWindow.webContents.send(channel, payload);
    }
  }

  private wireEvents(conn: Connection): void {
    let dirty = false;
    /** True once the handshake completed for this connection. */
    let established = false;
    const flush = (): void => {
      if (dirty) {
        dirty = false;
        this.send("sq:routing", this.snapshot());
      }
    };
    // Throttle routing snapshots so a burst of frames doesn't flood the UI.
    // Any previous flush timer (dropped / replaced connection) is discarded.
    if (this.statusTimer) clearInterval(this.statusTimer);
    this.statusTimer = setInterval(flush, 120);
    this.statusTimer.unref();

    conn.on("dsp", (d: DspFrame) => {
      const wasRouting = this.model.handleDsp(d);
      const wasState = this.mixer.handleDsp(d);
      if (wasRouting || wasState) dirty = true;

      // Scene-recall confirmation: F7 02 02 1c [sceneId] 00 FF FF — 0-based
      // scene id. The mixer sends it after every completed recall (console
      // surface, softkeys, MIDI). The SQ binary protocol has no way to QUERY
      // the active scene, so this live frame is the only source of truth;
      // until one arrives the active scene is genuinely unknown.
      if (d.category === 0x02 && d.register === 0x1c && d.ch < 300) {
        if (this.currentSceneId !== d.ch) {
          this.currentSceneId = d.ch;
          dirty = true;
          const name = this.sceneNames.get(d.ch);
          this.send("sq:log", {
            level: "ok",
            msg: `Scene recalled: ${d.ch + 1}${name ? ` — ${name}` : " (name not yet known)"}`,
          });
        }
      }

      // Surface routing-relevant raw frames for the live monitor.
      if (
        (d.category === 0x0b && d.register === 0x0d) ||
        (d.category === 0x02 && d.register === 0x1c)
      ) {
        const hex = Array.from(d.raw.slice(0, 8))
          .map((b) => b.toString(16).padStart(2, "0"))
          .join(" ");
        this.send("sq:log", { level: "dsp", msg: `DSP  ${hex}`, raw: hexDump(d.raw) });
      }
    });

    conn.on("channelName", (b3: number, name: string) => {
      this.model.setChannelName(b3, name);
      dirty = true;
    });

    // Stereo-link pairs decoded from the ParamData blob (offset 81548).
    conn.on("stereoPairs", (pairs: number[][]) => {
      this.model.stereoPairs = pairs;
      dirty = true;
    });

    // Mix bus mono/stereo mode read from each mix's 336-byte channel block
    // (byte +331) — replaces the behavioural L/R latch with the console state.
    conn.on("mixStereoPairs", (pairs: number[][]) => {
      this.model.mixStereoPairs = pairs;
      dirty = true;
      if (pairs.length > 0) {
        const list = pairs.map((p) => `${p[0] + 1}-${p[1] + 1}`).join(", ");
        this.send("sq:log", {
          level: "frame",
          msg: `Stereo mixes (ParamData +331): ${list}`,
        });
      }
    });

    // Stereo-linked non-input buses (matrices/Main LR) from the link region.
    conn.on("busLinks", (buses: number[]) => {
      this.send("sq:log", {
        level: "frame",
        msg: `Stereo-linked buses (link table): ${
          buses.map((b) => `0x${b.toString(16)}`).join(", ") || "none"
        }`,
      });
    });

    // First large ParamData blob of the session — save it together with a
    // stereo-table report so firmware-specific layout shifts can be diagnosed
    // (see paramdata-diagnostics.ts). Files are overwritten on each reconnect.
    conn.on("paramDataSize", (size: number, payload: Buffer) => {
      this.dumpParamData(payload, conn.version);
    });

    // Scene library updates (full list dump arrives on connect).
    conn.on("sceneName", (id: number, name: string | null) => {
      if (name) this.sceneNames.set(id, name);
      else this.sceneNames.delete(id);
      dirty = true;
    });

    // Scene-list dump summary: log the flag bytes seen on this console.
    // Documented: 0x07 = stored scene, 0x00 = empty slot. If the active
    // scene carries a distinctive flag, it will stand out in this log.
    conn.on(
      "sceneList",
      (records: { id: number; flag: number; name: string | null }[]) => {
        const namedFlags = Array.from(
          new Set(records.filter((r) => r.name).map((r) => r.flag))
        )
          .map((f) => `0x${f.toString(16)}`)
          .join(", ");
        this.send("sq:log", {
          level: "frame",
          msg: `Scene list: ${records.length} slots, ${
            records.filter((r) => r.name).length
          } named (stored-scene flags: ${namedFlags || "—"}).`,
        });
      }
    );

    // Individual scene record after a recall / rename / store — treat the
    // most recent one as the active scene (heuristic; see currentSceneName).
    conn.on("sceneRecall", (id: number, name: string) => {
      this.sceneNames.set(id, name);
      this.currentSceneId = id;
      this.send("sq:log", {
        level: "frame",
        msg: `Scene recalled: ${id + 1} — ${name}`,
      });
      dirty = true;
    });

    conn.on("routingBlock", (payload: Buffer) => {
      this.model.routingBlockBytes = payload.length;
      dirty = true;
      this.send("sq:log", {
        level: "frame",
        msg: `Routing/config block (sub=0x10): ${payload.length} bytes received`,
        raw: hexDump(payload),
      });
    });

    conn.on("initialState", () => {
      const frameCounters = conn._frameCounters;
      const snapshot = this.model.snapshot();
      this.send("sq:log", {
        level: "frame",
        msg: `Initial state burst complete. Frames: total=${frameCounters.total} dsp=${frameCounters.dsp} paramData=${frameCounters.paramData} routingBlock=${frameCounters.routingBlock} fullState=${frameCounters.fullState} channelInfo=${frameCounters.channelInfo}`,
      });
      this.send("sq:log", {
        level: "ok",
        msg: `Routing decoded: ${snapshot.inputs.length} input patches, ${snapshot.outputs.length} output patches, ${snapshot.stereoPairs.length} stereo pairs.`,
      });
      // Channel state parsed from the initial ParamData dump: how many
      // channels carry fader / mute / gain data right after connect.
      const chans = this.mixer.snapshot();
      const withFader = chans.filter((c) => c.faderDb !== null).length;
      const withGain = chans.filter((c) => c.gainDb !== null).length;
      this.send("sq:log", {
        level: "ok",
        msg: `Channel state from initial dump: ${chans.length} addresses (fader: ${withFader}, gain: ${withGain}). No need to wait for live changes.`,
      });
      flush();
      // Initial fill is complete — renderer freezes the Input Patching list.
      this.send("sq:initialState", {});
    });

    conn.on("connect", (v: VersionInfo) => {
      established = true;
      // A restored session: remember the attempt count for the UI before reset.
      const reconnected = this.reconnectAttempt > 0;
      // Reset the reconnect bookkeeping and arm auto-reconnect for future drops.
      this.stopReconnect();
      this.autoReconnect = true;
      this.send("sq:status", {
        connected: true,
        host: this.host,
        version: v,
        spec: modelSpec(v.model),
        reconnected,
      });
      this.send("sq:log", {
        level: "ok",
        msg: `${reconnected ? "Reconnected to" : "Connected to"} ${v.modelName} (FW ${v.fwA}.${v.fwB}${
          v.build !== undefined ? "." + v.build : ""
        }) at ${this.host}`,
      });
    });

    conn.on("disconnect", () => {
      this.send("sq:log", { level: "warn", msg: "Disconnected from mixer." });
      // Stale connection being replaced/torn down — ignore.
      if (this.conn !== conn) return;
      // A handshake that never completed is handled by the connect() callback;
      // don't emit a drop status that would dismiss the reconnect UI.
      if (!established) return;
      if (this.autoReconnect) {
        this.scheduleReconnect();
      } else {
        this.send("sq:status", { connected: false, host: this.host });
      }
    });

    // Live input meters streamed over UDP (~25-50 packets/s). The renderer
    // coalesces them per animation frame, so forwarding each is fine.
    conn.on("meters", (m: MetersPayload) => {
      this.send("sq:meters", m);
    });

    // Meter-packet inventory — one log line per distinct packet shape seen
    // on the UDP meter port, plus for undecoded bodies a dB snapshot and the
    // changed-slot map, refreshed every few seconds. Exists to discover the
    // (yet undecoded) mix / Main-LR meter packets when connected to a real
    // console: feed signal into one known bus at a time and watch which
    // packet id / slot index starts moving.
    conn.on(
      "meterPacketInfo",
      (p: {
        id: number;
        len: number;
        decoded: boolean;
        sample?: string;
        changes?: string;
        hot?: string;
        raw?: Buffer;
      }) => {
        const idStr = p.id < 0 ? "—" : `0x${p.id.toString(16).padStart(2, "0")}`;
        // Quiet mode: undecoded shapes log on first sight and when slots
        // actually moved — steady-state snapshots are log noise.
        if (!p.decoded && !p.changes && !p.raw) return;
        const sample = p.decoded ? "" : ` dB: ${p.sample ?? "-"}`;
        const changes = p.changes ? ` chg: ${p.changes}` : "";
        const hot = p.hot ? ` hot: ${p.hot}` : "";
        this.send("sq:log", {
          level: "frame",
          msg: `Meter packet: id=${idStr} body=${p.len}B${p.decoded ? "" : " (undecoded)"}${sample}${hot}${changes}`,
          raw: p.raw ? hexDump(p.raw) : undefined,
        });
        // First sight of an undecoded shape — keep one raw datagram next to
        // the other diagnostics so the packet layout can be analyzed offline.
        if (p.raw) this.dumpMeterPacket(p.id, p.raw);
      }
    );

    conn.on("error", (err: Error) => {
      this.send("sq:log", { level: "error", msg: `Connection error: ${err.message}` });
    });
  }

  /**
   * Save one raw undecoded meter datagram under userData/diagnostics —
   * one file per packet shape (id + body length), for offline layout analysis.
   */
  private dumpMeterPacket(id: number, raw: Buffer): void {
    try {
      const dir = path.join(app.getPath("userData"), "diagnostics");
      fs.mkdirSync(dir, { recursive: true });
      const binPath = path.join(dir, `meter-packet-0x${id.toString(16)}-${raw.length}B.bin`);
      fs.writeFileSync(binPath, raw);
      this.send("sq:log", {
        level: "frame",
        msg: `Diagnostics: meter packet saved: ${binPath}`,
      });
    } catch (e) {
      this.send("sq:log", {
        level: "warn",
        msg: `Diagnostics: failed to write meter packet: ${(e as Error).message}`,
      });
    }
  }

  /**
   * Save the raw ParamData blob plus a stereo-table analysis report under
   * userData/diagnostics. Called once per connection (first large blob).
   */
  private dumpParamData(payload: Buffer, version: VersionInfo | null): void {
    try {
      const dir = path.join(app.getPath("userData"), "diagnostics");
      fs.mkdirSync(dir, { recursive: true });
      const binPath = path.join(dir, "paramdata-dump.bin");
      const txtPath = path.join(dir, "paramdata-stereo.txt");
      fs.writeFileSync(binPath, payload);
      const diag = analyzeStereoTable(payload);
      fs.writeFileSync(txtPath, diag.report, "utf8");
      const fw = version
        ? ` ${version.modelName} FW ${version.fwA}.${version.fwB}`
        : "";
      this.send("sq:log", {
        level: "frame",
        msg: `Diagnostics: ParamData saved (${payload.length} bytes${fw}): ${binPath}`,
      });
      this.send("sq:log", {
        level: "frame",
        msg: `Diagnostics: stereo report: ${txtPath}`,
      });
      if (diag.bestOffset !== null) {
        this.send("sq:log", {
          level: "frame",
          msg: `Diagnostics: best-matching stereo-table offset: ${diag.bestOffset}`,
        });
      }
    } catch (e) {
      this.send("sq:log", {
        level: "warn",
        msg: `Diagnostics: failed to write dump: ${(e as Error).message}`,
      });
    }
  }
}

const controller = new SQController();

function createWindow(): void {
  // App icon shipped next to main.js (see webpack.config.js). In dev mode the
  // process runs from the Electron binary, so the Dock would otherwise show
  // the generic Electron icon — override it at runtime. The packaged app
  // embeds its icon via electron-builder; the file may not exist there.
  // Note: dock.setIcon() only accepts PNG/JPEG (NativeImage), not .icns.
  const iconPath = path.join(__dirname, "icon.png");
  if (process.platform === "darwin" && app.dock && fs.existsSync(iconPath)) {
    app.dock.setIcon(iconPath);
  }

  mainWindow = new BrowserWindow({
    width: 1180,
    height: 820,
    minWidth: 880,
    minHeight: 600,
    backgroundColor: "#0f1115",
    title: "SQ Router Control",
    icon: fs.existsSync(iconPath) ? iconPath : undefined,
    webPreferences: {
      preload: path.join(__dirname, "preload.js"),
      contextIsolation: true,
      nodeIntegration: false,
      sandbox: false,
    },
  });

  mainWindow.loadFile(path.join(__dirname, "..", "renderer", "index.html"));

  mainWindow.on("closed", () => {
    mainWindow = null;
  });

  mainWindow.webContents.on("render-process-gone", (_e, details) => {
    const msg = `Renderer process gone: reason=${details.reason} exitCode=${details.exitCode}`;
    // eslint-disable-next-line no-console
    console.error("CRASH:", msg);
  });
}

// Catch any uncaught exceptions in the main process so we can see them.
process.on("uncaughtException", (err) => {
  console.error("UNCAUGHT:", err && err.stack ? err.stack : err);
});
process.on("unhandledRejection", (err) => {
  console.error("UNHANDLED REJECTION:", err);
});

function registerIpc(): void {
  ipcMain.handle("sq:connect", (_e, host: string, port?: number) =>
    controller.connect(host, port)
  );
  ipcMain.handle("sq:disconnect", () => {
    controller.disconnect();
    return true;
  });
  ipcMain.handle("sq:cancelReconnect", () => {
    controller.cancelReconnect();
    return true;
  });
  ipcMain.handle("sq:discoverConsoles", (_e, subnets?: string[], port?: number) =>
    controller.discover(subnets, port)
  );
  ipcMain.handle("sq:cancelDiscovery", () => controller.cancelDiscovery());
  ipcMain.handle("sq:getSnapshot", () => controller.snapshot());
  ipcMain.handle("sq:demoRefresh", () => controller.demoRefresh());
  ipcMain.handle("sq:setMonitorOutput", (_e, side: "L" | "R", destType: number, destChannel: number) => {
    controller.setMonitorOutput(side, destType, destChannel);
    return true;
  });
  ipcMain.handle("sq:setPafl", (_e, b3: number, on: boolean) => {
    controller.setPafl(b3, on);
    return true;
  });
  ipcMain.handle("sq:setOutputPatch", (_e, sourceB3: number, destType: number, destChannel: number, rightHalf?: boolean) => {
    controller.setOutputPatch(sourceB3, destType, destChannel, rightHalf === true);
    return true;
  });
  ipcMain.handle("sq:setFxOutputPatch", (_e, fxIndex: number, side: "L" | "R", destType: number, destChannel: number) => {
    controller.setFxOutputPatch(fxIndex, side, destType, destChannel);
    return true;
  });
  ipcMain.handle("sq:requestDump", () => {
    controller.requestDump();
    return true;
  });
  ipcMain.handle("sq:startDemo", () => controller.startDemo());
  ipcMain.handle("sq:applyRouting", (_e, data: { inputs?: InputPatch[]; outputs?: OutputPatch[] }) =>
    controller.applyRouting(data)
  );
  ipcMain.handle("sq:restoreOutputs", (_e, outputs: OutputPatch[]) =>
    controller.restoreOutputs(outputs)
  );
  ipcMain.handle("sq:clearOutputs", (_e, outputs: OutputKey[]) =>
    controller.clearOutputs(outputs)
  );
  ipcMain.handle("sq:setInputPatch", (_e, destB3: number, source: number, sourceChannel: number) => {
    controller.setInputPatch(destB3, source, sourceChannel);
    return true;
  });
  ipcMain.handle(
    "sq:exportFile",
    async (
      _e,
      content: string,
      defaultFileName: string,
      filterName: string,
      extension: string
    ): Promise<ExportFileResult> => {
      const options = {
        title: "Сохранить файл",
        defaultPath: defaultFileName,
        filters: [{ name: filterName, extensions: [extension] }],
      };
      const res = mainWindow
        ? await dialog.showSaveDialog(mainWindow, options)
        : await dialog.showSaveDialog(options);
      if (res.canceled || !res.filePath) return { ok: false, canceled: true };
      try {
        await fs.promises.writeFile(res.filePath, content, "utf8");
        return { ok: true, path: res.filePath };
      } catch (err) {
        return { ok: false, error: err instanceof Error ? err.message : String(err) };
      }
    }
  );
  ipcMain.handle("sq:getStatus", () => ({
    connected: controller.connected,
    version: controller.version,
    spec: controller.getSpec(),
  }));
}

// Single instance lock.
const gotLock = app.requestSingleInstanceLock();
if (!gotLock) {
  app.quit();
} else {
  app.on("second-instance", () => {
    if (mainWindow) {
      if (mainWindow.isMinimized()) mainWindow.restore();
      mainWindow.focus();
    }
  });

  app.whenReady().then(() => {
    Menu.setApplicationMenu(null);
    registerIpc();
    createWindow();

    app.on("activate", () => {
      if (BrowserWindow.getAllWindows().length === 0) createWindow();
    });
  });

  app.on("window-all-closed", () => {
    controller.disconnect();
    if (process.platform !== "darwin") app.quit();
  });

  app.on("before-quit", () => {
    controller.disconnect();
  });
}
