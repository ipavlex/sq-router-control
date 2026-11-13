/**
 * REAPER track-template generator (pure, shared).
 *
 * Turns the console's USB output patch into an `.RTrackTemplate` file: one
 * Reaper track per USB channel that the SQ actually feeds, recording from the
 * matching hardware input. A console stereo pair patched to two adjacent USB
 * channels becomes a single stereo track.
 *
 * The wire model mirrors the app's OutputPatch decoder: one USB output socket
 * carries exactly one source (`OutputPatchDest.USB` = 0x1d), `destChannel` is
 * 1-based.
 *
 * REAPER record-input encoding (I_RECINPUT):
 *   mono hardware input n (0-based)   → n
 *   stereo pair starting at input n   → 1024 + n
 * In the RPP track chunk this is the second field of the `REC` line:
 *   REC <arm> <input> <recmode> ...
 *
 * Each track also gets hardware output send(s) mirroring its record input
 * (`HWOUT` line, encoding differs from I_RECINPUT — see hwoutLines) and the
 * master/parent send is disabled (`MAINSEND 0`), so imported tracks monitor
 * straight from their hardware outputs without feeding the master bus.
 * Outputs are allocated in two passes: first mono tracks and aligned stereo
 * tracks (1-based odd pair start) monitor from their own record channel(s);
 * then misaligned stereo tracks take the first free odd-even pair of the 32
 * USB channels — and when every pair is occupied, mono outputs are relocated
 * minimally to open one up.
 *
 * A track template contains only `<TRACK>…</TRACK>` blocks — no
 * `<REAPER_PROJECT>` wrapper (verified against REAPER-written templates).
 */
import type { SnapshotPayload } from "./ipc";

/** Physical destination code for the USB output bus (OutputPatchDest.USB). */
export const USB_DEST = 0x1d;
/** Total USB channels of the SQ interface (16 odd-even stereo pairs). */
export const USB_CHANNEL_COUNT = 32;
/** REAPER I_RECINPUT flag marking a stereo input pair. */
const STEREO_BIT = 1024;

/**
 * HWOUT destination encoding (hardware output send) — **different** from
 * I_RECINPUT (ref: ReaTeam/Doc "State Chunk Definitions"):
 *   mono output n (0-based)              → 1024 + n
 *   stereo pair starting at output n     → n (REAPER only offers pairs whose
 *     1-based start is odd, i.e. 0-based n must be even)
 */
const HWOUT_MONO_BIT = 1024;
/** HWOUT source channel: mono source ch 1 (L) → 1024, ch 2 (R) → 1025. */
const SRC_MONO_BIT = 1024;

export interface ReaperTrack {
  /** Track name shown in REAPER. */
  name: string;
  /** 0-based first hardware input channel (the left side for stereo). */
  input: number;
  /** 1 = mono, 2 = stereo pair starting at `input`. */
  channels: 1 | 2;
  /**
   * 0-based hardware output channel (pair start for stereo). Mono and aligned
   * stereo tracks mirror their record input; misaligned stereo tracks take
   * the first free odd-even pair (mono outputs are relocated minimally when
   * none is free); null when no output could be allocated.
   */
  output: number | null;
  /** True when `output` is a stereo pair start (only for channels: 2). */
  outputStereo: boolean;
}

type SourceKind = "input" | "mix" | "fx" | "matrix" | "other";

interface SourceInfo {
  kind: SourceKind;
  /** 1-based console index (Input N / Mix N / FX N / Matrix N). */
  index: number;
  side: "L" | "R" | null;
}

interface Assign {
  /** 1-based USB channel carrying this source. */
  ch: number;
  /** Raw source label from the snapshot (used as a name fallback). */
  label: string;
  /** Resolved display name (console channel name when known). */
  name: string;
  source: SourceInfo;
}

const INPUT_RE = /^Input (\d+)$/;
const MIX_RE = /^Mix (\d+)$/;
const FX_SIDE_RE = /^FX\s?(\d+)\s+(L|R)$/;
const FX_RE = /^FX\s?(\d+)$/;
const MATRIX_RE = /^Matrix (\d+) (L|R)$/;

