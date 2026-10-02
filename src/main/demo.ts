/**
 * SQ Router Control — demo-mode session.
 *
 * Owns the fully simulated console used by the demo entry on the connect
 * screen: the routing show variants, channel-state seeding, the initial
 * handshake burst, the periodic live-routing simulation and the meter
 * stream. It mutates the same RoutingModel / MixerState the live path uses,
 * so the decode and UI paths are identical to a real connection.
 */
import { VersionInfo } from "./transport/connection";
import { RoutingModel, RoutingSnapshot } from "./routing";
import { MixerState } from "./state";
import { SQModelSpec, modelSpec } from "./models";
import { DemoMetersSim, DEMO_METERS_TICK_MS } from "./demo-meters";

/** Simulated console identity shown while in demo mode. */
export const DEMO_HOST = "demo (simulated SQ-5)";

/** Version frame the simulated SQ-5 reports (model 0x01, FW 1.9.4). */
export const DEMO_VERSION: VersionInfo = {
  model: 0x01,
  modelName: "SQ-5",
  fwA: 1,
  fwB: 9,
  build: 4,
};

/**
 * Demo routing variants for the "Обновить" button. Each variant is a fully
 * different simulated routing: distinct channel names, stereo pairs and
 * patching, so a refresh visibly regenerates the whole console state.
 */
interface DemoVariant {
  names: Record<number, string>;
  stereoPairs: number[][];
  /** Stereo-linked mix pairs as 0-based mix indexes (Mix 1 = 0). */
  mixStereoPairs: number[][];
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
      // FX returns 1-4 (b3 0x40-0x43)
      0x40: "VoxRvb", 0x41: "Slap", 0x42: "Plate", 0x43: "DrumVb",
      // Mix buses 1-12 (b3 0x58-0x63)
      0x58: "IEM1 L", 0x59: "IEM1 R", // Mix 1-2 stereo
      0x5a: "Drums", 0x5b: "Vox M", 0x5c: "Gtr M", 0x5d: "Key M",
      0x5e: "Wedge", 0x5f: "Foldb",
      0x60: "IEM2 L", 0x61: "IEM2 R", // Mix 9-10 stereo
      0x62: "Spill", 0x63: "Spare",
      // Matrix slots 1-6 (b3 0x73-0x78; stereo matrices share the name)
      0x73: "Subs", 0x74: "Subs", 0x75: "Lobby", 0x76: "Lobby",
      0x77: "Feed L", 0x78: "Feed R", // Matrix 3 split to mono
    },
    stereoPairs: [
      [2, 3], [6, 7], [8, 9], [14, 15], [16, 17],
      [28, 29], [30, 31], [32, 33], [36, 37],
    ],
    mixStereoPairs: [[0, 1], [8, 9]],
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
      { kind: "output", sourceB3: 0x73, dest: Dest.Local, destChannel0: 7 }, // Matrix 1 L
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
      // FX returns 1-4 (b3 0x40-0x43)
      0x40: "Hall", 0x41: "TapeDl", 0x42: "Chorus", 0x43: "Spare",
      // Mix buses 1-12 (b3 0x58-0x63)
      0x58: "Band", 0x59: "Vocal",
      0x5a: "IEM1 L", 0x5b: "IEM1 R", // Mix 3-4 stereo
      0x5c: "Wedge", 0x5d: "Drums",
      0x5e: "IEM2 L", 0x5f: "IEM2 R", // Mix 7-8 stereo
      0x60: "IEM 3", 0x61: "IEM 4", 0x62: "Spare", 0x63: "Foldb",
      // Matrix slots 1-6 (b3 0x73-0x78; stereo matrices share the name)
      0x73: "Mtx A", 0x74: "Mtx A", 0x75: "Mtx B", 0x76: "Mtx B",
      0x77: "Mtx C", 0x78: "Mtx C",
    },
    stereoPairs: [
      [0, 1], [6, 7], [16, 17], [28, 29], [30, 31], [32, 33], [36, 37],
    ],
    mixStereoPairs: [[2, 3], [6, 7]],
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
      // FX returns 1-4 (b3 0x40-0x43)
      0x40: "Plate", 0x41: "Echo", 0x42: "Flange", 0x43: "Spare",
      // Mix buses 1-12 (b3 0x58-0x63)
      0x58: "Drums", 0x59: "Vox 1", 0x5a: "Vox 2", 0x5b: "Gtr M",
      0x5c: "Bass", 0x5d: "Keys", 0x5e: "Horns", 0x5f: "IEM 1",
      0x60: "IEM 2", 0x61: "Wedge",
      0x62: "Rec L", 0x63: "Rec R", // Mix 11-12 stereo
      // Matrix slots 1-6 (b3 0x73-0x78; stereo matrices share the name)
      0x73: "Delay", 0x74: "Delay", 0x75: "Subs", 0x76: "Subs",
      0x77: "Mtx C", 0x78: "Mtx C",
    },
    stereoPairs: [
      [2, 3], [16, 17], [28, 29], [30, 31], [32, 33],
    ],
    mixStereoPairs: [[10, 11]],
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

