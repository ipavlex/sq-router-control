/**
 * SQ Router Control — Electron main process.
 *
 * Owns the SQ TCP connection and the routing model, and bridges them to the
 * renderer over IPC. The renderer never touches the network directly.
 */
import { app, BrowserWindow, ipcMain, Menu } from "electron";
import * as path from "node:path";
import * as fs from "node:fs";
import { Connection, VersionInfo, DspFrame } from "./transport/connection";
import { RoutingModel, InputPatch, OutputPatch, labelToB3, b3ToLabel, MONITOR_LABEL_TO_SOURCE, RoutingSnapshot } from "./routing";
import { modelSpec, SQModelSpec } from "./models";
import { MetersPayload } from "./meters";
import { DemoMetersSim, DEMO_METERS_TICK_MS } from "./demo-meters";

let mainWindow: BrowserWindow | null = null;

/**
 * Demo routing variants for the "Обновить" button. Each variant is a fully
 * different simulated routing: distinct channel names, stereo pairs and
 * patching, so a refresh visibly regenerates the whole console state.
 */
interface DemoVariant {
  names: Record<number, string>;
  stereoPairs: number[][];
  inputs: { destB3: number; source: number; sourceChannel: number }[];
  outputs: (
    | { kind: "output"; sourceB3: number; dest: number; destChannel0: number }
    | { kind: "fx"; fxIndex: number; lr: "L" | "R"; dest: number; destChannel0: number }
    | { kind: "monitor"; source: number; dest: number; destChannel0: number }
  )[];
}

const Src = { Local: 0x01, SLink: 0x02, USB: 0x03 };
const Dest = { Local: 0x1a, USB: 0x1d, SLink: 0x1c };