/** Classify an output-patch source label into a console source descriptor. */
function describeSource(label: string): SourceInfo {
  let m: RegExpExecArray | null;
  if ((m = INPUT_RE.exec(label))) return { kind: "input", index: Number(m[1]), side: null };
  if ((m = MIX_RE.exec(label))) return { kind: "mix", index: Number(m[1]), side: null };
  if ((m = FX_SIDE_RE.exec(label))) return { kind: "fx", index: Number(m[1]), side: m[2] as "L" | "R" };
  if ((m = FX_RE.exec(label))) return { kind: "fx", index: Number(m[1]), side: null };
  if ((m = MATRIX_RE.exec(label))) return { kind: "matrix", index: Number(m[1]), side: m[2] as "L" | "R" };
  return { kind: "other", index: 0, side: null };
}

/** Console channel name for a source, falling back to its raw label. */
function resolveName(snapshot: SnapshotPayload, label: string, info: SourceInfo): string {
  const clean = (s: string | undefined): string => (s ?? "").trim();
  switch (info.kind) {
    case "input": {
      const inp = snapshot.inputs.find((i) => i.destB3 === info.index - 1);
      return clean(inp?.name) || label;
    }
    case "mix":
      return clean(snapshot.mixNames?.[info.index - 1]) || label;
    case "fx":
      return clean(snapshot.fxNames?.[info.index - 1]) || label;
    case "matrix": {
      // Cross-paired matrix slots (ParamData header @93): the L buses are
      // 0x73–0x75 (indexes 0–2) and the R buses are 0x76–0x78 (indexes 3–5).
      const slot = info.index - 1 + (info.side === "R" ? 3 : 0);
      return clean(snapshot.matrixNames?.[slot]) || label;
    }
    default:
      return label;
  }
}

/** True when two adjacent USB assignments form a declared stereo pair. */
function isStereoPair(snapshot: SnapshotPayload, a: Assign, b: Assign): boolean {
  const sa = a.source;
  const sb = b.source;

  if (sa.kind === "input" && sb.kind === "input") {
    // Channel pairs are stored as [leftB3, rightB3] with leftB3 even.
    const right = (snapshot.stereoPairs ?? []).find(([l]) => l === sa.index - 1);
    return !!right && right[1] === sb.index - 1;
  }
  if (sa.kind === "mix" && sb.kind === "mix") {
    // Mix pairs are 0-based mix indexes: [[10, 11]] = Mix 11-12.
    return (snapshot.mixStereoPairs ?? []).some(
      ([l, r]) => l === sa.index - 1 && r === sb.index - 1
    );
  }
  if ((sa.kind === "fx" || sa.kind === "matrix") && sa.kind === sb.kind) {
    return sa.index === sb.index && sa.side === "L" && sb.side === "R";
  }
  return false;
}

/** Name for a merged stereo track: console name when set, else "Input 3-4" etc. */
function stereoName(snapshot: SnapshotPayload, a: Assign, b: Assign): string {
  const consoleName = resolveName(snapshot, a.label, a.source);
  if (consoleName !== a.label) return consoleName;
  switch (a.source.kind) {
    case "input":
      return `Input ${a.source.index}-${b.source.index}`;
    case "mix":
      return `Mix ${a.source.index}-${b.source.index}`;
    case "matrix":
      return `Matrix ${a.source.index}`;
    case "fx":
      return `FX ${a.source.index}`;
    default:
      return `${a.label}-${b.label}`;
  }
}

/**
 * Map a routing snapshot to the list of Reaper tracks: only USB-assigned
 * channels, sorted by USB channel, with declared stereo pairs merged. Also
 * allocates hardware outputs (see ReaperTrack.output).
 */