// Demo scene library (index = 0-based scene id). Scene 3 is intentionally
// unnamed so the UI can exercise its "scene name unknown" placeholder/hint.
const DEMO_SCENE_NAMES: Array<string | null> = ["Soundcheck", "Sunday Service", null];

/** Bridge back into the owning controller: shared state + IPC/log sinks. */
export interface DemoHost {
  /** Live routing model (mutated by the simulation exactly as by real frames). */
  model: RoutingModel;
  /** Live channel-state model (fader/mute/gain/…). */
  mixer: MixerState;
  /** Scene-name library, shared with the controller's live scene tracking. */
  sceneNames: Map<number, string>;
  /** Push an IPC event to the renderer. */
  send(channel: string, payload: unknown): void;
  /** Apply an input patch straight to the routing model (shared with live path). */
  applyInputPatch(destB3: number, source: number, srcChannel: number): void;
  getSceneId(): number | null;
  setSceneId(id: number | null): void;
  /** Full controller snapshot (routing + scene name + channel state). */
  snapshot(): RoutingSnapshot;
}

/**
 * A fully simulated SQ session. Owns all demo-only state (timers, generator
 * counters) and drives the shared routing/mixer models through the host.
 */
export class DemoSession {
  private active = false;
  private version: VersionInfo | null = null;
  private timer: NodeJS.Timeout | null = null;
  /** Simulated input meter stream (demo only). */
  private meters: DemoMetersSim | null = null;
  private metersTimer: NodeJS.Timeout | null = null;
  /** Generation counter for the initial-burst timers (invalidated on restart). */
  private burstGen = 0;
  /** Generation counter for refresh() variants. */
  private refreshGen = 0;

  constructor(private readonly host: DemoHost) {}

  /** True while a simulated session is running. */
  get isActive(): boolean {
    return this.active;
  }

  /** Simulated console version info, or null when not in demo mode. */
  get deviceVersion(): VersionInfo | null {
    return this.active ? this.version : null;
  }

  /** Tear down any active demo session (timers + flags). Safe to call anytime. */
  stop(): void {
    if (this.timer) {
      clearInterval(this.timer);
      this.timer = null;
    }
    if (this.metersTimer) {
      clearInterval(this.metersTimer);
      this.metersTimer = null;
    }
    this.meters = null;
    if (this.active) {
      this.active = false;
      this.version = null;
      this.host.send("sq:status", { connected: false, host: DEMO_HOST });
      this.host.send("sq:log", { level: "warn", msg: "Demo mode stopped." });
    }
  }

  /**
   * Start a fully simulated session — no mixer required. Populates the routing
   * model with a realistic SQ-5 show (16 local in / 8 local out) and streams
   * periodic live changes so the UI feels alive.
   */
  start(): { ok: true; version: VersionInfo; spec: SQModelSpec } | { ok: false; error: string } {
    try {
      this.active = true;
      this.version = DEMO_VERSION;
      const spec = modelSpec(0x01); // SQ-5: 16 local in, 12 XLR + 2 TRS out

      this.host.model.reset();
      this.host.mixer.reset();
      this.seedMixerState();
      this.burstGen++;

      // Simulated scene library + the currently-recalled scene. Unnamed slots
      // are simply omitted, so currentSceneName() resolves to null for them.
      this.host.sceneNames.clear();
      this.host.setSceneId(null);
      DEMO_SCENE_NAMES.forEach((name, id) => {
        if (name) this.host.sceneNames.set(id, name);
      });
      this.host.setSceneId(1);

      // Emit initial status + log.
      this.host.send("sq:status", {
        connected: true,
        host: DEMO_HOST,
        version: this.version,
        spec,
      });
      this.host.send("sq:log", {
        level: "ok",
        msg: `Демо-режим: симуляция ${spec.name} (FW 1.9.4) · ${spec.description}`,
      });

      // Simulate the console's fast initial handshake flood: instead of one
      // instant full snapshot, data arrives as a rapid burst of progressively
      // richer routing snapshots so the UI populates quickly, like a real mixer.
      this.startInitialBurst();

      // Stream simulated input meters alongside the routing burst.
      this.startMeters();

      return { ok: true, version: this.version, spec };
    } catch (err) {
      this.active = false;
      const msg = err instanceof Error ? err.message : String(err);
      return { ok: false, error: `Demo failed: ${msg}` };
    }
  }