const DEMO_VARIANTS: DemoVariant[] = [
  {
    names: {
      0: "Kick", 1: "Snare", 2: "OH L", 3: "OH R", 4: "Hat", 5: "Bass",
      6: "Gtr L", 7: "Gtr R", 8: "Key L", 9: "Key R", 10: "Vox", 11: "BGV 1",
      12: "BGV 2", 13: "Sax", 14: "Clk L", 15: "Clk R",
      16: "Trk L", 17: "Trk R", 18: "Talk", 19: "Tpt", 20: "Tbn", 21: "Tuba",
      22: "Ac G", 23: "Cajon", 24: "Prc 1", 25: "Prc 2", 26: "Vln", 27: "Cello",
      28: "FX1 L", 29: "FX1 R", 30: "FX2 L", 31: "FX2 R",
      32: "STM L", 33: "STM R", 34: "Clk T", 35: "Tlk T", 36: "MD L", 37: "MD R",
      38: "Sp 1", 39: "Sp 2", 40: "Sp 3", 41: "Sp 4", 42: "Sp 5", 43: "Sp 6",
      44: "Sp 7", 45: "Sp 8", 46: "Sp 9", 47: "Sp 10",
    },
    stereoPairs: [
      [2, 3], [6, 7], [8, 9], [14, 15], [16, 17],
      [28, 29], [30, 31], [32, 33], [36, 37],
    ],
    inputs: [
      ...Array.from({ length: 16 }, (_, i) => ({ destB3: i, source: Src.Local, sourceChannel: i })),
      ...Array.from({ length: 16 }, (_, i) => ({ destB3: 16 + i, source: Src.SLink, sourceChannel: i })),
      ...Array.from({ length: 16 }, (_, i) => ({ destB3: 32 + i, source: Src.USB, sourceChannel: i })),
    ],
    outputs: [
      { kind: "output", sourceB3: 0x68, dest: Dest.Local, destChannel0: 0 },
      { kind: "output", sourceB3: 0x58, dest: Dest.Local, destChannel0: 2 },
      { kind: "output", sourceB3: 0x59, dest: Dest.Local, destChannel0: 3 },
      { kind: "output", sourceB3: 0x5a, dest: Dest.Local, destChannel0: 4 },
      { kind: "output", sourceB3: 0x5b, dest: Dest.Local, destChannel0: 5 },
      { kind: "output", sourceB3: 0x5c, dest: Dest.SLink, destChannel0: 0 },
      { kind: "output", sourceB3: 0x5d, dest: Dest.SLink, destChannel0: 1 },
      { kind: "output", sourceB3: 0x5e, dest: Dest.SLink, destChannel0: 2 },
      { kind: "output", sourceB3: 0x5f, dest: Dest.SLink, destChannel0: 3 },
      { kind: "fx", fxIndex: 0, lr: "L", dest: Dest.USB, destChannel0: 0 },
      { kind: "fx", fxIndex: 0, lr: "R", dest: Dest.USB, destChannel0: 1 },
      { kind: "fx", fxIndex: 1, lr: "L", dest: Dest.USB, destChannel0: 2 },
      { kind: "fx", fxIndex: 1, lr: "R", dest: Dest.USB, destChannel0: 3 },
      { kind: "monitor", source: 0, dest: Dest.Local, destChannel0: 6 },
    ],
  },
  {
    names: {
      0: "BD", 1: "SD", 2: "HH", 3: "Ride", 4: "Tom1", 5: "Tom2",
      6: "Pno L", 7: "Pno R", 8: "Org", 9: "EP", 10: "Lead", 11: "BGV A",
      12: "BGV B", 13: "Flute", 14: "Harp", 15: "Cel",
      16: "Loop L", 17: "Loop R", 18: "MC", 19: "Trp 1", 20: "Trp 2", 21: "Sax 2",
      22: "Nylon", 23: "Conga", 24: "Shaker", 25: "Tamb", 26: "Vla", 27: "Cb",
      28: "Rtn 1L", 29: "Rtn 1R", 30: "Rtn 2L", 31: "Rtn 2R",
      32: "Play L", 33: "Play R", 34: "Click", 35: "Talkbk",
      36: "Pad L", 37: "Pad R", 38: "Sfx 1", 39: "Sfx 2", 40: "Sfx 3", 41: "Sfx 4",
      42: "Sfx 5", 43: "Sfx 6", 44: "Sfx 7", 45: "Sfx 8", 46: "Sfx 9", 47: "Sfx 10",
    },
    stereoPairs: [
      [0, 1], [6, 7], [16, 17], [28, 29], [30, 31], [32, 33], [36, 37],
    ],
    inputs: [
      ...Array.from({ length: 8 }, (_, i) => ({ destB3: i, source: Src.Local, sourceChannel: i })),
      ...Array.from({ length: 8 }, (_, i) => ({ destB3: 8 + i, source: Src.SLink, sourceChannel: i })),
      ...Array.from({ length: 16 }, (_, i) => ({ destB3: 16 + i, source: Src.USB, sourceChannel: i })),
      ...Array.from({ length: 16 }, (_, i) => ({ destB3: 32 + i, source: Src.Local, sourceChannel: 16 + i })),
    ],
    outputs: [
      { kind: "output", sourceB3: 0x68, dest: Dest.USB, destChannel0: 0 },
      { kind: "output", sourceB3: 0x58, dest: Dest.SLink, destChannel0: 0 },
      { kind: "output", sourceB3: 0x59, dest: Dest.SLink, destChannel0: 1 },
      { kind: "output", sourceB3: 0x5a, dest: Dest.SLink, destChannel0: 2 },
      { kind: "output", sourceB3: 0x5b, dest: Dest.SLink, destChannel0: 3 },
      { kind: "output", sourceB3: 0x5c, dest: Dest.Local, destChannel0: 2 },
      { kind: "output", sourceB3: 0x5d, dest: Dest.Local, destChannel0: 3 },
      { kind: "output", sourceB3: 0x5e, dest: Dest.Local, destChannel0: 4 },
      { kind: "output", sourceB3: 0x5f, dest: Dest.Local, destChannel0: 5 },
      { kind: "fx", fxIndex: 0, lr: "L", dest: Dest.Local, destChannel0: 7 },
      { kind: "fx", fxIndex: 0, lr: "R", dest: Dest.Local, destChannel0: 8 },
      { kind: "fx", fxIndex: 1, lr: "L", dest: Dest.USB, destChannel0: 4 },
      { kind: "fx", fxIndex: 1, lr: "R", dest: Dest.USB, destChannel0: 5 },
      { kind: "monitor", source: 1, dest: Dest.Local, destChannel0: 6 },
    ],
  },
  {
    names: {
      0: "Kick In", 1: "Kick Out", 2: "Snr Top", 3: "Snr Bot", 4: "Hat", 5: "Ride",
      6: "T1", 7: "T2", 8: "T3", 9: "T4", 10: "Vox 1", 11: "Vox 2",
      12: "Vox 3", 13: "Vox 4", 14: "Gtr 1", 15: "Gtr 2",
      16: "Keys L", 17: "Keys R", 18: "Bass D", 19: "Bass A", 20: "Synth", 21: "Strings",
      22: "Horn 1", 23: "Horn 2", 24: "Horn 3", 25: "Horn 4", 26: "Perc", 27: "Wood",
      28: "FX A L", 29: "FX A R", 30: "FX B L", 31: "FX B R",
      32: "Lap L", 33: "Lap R", 34: "Cue 1", 35: "Cue 2", 36: "Cue 3", 37: "Cue 4",
      38: "Cue 5", 39: "Cue 6", 40: "Cue 7", 41: "Cue 8", 42: "Cue 9", 43: "Cue 10",
      44: "Cue 11", 45: "Cue 12", 46: "Cue 13", 47: "Cue 14",
    },
    stereoPairs: [
      [2, 3], [16, 17], [28, 29], [30, 31], [32, 33],
    ],
    inputs: [
      ...Array.from({ length: 16 }, (_, i) => ({ destB3: i, source: Src.SLink, sourceChannel: i })),
      ...Array.from({ length: 16 }, (_, i) => ({ destB3: 16 + i, source: Src.Local, sourceChannel: i })),
      ...Array.from({ length: 16 }, (_, i) => ({ destB3: 32 + i, source: Src.USB, sourceChannel: i })),
    ],
    outputs: [
      { kind: "output", sourceB3: 0x68, dest: Dest.Local, destChannel0: 0 },
      { kind: "output", sourceB3: 0x58, dest: Dest.USB, destChannel0: 0 },
      { kind: "output", sourceB3: 0x59, dest: Dest.USB, destChannel0: 1 },
      { kind: "output", sourceB3: 0x5a, dest: Dest.USB, destChannel0: 2 },
      { kind: "output", sourceB3: 0x5b, dest: Dest.USB, destChannel0: 3 },
      { kind: "output", sourceB3: 0x5c, dest: Dest.SLink, destChannel0: 0 },
      { kind: "output", sourceB3: 0x5d, dest: Dest.SLink, destChannel0: 1 },
      { kind: "output", sourceB3: 0x5e, dest: Dest.SLink, destChannel0: 2 },
      { kind: "output", sourceB3: 0x5f, dest: Dest.SLink, destChannel0: 3 },
      { kind: "fx", fxIndex: 0, lr: "L", dest: Dest.SLink, destChannel0: 4 },
      { kind: "fx", fxIndex: 0, lr: "R", dest: Dest.SLink, destChannel0: 5 },
      { kind: "fx", fxIndex: 1, lr: "L", dest: Dest.Local, destChannel0: 7 },
      { kind: "fx", fxIndex: 1, lr: "R", dest: Dest.Local, destChannel0: 8 },
      { kind: "monitor", source: 2, dest: Dest.Local, destChannel0: 6 },
    ],
  },
];

