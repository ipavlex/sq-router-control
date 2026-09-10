/**
 * SQ UDP meter decoding.
 *
 * After the TCP handshake the console streams meter data over UDP (from the
 * port it announced in the sub=0x00 reply) to the ephemeral port the app
 * advertises via encodeMeterSub. Each UDP datagram carries one meter packet:
 *
 *   [0x7F] [id:u8] [len:u16LE] [0x00 0x00] [body × len]
 *
 * The body is an array of u16 LE values. The interesting packet ids are:
 *   id=0x06  48 channels × 11 slots — per-channel bar data (inputs)
 *   id=0x17  48 values — one level per input channel
 *   id=0x18  40 buses × 6 slots — Main LR, Mix 1-12, FX sends (see BUS_*)
 *
 * Level encoding: dBFS ≈ (value - 0x8000) / 256, i.e. 0x8000 = 0.00 dBFS.
 * 0x1201 ≈ -110 dB is the "no signal / floor" sentinel. The SQ meter scale
 * continues above 0 dB into the red clip region, so a raw value above 0x8000
 * means the channel is clipping. 0x0000 / ≥ 0xF000 are data placeholders.
 */

/**
 * The meters payload shared with the renderer over IPC. Defined once in
 * shared/ipc.ts; re-exported here for the main-process modules.
 */
import type { MetersPayload } from "../shared/ipc";
export type { MetersPayload };

const INPUT_CHANNELS = 48;
/** Per-channel slot count in the id=0x06 detailed meter packet. */
const DETAIL_STRIDE = 11;
/** Raw value above which the meter reads as clipping (over 0 dBFS). */
const CLIP_RAW = 0x8000;
/** Raw value at and below which the meter reads as "no signal". */
const FLOOR_RAW = 0x1201;
/** Raw values from here up are data placeholders (e.g. 0xFFFF = empty), not levels. */
const DATA_RAW = 0xf000;

/**
 * id=0x18 packet: 40 buses × 6 u16 slots. Confirmed against a real SQ-5
 * (FW 1.6) with isolated signal routing (2026-09-10):
 *
 *   bus 0-22  input channels 1-23 (not decoded here — 0x06/0x17 cover inputs)
 *   bus 23    Main LR
 *   bus 24-35 Mix 1-12 (bus 23 + mix number)
 *   bus 36-39 FX send 1-4
 *
 * Slots within a bus block: two L/R meter taps — [s0, s1] and [s3, s4]
 * (slot 2 holds 0x0000, slot 5 a ≥0xF000 placeholder). The taps differ
 * slightly (e.g. LR music: −4.8/−7.8 and −6.5/−7.8); per side the louder
 * tap wins. Same dBFS encoding as the input packets:
 * (raw - 0x8000) / 256, floor 0x1201, clip > 0x8000.
 */
const BUS_STRIDE = 6;
/** Byte offsets of the (L, R) tap pairs within a 12-byte bus block. */
const BUS_LR_OFFSETS: [number, number][] = [
  [0, 2], // slots s0/s1
  [6, 8], // slots s3/s4
];
const BUS_MAIN_LR = 23;
const BUS_MIX_FIRST = 24;
const MIX_BUS_COUNT = 12;

/** Convert a raw 16-bit meter value to dBFS, or null when it's the floor. */
export function rawToDb(raw: number): number | null {
  if (raw <= FLOOR_RAW) return null;
  return (raw - 0x8000) / 256;
}

/** u16 slots shown in the dB snapshot of a large undecoded packet. */
const SAMPLE_MAX_SLOTS = 16;
/** Bodies up to this many u16 values are dumped in full. */
const SAMPLE_FULL_LIMIT = 64;

/**
 * Extract the meter packet body, or null for datagrams without meter framing.
 */
export function meterBody(msg: Buffer): Buffer | null {
  if (msg.length < 6 || msg[0] !== 0x7f) return null;
  const len = msg.readUInt16LE(2);
  const body = msg.subarray(6, 6 + len);
  return body.length === len ? body : null;
}