  /** Apply a simulated output patch to the routing model. */
  private applyOutputPatch(sourceB3: number, dest: number, destChannel0: number): void {
    const raw = Buffer.from([0x0b, 0x0b, 0x0d, sourceB3, 0x0f, destChannel0, dest]);
    this.host.model.handleDsp({ ch: sourceB3, category: 0x0b, register: 0x0d, modifier: 0x0f, value: destChannel0 | (dest << 8), raw });
  }

  private applyFxPatch(fxIndex: number, lr: "L" | "R", dest: number, destChannel0: number): void {
    const srcCat = lr === "L" ? 0x16 : 0x17;
    const raw = Buffer.from([0x0b, 0x0b, 0x0d, fxIndex, srcCat, destChannel0, dest]);
    this.host.model.handleDsp({ ch: fxIndex, category: 0x0b, register: 0x0d, modifier: srcCat, value: destChannel0 | (dest << 8), raw });
  }

  private applyMonitorPatch(source: number, dest: number, destChannel0: number): void {
    const raw = Buffer.from([0x0b, 0x0b, 0x0d, source, 0x11, destChannel0, dest]);
    this.host.model.handleDsp({ ch: source, category: 0x0b, register: 0x0d, modifier: 0x11, value: destChannel0 | (dest << 8), raw });
  }

  /**
   * Populate the channel-state model with a plausible simulated show, the
   * same way the real console's ParamData dump would. Values are fed through
   * mixer.handleDsp as synthetic live frames, so the decode path is identical
   * to a real connection.
   */
  private seedMixerState(): void {
    const dsp = (b3: number, category: number, register: number, modifier: number, value: number): void => {
      this.host.mixer.handleDsp({ ch: b3, category, register, modifier, value, raw: Buffer.alloc(0) });
    };
    for (let b3 = 0; b3 <= 0x2f; b3++) {
      // Fader between −12 and +3 dB (deterministic per channel).
      dsp(b3, 0x07, 0x0e, 0x20, Math.round(0x8000 + (-12 + ((b3 * 7) % 16)) * 256));
      // Every 9th channel starts muted.
      dsp(b3, 0x07, 0x0c, 0x00, b3 % 9 === 8 ? 1 : 0);
      // Preamp gain 20..44 dB, small trim variations.
      dsp(b3, 0x0c, 0x0c, 0x01, Math.round(0x8000 + (20 + ((b3 * 5) % 25)) * 256));
      dsp(b3, 0x0c, 0x0f, 0x00, Math.round(31724 + (((b3 * 3) % 7) - 3) * 212.5));
      // Pan slightly off-center on some channels (wire 37 = center).
      dsp(b3, 0x07, 0x10, 0x20, 37 + (((b3 % 5) - 2) * 6));
      // HPF (100 Hz) on every third channel.
      dsp(b3, 0x0e, 0x0c, 0x00, b3 % 3 === 1 ? 1 : 0);
      dsp(b3, 0x0e, 0x0d, 0x00, Math.round(-9206 + 15308 * Math.log10(100)));
      // Bus 1 send at half level on every 4th channel.
      dsp(b3, 0x07, 0x0e, 0x10, b3 % 4 === 0 ? 35328 >> 1 : 0);
    }
    // Mix buses and Main LR faders.
    for (let b3 = 0x58; b3 <= 0x68; b3++) {
      dsp(b3, 0x07, 0x0e, 0x20, Math.round(0x8000 + (b3 === 0x68 ? 0 : -6) * 256));
      dsp(b3, 0x07, 0x0c, 0x00, 0);
    }
  }

