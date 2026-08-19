/**
 * SQ routing decoder & state model.
 *
 * Patching on the SQ uses DSP frames with category=0x0b, register=0x0d:
 *   F7 0b 0b 0d [ch] [modifier] [valLo] [valHi]
 *
 * Decoded by the modifier byte:
 *   modifier 0x01..0x04  → INPUT PATCH  (physical source → mixer input channel)
 *   modifier 0x0f        → OUTPUT PATCH (mixer bus → physical output socket)
 *   modifier 0x16/0x17   → FX RETURN OUTPUT PATCH (L / R)
 *   modifier 0x11        → MONITOR OUTPUT PATCH
 *
 * This mirrors the setInputPatch/setOutputPatch setters in the reference API,
 * so incoming frames can be decoded symmetrically.
 */
import { DspFrame } from "./transport/connection";

// ── IP Patch enums (from the SQ protocol) ────────────────────────────────────

export enum InputPatchSource {
  Local = 0x01,
  SLink = 0x02,
  USB = 0x03,
  IOPort = 0x04,
}

export enum OutputPatchDest {
  Local = 0x1a,
  ME = 0x1b,
  SLink = 0x1c,
  USB = 0x1d,
  IOPort = 0x1e,
}

export enum MonitorOutSource {
  PaflL = 0x00,
  PaflR = 0x01,
  ListenL = 0x02,
  ListenR = 0x03,
  ListenM = 0x04,
  Talkback = 0x05,
}

export const INPUT_SOURCE_LABEL: Record<number, string> = {
  [InputPatchSource.Local]: "Local",
  [InputPatchSource.SLink]: "dSnake / SLink",
  [InputPatchSource.USB]: "USB",
  [InputPatchSource.IOPort]: "I/O Port",
};

export const OUTPUT_DEST_LABEL: Record<number, string> = {
  [OutputPatchDest.Local]: "Local Out",
  [OutputPatchDest.ME]: "ME (Mon)",
  [OutputPatchDest.SLink]: "dSnake / SLink",
  [OutputPatchDest.USB]: "USB",
  [OutputPatchDest.IOPort]: "I/O Port",
};

export const MONITOR_SOURCE_LABEL: Record<number, string> = {
  [MonitorOutSource.PaflL]: "PAFL L",
  [MonitorOutSource.PaflR]: "PAFL R",
  [MonitorOutSource.ListenL]: "Listen L",
  [MonitorOutSource.ListenR]: "Listen R",
  [MonitorOutSource.ListenM]: "Listen M",
  [MonitorOutSource.Talkback]: "Talkback",
};

// ── Address-space → human label ──────────────────────────────────────────────

export function b3ToLabel(b3: number): string {
  if (b3 >= 0x00 && b3 <= 0x2f) return `Input ${b3 + 1}`;
  if (b3 >= 0x30 && b3 <= 0x32) return `St In ${b3 - 0x30 + 1}`;
  if (b3 >= 0x37 && b3 <= 0x3e) return `DCA ${b3 - 0x37 + 1}`;
  if (b3 >= 0x40 && b3 <= 0x43) return `FX ${b3 - 0x40 + 1}`;
  if (b3 >= 0x58 && b3 <= 0x63) return `Mix ${b3 - 0x58 + 1}`;
  if (b3 === 0x68) return "Main LR";
  return `b3 0x${b3.toString(16).padStart(2, "0")}`;
}

/**
 * Reverse lookup: human label (as produced by b3ToLabel) → b3 address.
 * Used when reconstructing output-patch frames from a saved routing.
 */
let _labelToB3Cache: Record<string, number> | null = null;
export function labelToB3(label: string): number | null {
  if (!_labelToB3Cache) {
    const m: Record<string, number> = {};
    for (let b3 = 0; b3 <= 0x7f; b3++) {
      const lbl = b3ToLabel(b3);
      if (!(lbl in m)) m[lbl] = b3;
    }
    _labelToB3Cache = m;
  }
  const v = _labelToB3Cache[label];
  return v !== undefined ? v : null;
}

/** Reverse lookup for monitor output-patch source labels → source code. */
export const MONITOR_LABEL_TO_SOURCE: Record<string, number> = (() => {
  const m: Record<string, number> = {};
  for (const [k, v] of Object.entries(MONITOR_SOURCE_LABEL)) m[v] = Number(k);
  return m;
})();

// ── Decoded patch records ────────────────────────────────────────────────────

export interface InputPatch {
  destB3: number;
  destLabel: string;
  name: string;
  source: number;
  sourceLabel: string;
  sourceChannel: number;
}

export interface OutputPatch {
  kind: "bus" | "fx" | "monitor";
  sourceLabel: string;
  dest: number;
  destLabel: string;
  destChannel: number;
}

// ── Routing state model ──────────────────────────────────────────────────────

export interface RoutingSnapshot {
  inputs: InputPatch[];
  outputs: OutputPatch[];
  /** Stereo-linked channel pairs: each entry is [leftB3, rightB3]. */
  stereoPairs: number[][];
  /** number of routing update frames received. */
  updates: number;
  /** last routing/config block (sub=0x10) byte length, if any. */
  routingBlockBytes: number | null;
  /** Name of the console's currently-active scene, if known (merged in by the controller). */
  currentSceneName?: string | null;
}