/**
 * Protocol-discovery helper: compact dB snapshot of an undecoded meter
 * packet — u16 slots decoded with the same scale as the known packets
 * ("-inf" for the floor sentinel). Small bodies are dumped in full, large
 * ones trimmed to the first slots. Returns null for datagrams without
 * meter framing. Used to hunt the mix / Main-LR meter packet on a real
 * console: push signal into a known mix and watch which packet id and
 * slot index moves in the log (connection.ts re-samples undecoded shapes
 * every few seconds).
 */
export function meterSamplePreview(msg: Buffer): string | null {
  const body = meterBody(msg);
  if (!body || body.length < 2) return null;
  const count = Math.floor(body.length / 2);
  const slots = Math.min(count, count <= SAMPLE_FULL_LIMIT ? SAMPLE_FULL_LIMIT : SAMPLE_MAX_SLOTS);
  const parts: string[] = [];
  for (let i = 0; i < slots; i++) {
    const db = rawToDb(body.readUInt16LE(i * 2));
    parts.push(`[${i}]${db == null ? "-inf" : db.toFixed(1)}`);
  }
  return count > slots ? `${parts.join(" ")} …(+${count - slots})` : parts.join(" ");
}

/** Minimum raw delta between samples for a slot to count as changed (~0.25 dB). */
const DIFF_MIN_DELTA = 0x40;
/** Changed slots shown in one diff line. */
const DIFF_MAX_SLOTS = 16;
/** Cap for the stored baseline (largest known body is 708 values). */
const DIFF_MAX_VALUES = 1024;

export interface MeterBodyDiff {
  /** Raw u16 values of the body — the new baseline for the next diff. */
  raws: number[];
  /** Slots that moved vs the previous sample (index + new level), capped. */
  changed: { idx: number; db: number | null }[];
}

/** Raw values from here up are data sentinels (e.g. 0xFFFF = empty), not levels. */
const DIFF_SENTINEL_RAW = 0xf000;

/**
 * Protocol-discovery helper: compare an undecoded packet body with the
 * previous sample. Returns the raw values as the new baseline plus the
 * slots whose value moved by more than ~0.25 dB. This is the primary
 * mix-meter hunting tool: feed signal into ONE known bus at a time and
 * the changed slot indices reveal exactly where that bus's level lives.
 */
export function diffMeterBody(body: Buffer, prev: number[] | null): MeterBodyDiff {
  const count = Math.min(Math.floor(body.length / 2), DIFF_MAX_VALUES);
  const raws: number[] = new Array(count);
  const changed: { idx: number; db: number | null }[] = [];
  for (let i = 0; i < count; i++) {
    const raw = body.readUInt16LE(i * 2);
    raws[i] = raw;
    if (
      prev !== null &&
      i < prev.length &&
      raw < DIFF_SENTINEL_RAW &&
      prev[i] < DIFF_SENTINEL_RAW &&
      Math.abs(raw - prev[i]) >= DIFF_MIN_DELTA &&
      changed.length < DIFF_MAX_SLOTS
    ) {
      changed.push({ idx: i, db: rawToDb(raw) });
    }
  }
  return { raws, changed };
}

/** Format changed slots for the log: "[8]-14.2 [23]-inf …". */
export function formatMeterChanges(changed: { idx: number; db: number | null }[]): string {
  return changed
    .map((c) => `[${c.idx}]${c.db == null ? "-inf" : c.db.toFixed(1)}`)
    .join(" ");
}

/** Slots at or above this level count as "hot" for the top list (dBFS). */
const HOT_MIN_DB = -54;
/** Hottest slots shown in one top list. */
const HOT_MAX_SLOTS = 6;
/** Raw values from here up are data sentinels (e.g. 0xFFFF = empty), not levels. */
const SENTINEL_RAW = 0xf000;