  /**
   * Simulate the console's fast initial handshake flood. The full routing
   * state is not delivered as one instant snapshot — instead a rapid series
   * of progressively richer snapshots is pushed to the renderer (~50ms apart),
   * so the tables visibly populate in a burst, mirroring a real SQ handshake.
   */
  private startInitialBurst(): void {
    const generation = this.burstGen;
    const alive = (): boolean => this.active && generation === this.burstGen;

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
      // FX returns 1-4 (b3 0x40-0x43)
      0x40: "VoxRvb", 0x41: "Slap", 0x42: "Plate", 0x43: "DrumVb",
      // Mix buses 1-12 (b3 0x58-0x63)
      0x58: "IEM1 L", 0x59: "IEM1 R", // Mix 1-2 stereo
      0x5a: "Drums", 0x5b: "Vox M", 0x5c: "Gtr M", 0x5d: "Key M",
      0x5e: "Wedge", 0x5f: "Foldb",
      0x60: "IEM2 L", 0x61: "IEM2 R", // Mix 9-10 stereo
      0x62: "Spill", 0x63: "Spare",
      // Matrix slots 1-3 (b3 0x73-0x75), named consecutively like the reference
      // SQ-5 dump — three mono matrices share the three Mtx buttons (MON-B6).
      0x73: "MainPA", 0x74: "FrntFl", 0x75: "YouTMx",
    };

    // Each phase mutates the model, then a fresh snapshot is flushed to the UI.
    const phases: Array<() => void> = [
      // Phase 1 — channel names.
      () => {
        for (const [b3, name] of Object.entries(names)) {
          this.host.model.setChannelName(Number(b3), name.substring(0, 6));
        }
      },
      // Phase 2 — input patches.
      () => {
        for (let ch = 0; ch < 16; ch++) this.host.applyInputPatch(ch, Src.Local, ch);
        for (let i = 0; i < 16; i++) this.host.applyInputPatch(16 + i, Src.SLink, i);
        for (let i = 0; i < 16; i++) this.host.applyInputPatch(32 + i, Src.USB, i);
      },
      // Phase 3 — stereo pairs.
      () => {
        this.host.model.stereoPairs = [
          [2, 3], [6, 7], [8, 9], [14, 15], [16, 17],
          [28, 29], [30, 31], [32, 33], [36, 37],
        ];
        this.host.model.mixStereoPairs = [[0, 1], [8, 9]];
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
        this.host.model.routingBlockBytes = 928;
        this.host.send("sq:log", {
          level: "ok",
          msg: `Initial state loaded: ${this.host.snapshot().inputs.length} input patches, ${this.host.snapshot().outputs.length} output patches.`,
        });
        this.startSimulation();
      },
    ];

    // Push each phase as its own fast snapshot (50ms apart — a quick burst).
    phases.forEach((phase, i) => {
      setTimeout(() => {
        if (!alive()) return;
        phase();
        this.host.send("sq:routing", this.host.snapshot());
      }, i * 50);
    });

