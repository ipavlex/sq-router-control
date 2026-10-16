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
  [InputPatchSource.SLink]: "dSk / SLink",
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
  // Group buses 1-4: separate mono audio buses (subgroups), confirmed on an
  // SQ-5 ParamData dump (named channel blocks at 0x48-0x4b) and by
  // allen-heath-sq-tools (talkback group targets Grp1-4 = 0x48-0x4b).
  if (b3 >= 0x48 && b3 <= 0x4b) return `Group ${b3 - 0x48 + 1}`;
  if (b3 >= 0x58 && b3 <= 0x63) return `Mix ${b3 - 0x58 + 1}`;
  if (b3 === 0x68) return "Main LR";
  // Matrix buses: 6 slots (0x73–0x78), cross-paired per the ParamData header
  // @93 (confirmed by controlled dumps — SQ-PROTOCOL.md §8.5): the L buses
  // are 0x73–0x75 and the R buses are 0x76–0x78 (pair 1 = 0x73+0x76,
  // pair 2 = 0x74+0x77, pair 3 = 0x75+0x78). A ganged stereo matrix occupies
  // both buses of its pair; a split matrix frees the R bus as an independent
  // mono matrix (the L/R suffix then reflects the slot's position in the
  // stereo layout, not the current ganged state).
  if (b3 >= 0x73 && b3 <= 0x78) {
    const slot = b3 - 0x73;
    return slot < 3
      ? `Matrix ${slot + 1} L`
      : `Matrix ${slot - 2} R`;
  }
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
      const label = b3ToLabel(b3);
      if (!(label in m)) m[label] = b3;
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
  /**
   * Source bus b3 of the patch frame (kind "bus"). For the right half of a
   * console-linked stereo pair this is the MASTER b3 (the frame addresses the
   * master with modifier 0x10) — while sourceLabel names the slave channel.
   */
  sourceB3?: number;
  dest: number;
  destLabel: string;
  destChannel: number;
  /** Right half of a console-linked stereo source (output-patch modifier 0x10). */
  rightHalf?: boolean;
}

// ── Routing state model ──────────────────────────────────────────────────────

export interface RoutingSnapshot {
  inputs: InputPatch[];
  outputs: OutputPatch[];
  /** Stereo-linked channel pairs: each entry is [leftB3, rightB3]. */
  stereoPairs: number[][];
  /** Stereo-linked mix pairs as 0-based mix indexes: [[10, 11]] = Mix 11-12. */
  mixStereoPairs: number[][];
  /**
   * Ganged matrix pairs as b3 addresses from the ParamData header (@93):
   * [[0x73, 0x76]] = matrix pair 1 is stereo (L bus 0x73, R bus 0x76).
   * Unlisted slots are mono matrices (a split stereo matrix frees its R bus
   * as an independent mono matrix).
   */
  matrixStereoPairs: number[][];
  /** Mix bus names 1-12 (index 0 = Mix 1), from the ParamData name blocks. */
  mixNames: string[];
  /** FX return names 1-4 (index 0 = FX 1), from the ParamData name blocks. */
  fxNames: string[];
  /**
   * Matrix slot names for b3 0x73–0x78 (index 0 = slot Matrix1-L). A stereo
   * matrix normally carries the same name on both of its slots.
   */
  matrixNames: string[];
  /** Group bus names 1-4 (index 0 = Group 1, b3 0x48–0x4b). */
  groupNames: string[];
  /**
   * Bus composition from the ParamData header (@61/@65): number of aux and
   * group buses of the 12-slot mix pool (aux + groups ≤ 12). null = not yet
   * decoded (the UI falls back to the full 12 mixes / 4 groups layout).
   */
  auxCount: number | null;
  groupCount: number | null;
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

  /** Stereo-linked mix pairs as 0-based mix indexes: [[10, 11]] = Mix 11-12. */
  mixStereoPairs: number[][] = [];

  /**
   * Ganged matrix pairs as b3 addresses (ParamData header @93):
   * [[0x73, 0x76]] = matrix pair 1 stereo. Empty = all six slots are mono
   * matrices. Filled from the ParamData blob (see stereo-links.ts).
   */
  matrixStereoPairs: number[][] = [];

  /**
   * Bus composition from the ParamData header (@61/@65): aux / group counts
   * of the 12-slot mix pool. null until the blob is decoded (demo sets them
   * directly; the UI falls back to 12 mixes / 4 groups while null).
   */
  auxCount: number | null = null;
  groupCount: number | null = null;

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
    const modifier = raw[4];
    const valLo = raw[5];
    const valHi = raw[6];

    // INPUT PATCH: modifier is one of the input source codes.
    if (modifier >= 0x01 && modifier <= 0x04) {
      const destB3 = valLo;
      const record: InputPatch = {
        destB3,
        destLabel: b3ToLabel(destB3),
        name: this.names.get(destB3) ?? "",
        source: modifier,
        sourceLabel: INPUT_SOURCE_LABEL[modifier] ?? `Src 0x${modifier.toString(16)}`,
        sourceChannel: ch,
      };
      this.inputPatches.set(destB3, record);
      this.updates++;
      return true;
    }