export function buildReaperTracks(snapshot: SnapshotPayload): ReaperTrack[] {
  const assigns: Assign[] = (snapshot.outputs ?? [])
    .filter((o) => o.dest === USB_DEST && o.destChannel >= 1)
    .sort((x, y) => x.destChannel - y.destChannel)
    .map((o) => {
      const source = describeSource(o.sourceLabel);
      return {
        ch: o.destChannel,
        label: o.sourceLabel,
        name: resolveName(snapshot, o.sourceLabel, source),
        source,
      };
    });

  const tracks: ReaperTrack[] = [];
  for (let i = 0; i < assigns.length; i++) {
    const a = assigns[i];
    const b = assigns[i + 1];
    if (b && b.ch === a.ch + 1 && isStereoPair(snapshot, a, b)) {
      tracks.push({
        name: stereoName(snapshot, a, b),
        input: a.ch - 1,
        channels: 2,
        output: null,
        outputStereo: true,
      });
      i++; // consume the right side
    } else {
      tracks.push({
        name: a.name,
        input: a.ch - 1,
        channels: 1,
        output: null,
        outputStereo: false,
      });
    }
  }

  // Output allocation over the 32 USB channels (16 odd-even pairs).
  // Pass 1: mono tracks and aligned stereo tracks (1-based odd pair start)
  // monitor from their own record channel(s). Pass 2: misaligned stereo
  // tracks take the first free odd-even pair; when every pair is occupied,
  // mono outputs are relocated minimally (fewest moved channels, then
  // smallest total displacement) to open one up.
  const used = new Array<boolean>(USB_CHANNEL_COUNT).fill(false);
  /** Mono track holding an output on each occupied channel. */
  const monoAt = new Map<number, ReaperTrack>();

  const firstFreePair = (): number | null => {
    for (let start = 0; start < USB_CHANNEL_COUNT; start += 2) {
      if (!used[start] && !used[start + 1]) return start;
    }
    return null;
  };

  /** Cheapest way to open one odd-even pair by moving mono outputs. */
  const findRelocation = ():
    | { pair: number; moves: { track: ReaperTrack; from: number; to: number }[] }
    | null => {
    const free: number[] = [];
    for (let c = 0; c < USB_CHANNEL_COUNT; c++) if (!used[c]) free.push(c);
    let best:
      | {
          pair: number;
          count: number;
          disp: number;
          moves: { track: ReaperTrack; from: number; to: number }[];
        }
      | null = null;
    for (let start = 0; start < USB_CHANNEL_COUNT; start += 2) {
      const channels = [start, start + 1];
      // Only mono outputs can be moved; a pair touched by a stereo output
      // (aligned or already relocated) is not a candidate.
      const monos = channels
        .filter((c) => monoAt.has(c))
        .map((c) => ({ track: monoAt.get(c)!, from: c }));
      if (!monos.length || channels.some((c) => used[c] && !monoAt.has(c))) continue;
      // Destinations must lie outside the pair being freed.
      const dests = free.filter((c) => c !== start && c !== start + 1);
      if (dests.length < monos.length) continue;
      let moves: { track: ReaperTrack; from: number; to: number }[] | null = null;
      let disp = Infinity;
      if (monos.length === 1) {
        for (const to of dests) {
          const d = Math.abs(to - monos[0].from);
          if (d < disp) {
            disp = d;
            moves = [{ track: monos[0].track, from: monos[0].from, to }];
          }
        }
      } else {
        for (let i = 0; i < dests.length; i++) {
          for (let j = 0; j < dests.length; j++) {
            if (i === j) continue;
            const d =
              Math.abs(dests[i] - monos[0].from) + Math.abs(dests[j] - monos[1].from);
            if (d < disp) {
              disp = d;
              moves = [
                { track: monos[0].track, from: monos[0].from, to: dests[i] },
                { track: monos[1].track, from: monos[1].from, to: dests[j] },
              ];
            }
          }
        }
      }
      const count = monos.length;
      if (!best || count < best.count || (count === best.count && disp < best.disp)) {
        best = { pair: start, count, disp, moves: moves! };
      }
    }
    return best ? { pair: best.pair, moves: best.moves } : null;
  };

  // Pass 1.
  for (const t of tracks) {
    if (t.channels === 1) {
      t.output = t.input;
      used[t.input] = true;
      monoAt.set(t.input, t);
    } else if (t.input % 2 === 0) {
      t.output = t.input;
      used[t.input] = used[t.input + 1] = true;
    }
  }

  // Pass 2.
  for (const t of tracks) {
    if (t.channels !== 2 || t.input % 2 === 0) continue;
    let pair = firstFreePair();
    if (pair === null) {
      const relocation = findRelocation();
      if (!relocation) continue; // no pair can be opened — no hardware output
      for (const m of relocation.moves) {
        used[m.from] = false;
        used[m.to] = true;
        monoAt.delete(m.from);
        monoAt.set(m.to, m.track);
        m.track.output = m.to;
      }
      pair = relocation.pair;
    }
    t.output = pair;
    used[pair] = used[pair + 1] = true;
  }

  return tracks;
}