    // Once the burst is done, tell the renderer the initial fill is complete
    // so it can freeze the Input Patching list against later console changes.
    setTimeout(() => {
      if (!alive()) return;
      this.host.send("sq:initialState", {});
    }, phases.length * 50 + 10);
  }

  /** Periodically simulate live routing changes on the console. */
  private startSimulation(): void {
    const scenarios: Array<() => string> = [
      // Re-patch input channel 7 (Gtr 1) between Local and SLink
      () => {
        const useLocal = Math.random() > 0.5;
        this.host.applyInputPatch(6, useLocal ? 0x01 : 0x02, useLocal ? 6 : 0);
        return `Input 7 (Gtr 1) → ${useLocal ? "Local 7" : "SLink 1"}`;
      },
      // Re-patch input channel 11 (Lead Vox) between Local and SLink
      () => {
        const useLocal = Math.random() > 0.5;
        this.host.applyInputPatch(10, useLocal ? 0x01 : 0x02, useLocal ? 10 : 1);
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
        this.host.applyInputPatch(16, src, 0);
        return `Input 17 (Track L) → ${src === 0x02 ? "SLink 1" : "USB 1"}`;
      },
      // FX1 return routing change between Local and USB
      () => {
        const toUsb = Math.random() > 0.5;
        this.applyFxPatch(0, "L", toUsb ? 0x1d : 0x1a, toUsb ? 0 : 7);
        this.applyFxPatch(0, "R", toUsb ? 0x1d : 0x1a, toUsb ? 1 : 7);
        return `FX1 Return → ${toUsb ? "USB Out 1/2" : "Local Out 8"}`;
      },
      // NOTE: scene recall is NOT part of the periodic simulation — in demo
      // mode the scene changes only when the user presses "Обновить"
      // (see refresh).
    ];

    let tick = 0;
    this.timer = setInterval(() => {
      if (!this.active) return;
      try {
        const action = scenarios[tick % scenarios.length];
        tick++;
        const desc = action();
        // Rotate a live mute toggle so the channel-state column visibly
        // updates between refreshes (exercises the live DSP update path).
        const mch = (tick - 1) % 24;
        const muted = Math.floor((tick - 1) / 24) % 2 === 1;
        this.host.mixer.handleDsp({
          ch: mch,
          category: 0x07,
          register: 0x0c,
          modifier: 0x00,
          value: muted ? 1 : 0,
          raw: Buffer.alloc(0),
        });
        this.host.send("sq:log", { level: "dsp", msg: ` Routing change: ${desc}` });
        this.host.send("sq:routing", this.host.snapshot());
      } catch (err) {
        // Never let the simulation timer crash the main process.
        this.host.send("sq:log", {
          level: "error",
          msg: `Demo simulation error: ${err instanceof Error ? err.message : String(err)}`,
        });
      }
    }, 4500);
    this.timer.unref();
  }

  /**
   * Stream simulated input meters (~25 Hz), mirroring the real UDP meter
   * stream. Active channels are re-read from the routing model on every
   * tick, so the bars follow demo routing changes and refreshes
   * automatically.
   */
  private startMeters(): void {
    this.meters = new DemoMetersSim();
    this.metersTimer = setInterval(() => {
      if (!this.active || !this.meters) return;
      try {
        const snap = this.host.model.snapshot();
        this.meters.sync(snap.inputs, snap.stereoPairs, snap.mixStereoPairs);
        this.host.send("sq:meters", this.meters.tick());
      } catch (err) {
        // Never let the meter simulation crash the main process.
        this.host.send("sq:log", {
          level: "error",
          msg: `Demo meters error: ${err instanceof Error ? err.message : String(err)}`,
        });
      }
    }, DEMO_METERS_TICK_MS);
    this.metersTimer.unref();
  }

  /**
   * Demo-mode "Обновить": regenerate a completely new simulated routing —
   * different channel names, different stereo pairs, different patching —
   * and recall the next demo scene. The scene changes ONLY here: the
   * periodic simulation never touches it. Pushes the fresh snapshot to the
   * renderer and returns it.
   */
  refresh(): RoutingSnapshot {
    if (!this.active) return this.host.snapshot();

    const generation = ++this.refreshGen;
    const variant = generation % DEMO_VARIANTS.length;
    const config = DEMO_VARIANTS[variant];

    // Recall the next demo scene (cyclically). Scene 3 is unnamed on purpose.
    const nextScene = ((this.host.getSceneId() ?? -1) + 1) % DEMO_SCENE_NAMES.length;
    this.host.setSceneId(nextScene);
    const nextSceneName = DEMO_SCENE_NAMES[nextScene];
    if (nextSceneName) this.host.sceneNames.set(nextScene, nextSceneName);
    else this.host.sceneNames.delete(nextScene);

    this.host.model.reset();
    this.host.mixer.reset();
    this.seedMixerState();
    this.host.model.routingBlockBytes = 928;

    // Channel names.
    for (const [b3, name] of Object.entries(config.names)) {
      this.host.model.setChannelName(Number(b3), name.substring(0, 6));
    }

    // Stereo pairs.
    this.host.model.stereoPairs = config.stereoPairs;
    this.host.model.mixStereoPairs = config.mixStereoPairs;

    // Input patches.
    for (const p of config.inputs) {
      this.host.applyInputPatch(p.destB3, p.source, p.sourceChannel);
    }

    // Output patches.
    for (const p of config.outputs) {
      if (p.kind === "output") this.applyOutputPatch(p.sourceB3, p.dest, p.destChannel0);
      else if (p.kind === "fx") this.applyFxPatch(p.fxIndex, p.lr, p.dest, p.destChannel0);
      else this.applyMonitorPatch(p.source, p.dest, p.destChannel0);
    }

    const snap = this.host.snapshot();
    this.host.send("sq:log", {
      level: "ok",
      msg: `Scene recalled: ${nextScene + 1}${nextSceneName ? ` — ${nextSceneName}` : " (name not yet known)"}`,
    });
    this.host.send("sq:log", {
      level: "ok",
      msg: `Демо обновлено (вариант ${variant + 1}/${DEMO_VARIANTS.length}): ${snap.inputs.length} входов, ${snap.stereoPairs.length} стерео-пар.`,
    });
    this.host.send("sq:routing", snap);
    return snap;
  }
}