    // OUTPUT PATCH (mixer bus → physical output): modifier 0x0f (left half)
    // or 0x10 (right half of a console-linked stereo source; same master b3).
    if (modifier === 0x0f || modifier === 0x10) {
      const sourceB3 = ch;
      const dest = valHi;
      // Right half of a console-linked stereo pair: the frame carries the
      // MASTER b3 with modifier 0x10, but the label names the slave channel
      // (master+1) — "Input 15" / "Input 16" read as two distinct sources.
      const labelB3 =
        modifier === 0x10 && sourceB3 <= 0x2f ? sourceB3 + 1 : sourceB3;
      const record: OutputPatch = {
        kind: "bus",
        sourceLabel: b3ToLabel(labelB3),
        sourceB3,
        dest,
        destLabel: OUTPUT_DEST_LABEL[dest] ?? `Dest 0x${dest.toString(16)}`,
        destChannel: valLo + 1,
        rightHalf: modifier === 0x10,
      };
      this.replaceOutput(record);
      this.updates++;
      return true;
    }

    // FX RETURN OUTPUT PATCH: modifier 0x16 (L) / 0x17 (R).
    if (modifier === 0x16 || modifier === 0x17) {
      const dest = valHi;
      const side = modifier === 0x16 ? "L" : "R";
      const record: OutputPatch = {
        kind: "fx",
        sourceLabel: `FX${ch + 1} ${side}`,
        dest,
        destLabel: OUTPUT_DEST_LABEL[dest] ?? `Dest 0x${dest.toString(16)}`,
        destChannel: valLo + 1,
      };
      this.replaceOutput(record);
      this.updates++;
      return true;
    }

    // MONITOR OUTPUT PATCH: modifier 0x11.
    if (modifier === 0x11) {
      const dest = valHi;
      const record: OutputPatch = {
        kind: "monitor",
        sourceLabel: MONITOR_SOURCE_LABEL[ch] ?? `Mon ${ch}`,
        dest,
        destLabel: OUTPUT_DEST_LABEL[dest] ?? `Dest 0x${dest.toString(16)}`,
        destChannel: valLo + 1,
      };
      this.replaceOutput(record);
      this.updates++;
      return true;
    }

    return false;
  }

  /**
   * Insert an output patch keyed by its physical destination. One output
   * socket carries exactly one source, so a new patch replaces whatever was
   * previously routed to the same (dest, destChannel). The same source may
   * legitimately feed several outputs (e.g. a mono source → both L and R).
   */
  private replaceOutput(record: OutputPatch): void {
    this.outputPatches = this.outputPatches.filter(
      (p) => !(p.dest === record.dest && p.destChannel === record.destChannel)
    );
    this.outputPatches.push(record);
  }

  /**
   * Remove whatever is patched to a physical output. Used by the monitor
   * session restore for borrowed outputs that had no known routing before the
   * session (e.g. demo outputs that were never seeded).
   */
  clearOutput(dest: number, destChannel: number): void {
    const next = this.outputPatches.filter(
      (p) => !(p.dest === dest && p.destChannel === destChannel)
    );
    if (next.length !== this.outputPatches.length) {
      this.outputPatches = next;
      this.updates++;
    }
  }

  setChannelName(b3: number, name: string): void {
    this.names.set(b3, name);
    // Keep any existing input patch in sync.
    const existing = this.inputPatches.get(b3);
    if (existing) existing.name = name;
  }

  snapshot(): RoutingSnapshot {
    // Mix bus names in bus order (Mix 1-12 → b3 0x58-0x63).
    const mixNames: string[] = [];
    for (let i = 0; i < 12; i++) mixNames.push(this.names.get(0x58 + i) ?? "");
    // FX return names in engine order (FX 1-4 → b3 0x40-0x43).
    const fxNames: string[] = [];
    for (let i = 0; i < 4; i++) fxNames.push(this.names.get(0x40 + i) ?? "");
    // Matrix slot names (b3 0x73-0x78 → Matrix1-L … Matrix3-R).
    const matrixNames: string[] = [];
    for (let i = 0; i < 6; i++) matrixNames.push(this.names.get(0x73 + i) ?? "");
    // Group bus names (Group 1-4 → b3 0x48-0x4b).
    const groupNames: string[] = [];
    for (let i = 0; i < 4; i++) groupNames.push(this.names.get(0x48 + i) ?? "");
    return {
      inputs: Array.from(this.inputPatches.values()).sort(
        (a, b) => a.destB3 - b.destB3
      ),
      outputs: [...this.outputPatches],
      stereoPairs: [...this.stereoPairs],
      mixStereoPairs: this.mixStereoPairs.map((p) => [...p]),
      matrixStereoPairs: this.matrixStereoPairs.map((p) => [...p]),
      mixNames,
      fxNames,
      matrixNames,
      groupNames,
      auxCount: this.auxCount,
      groupCount: this.groupCount,
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
    this.mixStereoPairs = [];
    this.matrixStereoPairs = [];
    this.auxCount = null;
    this.groupCount = null;
  }
}