class SQController {
  private conn: Connection | null = null;
  private model = new RoutingModel();
  private host = "";
  private statusTimer: NodeJS.Timeout | null = null;

  // Demo mode state
  private demoMode = false;
  private demoVersion: VersionInfo | null = null;
  private demoTimer: NodeJS.Timeout | null = null;
  /** Simulated input meter stream (demo only). */
  private demoMeters: DemoMetersSim | null = null;
  private demoMetersTimer: NodeJS.Timeout | null = null;
  /** Generation counter for the initial-burst timers (invalidated on restart). */
  private demoBurstGen = 0;
  /** Generation counter for demoRefresh() variants. */
  private demoRefreshGen = 0;

  // Scene tracking — sceneNames maps sceneId → name; currentSceneId is the
  // most recently recalled scene (null until a recall is observed).
  private sceneNames = new Map<number, string>();
  private currentSceneId: number | null = null;

  get connected(): boolean {
    return this.demoMode || this.conn?.connected || false;
  }

  get version(): VersionInfo | null {
    return this.demoMode ? this.demoVersion : this.conn?.version ?? null;
  }

  connect(host: string, port?: number): Promise<{ ok: true; version: VersionInfo } | { ok: false; error: string }> {
    // Tear down any previous session.
    this.disconnect();

    const trimmed = (host || "").trim();
    if (!trimmed) return Promise.resolve({ ok: false, error: "Empty host" });

    this.host = trimmed;
    this.model.reset();
    this.resetSceneState();
    const conn = new Connection({ host: trimmed, port });
    this.conn = conn;

    this.wireEvents(conn);

    return conn
      .connect()
      .then((version) => ({ ok: true as const, version }))
      .catch((err: NodeJS.ErrnoException) => {
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

  /** Tear down any active demo session (timer + flags). Safe to call anytime. */
  private stopDemo(): void {
    if (this.demoTimer) {
      clearInterval(this.demoTimer);
      this.demoTimer = null;
    }
    if (this.demoMetersTimer) {
      clearInterval(this.demoMetersTimer);
      this.demoMetersTimer = null;
    }
    this.demoMeters = null;
    if (this.demoMode) {
      this.demoMode = false;
      this.demoVersion = null;
      this.send("sq:status", { connected: false, host: this.host });
      this.send("sq:log", { level: "warn", msg: "Demo mode stopped." });
    }
  }

  disconnect(): void {
    this.stopDemo();
    if (this.statusTimer) {
      clearInterval(this.statusTimer);
      this.statusTimer = null;
    }
    if (this.conn) {
      this.conn.disconnect();
      this.conn = null;
    }
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
    return { ...this.model.snapshot(), currentSceneName: this.currentSceneName() };
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

    if (this.demoMode) {
      this.send("sq:log", {
        level: "dsp",
        msg: `Monitor ${srcLabel} → ${destName} Out ${destChannel}`,
      });
      return;
    }
    if (this.conn?.connected) {
      const frame = Buffer.from([0xf7, 0x0b, 0x0b, 0x0d, side === "L" ? 0x00 : 0x01, 0x11, ch0 & 0xff, destType]);
      this.conn.send(frame);
      this.send("sq:log", {
        level: "dsp",
        msg: `Monitor ${srcLabel} → ${destName} Out ${destChannel}`,
      });
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

    if (this.demoMode) {
      this.send("sq:log", {
        level: "dsp",
        msg: `PAFL ${label}: ${on ? "ON" : "OFF"}`,
      });
      return;
    }
    if (this.conn?.connected) {
      const val = on ? 0x0001 : 0x0000;
      this.conn.send(Buffer.from([0xf7, 0x08, 0x15, 0x0c, b3, 0x00, val & 0xff, (val >> 8) & 0xff]));
      this.send("sq:log", {
        level: "dsp",
        msg: `PAFL ${label}: ${on ? "ON" : "OFF"}`,
      });
    }
  }

  /**
   * Route a source (input channel, mix bus, or Main LR) to a physical output.
   * sourceB3: channel address (0x00–0x2f inputs, 0x58–0x63 Mix 1-12, 0x68 Main LR).
   * destType: 0x1a Local, 0x1b ME, 0x1c SLink, 0x1d USB, 0x1e IOPort.
   * destChannel: 1-based channel number on that output bus.
   */
  setOutputPatch(sourceB3: number, destType: number, destChannel: number): void {
    const ch0 = destChannel - 1;
    const destName =
      destType === 0x1a ? "Local" :
      destType === 0x1b ? "ME" :
      destType === 0x1c ? "SLink" :
      destType === 0x1d ? "USB" :
      destType === 0x1e ? "IOPort" : `0x${destType.toString(16)}`;

    this.sendPatchFrame(sourceB3, 0x0f, ch0 & 0xff, destType & 0xff);
    this.send("sq:log", {
      level: "dsp",
      msg: `Route ${b3ToLabel(sourceB3)} → ${destName} Out ${destChannel}`,
    });
    // In demo mode the model changed locally — flush so the UI reflects it.
    if (this.demoMode) {
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

    this.sendPatchFrame(sourceChannel, source, destB3, 0x20);
    this.send("sq:log", {
      level: "dsp",
      msg: `Input ${destLabel} → ${srcLabel} ${sourceChannel + 1}`,
    });
    // In demo mode the model changed locally — flush so the UI reflects it.
    if (this.demoMode) {
      this.send("sq:routing", this.snapshot());
    }
  }

  /** Force the mixer to re-send its full routing/state dump. */
  requestDump(): void {
    if (this.demoMode) {
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
    if (this.demoMode) {
      const v = this.demoVersion;
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
    if (this.demoMode) {
      this.send("sq:routing", this.snapshot());
    }

    return { ok: true, applied, skipped };
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
      return { ch: b3, modifier: 0x0f, valLo, valHi };
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
  private sendPatchFrame(ch: number, modifier: number, valLo: number, valHi: number): void {
    const payload = Buffer.from([0x0b, 0x0b, 0x0d, ch, modifier, valLo, valHi]);
    if (this.demoMode) {
      this.model.handleDsp({
        ch,
        category: 0x0b,
        register: 0x0d,
        modifier,
        value: (valLo & 0xff) | ((valHi & 0xff) << 8),
        raw: payload,
      });
    } else if (this.conn?.connected) {
      this.conn.send(Buffer.concat([Buffer.from([0xf7]), payload]));
    }
  }

  // ── Demo mode ──────────────────────────────────────────────────────

  /**
   * Start a fully simulated session — no mixer required. Populates the routing
   * model with a realistic SQ-5 show (16 local in / 8 local out) and streams
   * periodic live changes so the UI feels alive.
   */
  startDemo(): { ok: true; version: VersionInfo; spec: SQModelSpec } | { ok: false; error: string } {
    try {
      this.stopDemo();

      this.demoMode = true;
      this.host = "demo (simulated SQ-5)";
      this.demoVersion = {
        model: 0x01,
        modelName: "SQ-5",
        fwA: 1,
        fwB: 9,
        build: 4,
      };
      const spec = modelSpec(0x01); // SQ-5: 16 local in, 12 XLR + 2 TRS out

      this.model.reset();
      this.resetSceneState();
      this.demoBurstGen++;

      // Simulated scene library + the currently-recalled scene.
      this.sceneNames.set(0, "Soundcheck");
      this.sceneNames.set(1, "Sunday Service");
      this.sceneNames.set(2, "Rehearsal");
      this.currentSceneId = 1;

      // Emit initial status + log.
      this.send("sq:status", { connected: true, host: this.host, version: this.demoVersion, spec });
      this.send("sq:log", {
        level: "ok",
        msg: `Демо-режим: симуляция ${spec.name} (FW 1.9.4) · ${spec.description}`,
      });

      // Simulate the console's fast initial handshake flood: instead of one
      // instant full snapshot, data arrives as a rapid burst of progressively
      // richer routing snapshots so the UI populates quickly, like a real mixer.
      this.startDemoInitialBurst();

      // Stream simulated input meters alongside the routing burst.
      this.startDemoMeters();

      return { ok: true, version: this.demoVersion, spec };
    } catch (err) {
      this.demoMode = false;
      const msg = err instanceof Error ? err.message : String(err);
      return { ok: false, error: `Demo failed: ${msg}` };
    }
  }

  /** Apply a simulated input patch to the routing model. */
  private applyInputPatch(destB3: number, source: number, srcChannel: number): void {
    const raw = Buffer.from([0x0b, 0x0b, 0x0d, srcChannel, source, destB3, 0x20]);
    this.model.handleDsp({ ch: srcChannel, category: 0x0b, register: 0x0d, modifier: source, value: destB3 | (0x20 << 8), raw });
  }

  /** Apply a simulated output patch to the routing model. */
  private applyOutputPatch(sourceB3: number, dest: number, destChannel0: number): void {
    const raw = Buffer.from([0x0b, 0x0b, 0x0d, sourceB3, 0x0f, destChannel0, dest]);
    this.model.handleDsp({ ch: sourceB3, category: 0x0b, register: 0x0d, modifier: 0x0f, value: destChannel0 | (dest << 8), raw });
  }

  private applyFxPatch(fxIndex: number, lr: "L" | "R", dest: number, destChannel0: number): void {
    const srcCat = lr === "L" ? 0x16 : 0x17;
    const raw = Buffer.from([0x0b, 0x0b, 0x0d, fxIndex, srcCat, destChannel0, dest]);
    this.model.handleDsp({ ch: fxIndex, category: 0x0b, register: 0x0d, modifier: srcCat, value: destChannel0 | (dest << 8), raw });
  }

  private applyMonitorPatch(source: number, dest: number, destChannel0: number): void {
    const raw = Buffer.from([0x0b, 0x0b, 0x0d, source, 0x11, destChannel0, dest]);
    this.model.handleDsp({ ch: source, category: 0x0b, register: 0x0d, modifier: 0x11, value: destChannel0 | (dest << 8), raw });
  }

  /**
   * Simulate the console's fast initial handshake flood. The full routing
   * state is not delivered as one instant snapshot — instead a rapid series
   * of progressively richer snapshots is pushed to the renderer (~50ms apart),
   * so the tables visibly populate in a burst, mirroring a real SQ handshake.
   */
  private startDemoInitialBurst(): void {
    const generation = this.demoBurstGen;
    const alive = (): boolean => this.demoMode && generation === this.demoBurstGen;

    const names: Record<number, string> = {
      // Local inputs (Ch1-16)
      0: "Kick", 1: "Snare",
      2: "OH L", 3: "OH R",       // Ch3-4 stereo
      4: "Hat", 5: "Bass",
      6: "Gtr L", 7: "Gtr R",     // Ch7-8 stereo
      8: "Key L", 9: "Key R",     // Ch9-10 stereo
      10: "Vox", 11: "BGV 1",
      12: "BGV 2", 13: "Sax",
      14: "Clk L", 15: "Clk R",   // Ch15-16 stereo
      // SLink (Ch17-32)
      16: "Trk L", 17: "Trk R",   // Ch17-18 stereo
      18: "Talk", 19: "Tpt",
      20: "Tbn", 21: "Tuba",
      22: "Ac G", 23: "Cajon",
      24: "Prc 1", 25: "Prc 2",
      26: "Vln", 27: "Cello",
      28: "FX1 L", 29: "FX1 R",   // Ch29-30 stereo
      30: "FX2 L", 31: "FX2 R",   // Ch31-32 stereo
      // USB (Ch33-48)
      32: "STM L", 33: "STM R",   // Ch33-34 stereo
      34: "Clk T", 35: "Tlk T",
      36: "MD L", 37: "MD R",     // Ch37-38 stereo
      38: "Sp 1", 39: "Sp 2",
      40: "Sp 3", 41: "Sp 4",
      42: "Sp 5", 43: "Sp 6",
      44: "Sp 7", 45: "Sp 8",
      46: "Sp 9", 47: "Sp 10",
    };

    // Each phase mutates the model, then a fresh snapshot is flushed to the UI.
    const phases: Array<() => void> = [
      // Phase 1 — channel names.
      () => {
        for (const [b3, name] of Object.entries(names)) {
          this.model.setChannelName(Number(b3), name.substring(0, 6));
        }
      },
      // Phase 2 — input patches.
      () => {
        for (let ch = 0; ch < 16; ch++) this.applyInputPatch(ch, Src.Local, ch);
        for (let i = 0; i < 16; i++) this.applyInputPatch(16 + i, Src.SLink, i);
        for (let i = 0; i < 16; i++) this.applyInputPatch(32 + i, Src.USB, i);
      },
      // Phase 3 — stereo pairs.
      () => {
        this.model.stereoPairs = [
          [2, 3], [6, 7], [8, 9], [14, 15], [16, 17],
          [28, 29], [30, 31], [32, 33], [36, 37],
        ];
      },
      // Phase 4 — output patches.
      () => {
        this.applyOutputPatch(0x68, Dest.Local, 0); // Main LR → Local Out 1/2
        const mixBase = 0x58;
        for (let m = 0; m < 4; m++) this.applyOutputPatch(mixBase + m, Dest.Local, 2 + m);
        for (let m = 0; m < 4; m++) this.applyOutputPatch(mixBase + 4 + m, Dest.SLink, m);
        this.applyFxPatch(0, "L", Dest.USB, 0);
        this.applyFxPatch(0, "R", Dest.USB, 1);
        this.applyFxPatch(1, "L", Dest.USB, 2);
        this.applyFxPatch(1, "R", Dest.USB, 3);
        this.applyMonitorPatch(0, Dest.Local, 6);
      },
      // Phase 5 — routing/config block + kick off live simulation.
      () => {
        this.model.routingBlockBytes = 928;
        this.send("sq:log", {
          level: "ok",
          msg: `Initial state loaded: ${this.snapshot().inputs.length} input patches, ${this.snapshot().outputs.length} output patches.`,
        });
        this.startDemoSimulation();
      },
    ];

    // Push each phase as its own fast snapshot (50ms apart — a quick burst).
    phases.forEach((phase, i) => {
      setTimeout(() => {
        if (!alive()) return;
        phase();
        this.send("sq:routing", this.snapshot());
      }, i * 50);
    });

    // Once the burst is done, tell the renderer the initial fill is complete
    // so it can freeze the Input Patching list against later console changes.
    setTimeout(() => {
      if (!alive()) return;
      this.send("sq:initialState", {});
    }, phases.length * 50 + 10);
  }

  /** Periodically simulate live routing changes on the console. */
  private startDemoSimulation(): void {
    const scenarios: Array<() => string> = [
      // Re-patch input channel 7 (Gtr 1) between Local and SLink
      () => {
        const useLocal = Math.random() > 0.5;
        this.applyInputPatch(6, useLocal ? 0x01 : 0x02, useLocal ? 6 : 0);
        return `Input 7 (Gtr 1) → ${useLocal ? "Local 7" : "SLink 1"}`;
      },
      // Re-patch input channel 11 (Lead Vox) between Local and SLink
      () => {
        const useLocal = Math.random() > 0.5;
        this.applyInputPatch(10, useLocal ? 0x01 : 0x02, useLocal ? 10 : 1);
        return `Input 11 (Lead Vox) → ${useLocal ? "Local 11" : "SLink 2"}`;
      },
      // Move Mix 3 output between Local Out and SLink
      () => {
        const toSLink = Math.random() > 0.5;
        this.applyOutputPatch(0x5a, toSLink ? 0x1c : 0x1a, toSLink ? 0 : 4);
        return `Mix 3 → ${toSLink ? "SLink Out 1" : "Local Out 5"}`;
      },
      // Move Main LR between Local Out 1/2 and USB
      () => {
        const toUsb = Math.random() > 0.5;
        this.applyOutputPatch(0x68, toUsb ? 0x1d : 0x1a, toUsb ? 0 : 0);
        return `Main LR → ${toUsb ? "USB Out 1/2" : "Local Out 1/2"}`;
      },
      // Re-patch backing track channel 17 (Track L) between SLink and USB
      () => {
        const src = Math.random() > 0.5 ? 0x02 : 0x03;
        this.applyInputPatch(16, src, 0);
        return `Input 17 (Track L) → ${src === 0x02 ? "SLink 1" : "USB 1"}`;
      },
      // FX1 return routing change between Local and USB
      () => {
        const toUsb = Math.random() > 0.5;
        this.applyFxPatch(0, "L", toUsb ? 0x1d : 0x1a, toUsb ? 0 : 7);
        this.applyFxPatch(0, "R", toUsb ? 0x1d : 0x1a, toUsb ? 1 : 7);
        return `FX1 Return → ${toUsb ? "USB Out 1/2" : "Local Out 8"}`;
      },
      // Recall the next demo scene so the "current scene" tracks visibly.
      () => {
        const names = ["Soundcheck", "Sunday Service", "Rehearsal"];
        const next = ((this.currentSceneId ?? -1) + 1) % names.length;
        this.currentSceneId = next;
        return `Scene recalled: ${next + 1} — ${names[next]}`;
      },
    ];

    let tick = 0;
    this.demoTimer = setInterval(() => {
      if (!this.demoMode) return;
      try {
        const action = scenarios[tick % scenarios.length];
        tick++;
        const desc = action();
        this.send("sq:log", { level: "dsp", msg: ` Routing change: ${desc}` });
        this.send("sq:routing", this.snapshot());
      } catch (err) {
        // Never let the simulation timer crash the main process.
        this.send("sq:log", {
          level: "error",
          msg: `Demo simulation error: ${err instanceof Error ? err.message : String(err)}`,
        });
      }
    }, 4500);
    this.demoTimer.unref();
  }

  /**
   * Stream simulated input meters (~25 Hz), mirroring the real UDP meter
   * stream. Active channels are re-read from the routing model on every
   * tick, so the bars follow demo routing changes and refreshes
   * automatically.
   */
  private startDemoMeters(): void {
    this.demoMeters = new DemoMetersSim();
    this.demoMetersTimer = setInterval(() => {
      if (!this.demoMode || !this.demoMeters) return;
      try {
        const snap = this.model.snapshot();
        this.demoMeters.sync(snap.inputs, snap.stereoPairs);
        this.send("sq:meters", this.demoMeters.tick());
      } catch (err) {
        // Never let the meter simulation crash the main process.
        this.send("sq:log", {
          level: "error",
          msg: `Demo meters error: ${err instanceof Error ? err.message : String(err)}`,
        });
      }
    }, DEMO_METERS_TICK_MS);
    this.demoMetersTimer.unref();
  }

  /**
   * Demo-mode "Обновить": regenerate a completely new simulated routing —
   * different channel names, different stereo pairs, different patching.
   * Pushes the fresh snapshot to the renderer and returns it.
   */
  demoRefresh(): RoutingSnapshot {
    if (!this.demoMode) return this.snapshot();

    const generation = ++this.demoRefreshGen;
    const variant = generation % DEMO_VARIANTS.length;
    const config = DEMO_VARIANTS[variant];

    this.model.reset();
    this.model.routingBlockBytes = 928;

    // Channel names.
    for (const [b3, name] of Object.entries(config.names)) {
      this.model.setChannelName(Number(b3), name.substring(0, 6));
    }

    // Stereo pairs.
    this.model.stereoPairs = config.stereoPairs;

    // Input patches.
    for (const p of config.inputs) {
      this.applyInputPatch(p.destB3, p.source, p.sourceChannel);
    }

    // Output patches.
    for (const p of config.outputs) {
      if (p.kind === "output") this.applyOutputPatch(p.sourceB3, p.dest, p.destChannel0);
      else if (p.kind === "fx") this.applyFxPatch(p.fxIndex, p.lr, p.dest, p.destChannel0);
      else this.applyMonitorPatch(p.source, p.dest, p.destChannel0);
    }

    const snap = this.snapshot();
    this.send("sq:log", {
      level: "ok",
      msg: `Демо обновлено (вариант ${variant + 1}/${DEMO_VARIANTS.length}): ${snap.inputs.length} входов, ${snap.stereoPairs.length} стерео-пар.`,
    });
    this.send("sq:routing", snap);
    return snap;
  }

  private send(channel: string, payload: unknown): void {
    if (mainWindow && !mainWindow.isDestroyed()) {
      mainWindow.webContents.send(channel, payload);
    }
  }

  private wireEvents(conn: Connection): void {
    let dirty = false;
    const flush = (): void => {
      if (dirty) {
        dirty = false;
        this.send("sq:routing", this.snapshot());
      }
    };
    // Throttle routing snapshots so a burst of frames doesn't flood the UI.
    this.statusTimer = setInterval(flush, 120);
    this.statusTimer.unref();

    conn.on("dsp", (d: DspFrame) => {
      const wasRouting = this.model.handleDsp(d);
      if (wasRouting) dirty = true;

      // Surface routing-relevant raw frames for the live monitor.
      if (
        (d.category === 0x0b && d.register === 0x0d) ||
        (d.category === 0x02 && d.register === 0x1c)
      ) {
        const hex = Array.from(d.raw.slice(0, 8))
          .map((b) => b.toString(16).padStart(2, "0"))
          .join(" ");
        this.send("sq:log", { level: "dsp", msg: `DSP  ${hex}` });
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

    // Scene library updates (full list dump arrives on connect).
    conn.on("sceneName", (id: number, name: string | null) => {
      if (name) this.sceneNames.set(id, name);
      else this.sceneNames.delete(id);
      dirty = true;
    });

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
      flush();
      // Initial fill is complete — renderer freezes the Input Patching list.
      this.send("sq:initialState", {});
    });

    conn.on("connect", (v: VersionInfo) => {
      this.send("sq:status", {
        connected: true,
        host: this.host,
        version: v,
        spec: modelSpec(v.model),
      });
      this.send("sq:log", {
        level: "ok",
        msg: `Connected to ${v.modelName} (FW ${v.fwA}.${v.fwB}${
          v.build !== undefined ? "." + v.build : ""
        }) at ${this.host}`,
      });
    });

    conn.on("disconnect", () => {
      this.send("sq:status", { connected: false, host: this.host });
      this.send("sq:log", { level: "warn", msg: "Disconnected from mixer." });
    });

    // Live input meters streamed over UDP (~25-50 packets/s). The renderer
    // coalesces them per animation frame, so forwarding each is fine.
    conn.on("meters", (m: MetersPayload) => {
      this.send("sq:meters", m);
    });

    conn.on("error", (err: Error) => {
      this.send("sq:log", { level: "error", msg: `Connection error: ${err.message}` });
    });
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
  ipcMain.handle("sq:setOutputPatch", (_e, sourceB3: number, destType: number, destChannel: number) => {
    controller.setOutputPatch(sourceB3, destType, destChannel);
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
  ipcMain.handle("sq:setInputPatch", (_e, destB3: number, source: number, sourceChannel: number) => {
    controller.setInputPatch(destB3, source, sourceChannel);
    return true;
  });
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