/**
 * Protocol-discovery helper: the hottest slots of an undecoded packet body,
 * loudest first (slots at or below the noise floor are skipped, and data
 * sentinels like 0xFFFF don't count as levels). With signal fed into one
 * known bus at a time, the top slot of the mix-meter packet directly names
 * that bus — no change-map correlation needed.
 */
export function hotMeterSlots(body: Buffer): { idx: number; db: number }[] {
  const count = Math.floor(body.length / 2);
  const hot: { idx: number; db: number }[] = [];
  for (let i = 0; i < count; i++) {
    const raw = body.readUInt16LE(i * 2);
    if (raw >= SENTINEL_RAW) continue;
    const db = rawToDb(raw);
    if (db != null && db >= HOT_MIN_DB) hot.push({ idx: i, db });
  }
  hot.sort((a, b) => b.db - a.db);
  return hot.slice(0, HOT_MAX_SLOTS);
}

function emptyMeters(): MetersPayload {
  return {
    inputs: new Array<number | null>(INPUT_CHANNELS).fill(null),
    clip: new Array<boolean>(INPUT_CHANNELS).fill(false),
  };
}

let detail: MetersPayload = emptyMeters();
let single: MetersPayload = emptyMeters();

/** Latest mix / Main-LR readings from the id=0x18 packet (null until one arrives). */
let busMeters: {
  mixes: (number | null)[];
  mixClip: boolean[];
  /** Per-side levels (L/R), for stereo mix buttons and the Main LR button. */
  mixesL: (number | null)[];
  mixesR: (number | null)[];
  mixClipL: boolean[];
  mixClipR: boolean[];
  mainLR: number | null;
  mainLRClip: boolean;
  mainLRL: number | null;
  mainLRR: number | null;
  mainLRClipL: boolean;
  mainLRClipR: boolean;
} | null = null;

interface BusStereo {
  l: number | null;
  r: number | null;
  clipL: boolean;
  clipR: boolean;
}

/**
 * Decode one 6-slot bus block of the id=0x18 packet: per-side dBFS levels
 * (louder of the two L/R taps per side, null = floor) and per-side clip
 * flags (>0 dBFS). Data placeholders (0x0000 / ≥ 0xF000) are ignored.
 */
function decodeBusStereo(body: Buffer, bus: number): BusStereo {
  const base = bus * BUS_STRIDE * 2;
  const out: BusStereo = { l: null, r: null, clipL: false, clipR: false };
  for (const [lOff, rOff] of BUS_LR_OFFSETS) {
    const rawL = body.readUInt16LE(base + lOff);
    if (rawL !== 0 && rawL < DATA_RAW) {
      const d = rawToDb(rawL);
      if (d != null && (out.l == null || d > out.l)) out.l = d;
      if (rawL > CLIP_RAW) out.clipL = true;
    }
    const rawR = body.readUInt16LE(base + rOff);
    if (rawR !== 0 && rawR < DATA_RAW) {
      const d = rawToDb(rawR);
      if (d != null && (out.r == null || d > out.r)) out.r = d;
      if (rawR > CLIP_RAW) out.clipR = true;
    }
  }
  return out;
}

/**
 * Decode a UDP meter packet. Maintains the latest state for the detailed
 * (0x06), per-channel (0x17) and bus (0x18) packet ids, and merges them so
 * consumers get the best of all: input levels + clip flags from the input
 * packets, mix / Main-LR levels from the bus packet. Returns null for
 * unknown / malformed packets.
 */
