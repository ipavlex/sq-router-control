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
 *   id=0x06  48 channels × 11 slots — per-channel bar data
 *   id=0x17  48 values — one level per input channel
 *
 * Level encoding: dBFS ≈ (value - 0x8000) / 256, i.e. 0x8000 = 0.00 dBFS.
 * 0x1201 ≈ -110 dB is the "no signal / floor" sentinel. The channel level is
 * slot 0 (== slot 1, the L/R pair); the SQ meter scale continues above 0 dB
 * into the red clip region, so a raw value above 0x8000 means the channel is
 * clipping.
 */

export interface MetersPayload {
  /** dBFS levels for input channels 0..47 (null when the channel has no data / is at the floor). */
  inputs: (number | null)[];
  /** true when the channel's peak is at or above 0 dBFS (clip). */
  clip: boolean[];
}

const INPUT_CHANNELS = 48;
/** Per-channel slot count in the id=0x06 detailed meter packet. */
const DETAIL_STRIDE = 11;
/** Raw value above which the meter reads as clipping (over 0 dBFS). */
const CLIP_RAW = 0x8000;
/** Raw value at and below which the meter reads as "no signal". */
const FLOOR_RAW = 0x1201;

/** Convert a raw 16-bit meter value to dBFS, or null when it's the floor. */
export function rawToDb(raw: number): number | null {
  if (raw <= FLOOR_RAW) return null;
  return (raw - 0x8000) / 256;
}

function emptyMeters(): MetersPayload {
  return {
    inputs: new Array<number | null>(INPUT_CHANNELS).fill(null),
    clip: new Array<boolean>(INPUT_CHANNELS).fill(false),
  };
}

let detail: MetersPayload = emptyMeters();
let single: MetersPayload = emptyMeters();

/**
 * Decode a UDP meter packet. Maintains the latest state for both the detailed
 * (0x06) and per-channel (0x17) packet ids, and merges them so consumers get
 * the best of both: clip flags from the detailed packet, levels from whichever
 * source reported them. Returns null for unknown / malformed packets.
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

  return null;
}

/** Merge the latest detailed (0x06) and per-channel (0x17) reads. */
function mergeMeters(): MetersPayload {
  const merged = emptyMeters();
  for (let ch = 0; ch < INPUT_CHANNELS; ch++) {
    merged.inputs[ch] = single.inputs[ch] ?? detail.inputs[ch];
    merged.clip[ch] = detail.clip[ch];
  }
  return merged;
}

/** Reset the decoder state (call on connect / disconnect). */
export function resetMeters(): void {
  detail = emptyMeters();
  single = emptyMeters();
}