function escapeRppString(s: string): string {
  return s.replace(/\\/g, "\\\\").replace(/"/g, '\\"');
}

function newGuid(): string {
  const c = (globalThis as { crypto?: { randomUUID?: () => string } }).crypto;
  if (c && typeof c.randomUUID === "function") return c.randomUUID().toUpperCase();
  // RFC 4122 v4 fallback.
  return "xxxxxxxx-xxxx-4xxx-yxxx-xxxxxxxxxxxx"
    .replace(/[xy]/g, (ch) => {
      const r = (Math.random() * 16) | 0;
      const v = ch === "x" ? r : (r & 0x3) | 0x8;
      return v.toString(16);
    })
    .toUpperCase();
}

/**
 * Hardware output send mirroring the track's allocated output ("output =
 * input" where REAPER allows it). Line layout per ReaTeam/Doc:
 *   HWOUT <dest> <sendmode> <vol> <pan> <mute> <invert> <srcchan> -1:U <automode>
 * (sendmode 0 = post-fader, vol 1 = 0 dB, srcchan 0 = stereo source ch 1-2,
 * srcchan 1024 = mono source ch 1; `-1:U` is REAPER's own field 8).
 * A track with `output: null` (no free stereo pair) gets no hardware send.
 */
function hwoutLines(t: ReaperTrack): string[] {
  if (t.output === null) return [];
  const dest = t.outputStereo ? t.output : HWOUT_MONO_BIT + t.output;
  const srcchan = t.outputStereo ? 0 : SRC_MONO_BIT;
  return [`  HWOUT ${dest} 0 1 0 0 0 ${srcchan} -1:U -1`];
}

/** Build one REAPER `<TRACK>` chunk armed to record from its hardware input. */
function trackBlock(t: ReaperTrack): string {
  const recInput = t.channels === 2 ? STEREO_BIT + t.input : t.input;
  return [
    "<TRACK",
    `  NAME "${escapeRppString(t.name)}"`,
    "  PEAKCOL 16576",
    "  BEAT -1",
    "  AUTOMODE 0",
    "  VOLPAN 1 0 -1 -1 1",
    "  MUTESOLO 0 0 0",
    "  IPHASE 0",
    "  PLAYOFFS 0 1",
    "  ISBUS 0 0",
    "  BUSCOMP 0 0 0 0 0",
    "  SHOWINMIX 1 0.6667 0.5 1 0.5 0 0 0",
    `  REC 1 ${recInput} 1 0 0 0 0 0`,
    "  VU 2",
    "  TRACKHEIGHT 0 0 0 0 0 0",
    "  INQ 0 0 0 0.5 100 0 0 100",
    `  NCHAN ${t.channels}`,
    "  FX 1",
    `  TRACKID {${newGuid()}}`,
    "  PERF 0",
    "  MIDIOUT -1",
    "  MAINSEND 0 0",
    ...hwoutLines(t),
    ">",
  ].join("\n");
}

/**
 * Master-track settings with **no hardware outputs**: the master bus is not
 * routed to any physical output socket, so a multitrack session cannot
 * accidentally monitor/duplicate the console's own outputs. `MASTERHWOUT`
 * with a zero source channel and `-1` destination is REAPER's "no output".
 */
function masterBlock(): string {
  return [
    "MASTERAUTOMODE 0",
    "MASTERTRACKHEIGHT 0 0",
    "MASTERPEAKCOL 16576",
    "MASTERMUTESOLO 0",
    "MASTERTRACKVIEW 0 0.6667 0.5 0.5 0 0 0",
    "MASTERHWOUT 0 0 0 0 0 0 0 -1",
    "MASTER_NCH 2 2",
    "MASTER_VOLUME 1 0 -1 -1 1",
    "MASTER_FX 1",
    "MASTER_SEL 0",
  ].join("\n");
}

/**
 * Serialize tracks into `.RTrackTemplate` text.
 *
 * A track template is normally just `<TRACK>` chunks, but the master settings
 * are emitted as a leading block so the imported tracks land in a project
 * whose master has no physical outputs. REAPER ignores unknown top-level
 * lines when inserting a template, so this is safe for both "insert tracks
 * from template" and drag-and-drop.
 */
export function buildReaperTrackTemplate(tracks: ReaperTrack[]): string {
  if (!tracks.length) return "";
  return masterBlock() + "\n" + tracks.map(trackBlock).join("\n") + "\n";
}