export function decodeMeterMessage(msg: Buffer): MetersPayload | null {
  if (msg.length < 6 || msg[0] !== 0x7f) return null;

  const id = msg[1];
  const len = msg.readUInt16LE(2);
  const body = msg.subarray(6, 6 + len);
  if (body.length !== len) return null;

  // id=0x06: 48 channels × 11 slots. slot 0 = channel level (slot 1 is the
  // L/R twin; slots 8-10 carry latch/flag data that is unreliable, so clip is
  // derived from the level itself going over 0 dBFS).
  if (id === 0x06 && body.length >= INPUT_CHANNELS * DETAIL_STRIDE * 2) {
    detail = emptyMeters();
    for (let ch = 0; ch < INPUT_CHANNELS; ch++) {
      const base = ch * DETAIL_STRIDE * 2;
      const level = Math.max(
        body.readUInt16LE(base),
        body.readUInt16LE(base + 2)
      );
      detail.inputs[ch] = rawToDb(level);
      detail.clip[ch] = level > CLIP_RAW;
    }
    return mergeMeters();
  }

  // id=0x17: 48 u16 levels, one per input channel.
  if (id === 0x17 && body.length >= INPUT_CHANNELS * 2) {
    single = emptyMeters();
    for (let ch = 0; ch < INPUT_CHANNELS; ch++) {
      single.inputs[ch] = rawToDb(body.readUInt16LE(ch * 2));
    }
    return mergeMeters();
  }

  // id=0x18: 40 buses × 6 slots — Main LR + Mix 1-12 (see BUS_* constants).
  if (id === 0x18 && body.length >= (BUS_MIX_FIRST + MIX_BUS_COUNT) * BUS_STRIDE * 2) {
    const mixes: (number | null)[] = [];
    const mixClip: boolean[] = [];
    const mixesL: (number | null)[] = [];
    const mixesR: (number | null)[] = [];
    const mixClipL: boolean[] = [];
    const mixClipR: boolean[] = [];
    for (let k = 0; k < MIX_BUS_COUNT; k++) {
      const s = decodeBusStereo(body, BUS_MIX_FIRST + k);
      mixes.push(s.l == null ? s.r : s.r == null ? s.l : Math.max(s.l, s.r));
      mixClip.push(s.clipL || s.clipR);
      mixesL.push(s.l);
      mixesR.push(s.r);
      mixClipL.push(s.clipL);
      mixClipR.push(s.clipR);
    }
    const lr = decodeBusStereo(body, BUS_MAIN_LR);
    busMeters = {
      mixes,
      mixClip,
      mixesL,
      mixesR,
      mixClipL,
      mixClipR,
      mainLR: lr.l == null ? lr.r : lr.r == null ? lr.l : Math.max(lr.l, lr.r),
      mainLRClip: lr.clipL || lr.clipR,
      mainLRL: lr.l,
      mainLRR: lr.r,
      mainLRClipL: lr.clipL,
      mainLRClipR: lr.clipR,
    };
    return mergeMeters();
  }

  return null;
}

/** Merge the latest detailed (0x06), per-channel (0x17) and bus (0x18) reads. */
function mergeMeters(): MetersPayload {
  const merged = emptyMeters();
  for (let ch = 0; ch < INPUT_CHANNELS; ch++) {
    merged.inputs[ch] = single.inputs[ch] ?? detail.inputs[ch];
    merged.clip[ch] = detail.clip[ch];
  }
  if (busMeters) {
    merged.mixes = busMeters.mixes;
    merged.mixClip = busMeters.mixClip;
    merged.mixesL = busMeters.mixesL;
    merged.mixesR = busMeters.mixesR;
    merged.mixClipL = busMeters.mixClipL;
    merged.mixClipR = busMeters.mixClipR;
    merged.mainLR = busMeters.mainLR;
    merged.mainLRClip = busMeters.mainLRClip;
    merged.mainLRL = busMeters.mainLRL;
    merged.mainLRR = busMeters.mainLRR;
    merged.mainLRClipL = busMeters.mainLRClipL;
    merged.mainLRClipR = busMeters.mainLRClipR;
  }
  return merged;
}

/** Reset the decoder state (call on connect / disconnect). */
export function resetMeters(): void {
  detail = emptyMeters();
  single = emptyMeters();
  busMeters = null;
}