export class RoutingModel {
  /** destB3 → input patch */
  private inputPatches = new Map<number, InputPatch>();
  private outputPatches: OutputPatch[] = [];
  private updates = 0;
  routingBlockBytes: number | null = null;

  /** Channel names discovered from the initial ParamData (b3 → name). */
  names = new Map<number, string>();

  /** Stereo-linked channel pairs: [[leftB3, rightB3], ...] — must be even-odd b3 (odd-even Ch). */
  private _stereoPairs: number[][] = [];
  get stereoPairs(): number[][] { return this._stereoPairs; }
  set stereoPairs(pairs: number[][]) {
    // Enforce: each pair must be [evenB3, evenB3+1] (odd Ch - even Ch, e.g. Ch3-4)
    this._stereoPairs = pairs.filter(
      (p) => p.length === 2 && p[0] % 2 === 0 && p[1] === p[0] + 1
    );
  }

  /**
   * Try to decode a DSP frame as a patch frame. Returns true if it was a
   * routing frame and the model was updated.
   */
  handleDsp(d: DspFrame): boolean {
    // Patch frames: category 0x0b, register 0x0d.
    if (d.category !== 0x0b || d.register !== 0x0d) return false;

    const raw = d.raw;
    // raw is the 7 payload bytes after 0xF7 (may be empty for synthesised
    // initial-state events — those are not patch frames, ignore).
    if (!raw || raw.length < 7) return false;

    const ch = raw[3];
    const mod = raw[4];
    const valLo = raw[5];
    const valHi = raw[6];

    // INPUT PATCH: modifier is one of the input source codes.
    if (mod >= 0x01 && mod <= 0x04) {
      const destB3 = valLo;
      const rec: InputPatch = {
        destB3,
        destLabel: b3ToLabel(destB3),
        name: this.names.get(destB3) ?? "",
        source: mod,
        sourceLabel: INPUT_SOURCE_LABEL[mod] ?? `Src 0x${mod.toString(16)}`,
        sourceChannel: ch,
      };
      this.inputPatches.set(destB3, rec);
      this.updates++;
      return true;
    }

    // OUTPUT PATCH (mixer bus → physical output): modifier 0x0f.
    if (mod === 0x0f) {
      const sourceB3 = ch;
      const dest = valHi;
      const rec: OutputPatch = {
        kind: "bus",
        sourceLabel: b3ToLabel(sourceB3),
        dest,
        destLabel: OUTPUT_DEST_LABEL[dest] ?? `Dest 0x${dest.toString(16)}`,
        destChannel: valLo + 1,
      };
      this.replaceOutput("bus", rec.sourceLabel, rec);
      this.updates++;
      return true;
    }

    // FX RETURN OUTPUT PATCH: modifier 0x16 (L) / 0x17 (R).
    if (mod === 0x16 || mod === 0x17) {
      const dest = valHi;
      const lr = mod === 0x16 ? "L" : "R";
      const rec: OutputPatch = {
        kind: "fx",
        sourceLabel: `FX${ch + 1} ${lr}`,
        dest,
        destLabel: OUTPUT_DEST_LABEL[dest] ?? `Dest 0x${dest.toString(16)}`,
        destChannel: valLo + 1,
      };
      this.replaceOutput("fx", rec.sourceLabel, rec);
      this.updates++;
      return true;
    }

    // MONITOR OUTPUT PATCH: modifier 0x11.
    if (mod === 0x11) {
      const dest = valHi;
      const rec: OutputPatch = {
        kind: "monitor",
        sourceLabel: MONITOR_SOURCE_LABEL[ch] ?? `Mon ${ch}`,
        dest,
        destLabel: OUTPUT_DEST_LABEL[dest] ?? `Dest 0x${dest.toString(16)}`,
        destChannel: valLo + 1,
      };
      this.replaceOutput("monitor", rec.sourceLabel, rec);
      this.updates++;
      return true;
    }

    return false;
  }

  /** Replace an existing output patch keyed by (kind, source) to avoid dupes. */
  private replaceOutput(
    kind: OutputPatch["kind"],
    sourceLabel: string,
    rec: OutputPatch
  ): void {
    const idx = this.outputPatches.findIndex(
      (p) => p.kind === kind && p.sourceLabel === sourceLabel
    );
    if (idx >= 0) this.outputPatches[idx] = rec;
    else this.outputPatches.push(rec);
  }

  setChannelName(b3: number, name: string): void {
    this.names.set(b3, name);
    // Keep any existing input patch in sync.
    const existing = this.inputPatches.get(b3);
    if (existing) existing.name = name;
  }

  snapshot(): RoutingSnapshot {
    return {
      inputs: Array.from(this.inputPatches.values()).sort(
        (a, b) => a.destB3 - b.destB3
      ),
      outputs: [...this.outputPatches],
      stereoPairs: [...this.stereoPairs],
      updates: this.updates,
      routingBlockBytes: this.routingBlockBytes,
    };
  }

  reset(): void {
    this.inputPatches.clear();
    this.outputPatches = [];
    this.updates = 0;
    this.routingBlockBytes = null;
    this.names.clear();
    this.stereoPairs = [];
  }
}
