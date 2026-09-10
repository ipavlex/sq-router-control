/**
 * Stereo-link table decoder for the SQ ParamData blob.
 *
 * The table lives at a fixed offset (81548, confirmed on an SQ-5 with a
 * 97376-byte blob), 4 bytes per channel address ("b3"):
 *
 *   [u16LE target] [flags] [0xfe tail]
 *
 * Although the table spans ≥96 entries (inputs, FX returns, masters), only
 * the 48 input channels (b3 0x00–0x2f) are consumed here. Two link encodings
 * have been observed and confirmed against a real console dump (9/9 pairs,
 * zero false positives):
 *
 *   Encoding A — classic (seen on Ch1–32):
 *     mono:        flags 0x0f, target = own b3
 *     linked pair: left  flags 0x0f, target = own b3
 *                  right flags 0x10, target = left partner's b3
 *
 *   Encoding B — slot pair (seen on Ch33+; targets reference a pair-slot id,
 *   not a b3): both sides flags 0x0f, left target = X, right target = X+1,
 *   where X ≠ own b3 and X ≠ 0.
 *     CAUTION: unlinked channels may also point at a shared slot — but then
 *     left and right carry the SAME target (and the right side flags 0x10),
 *     which encoding B's strict +1 rule rejects.
 */

/** Offset of the stereo-link table within the ParamData blob. */
export const STEREO_TABLE_OFFSET = 81548;
/** Bytes per entry: [u16LE target] [flags] [tail]. */
export const STEREO_ENTRY_STRIDE = 4;
/** Input channels occupy b3 0x00–0x2f. */
export const STEREO_TABLE_INPUT_ENTRIES = 0x30;

/** Flags: mono / left side (and, in encoding B, the right side too). */
const FLAGS_STEREO_BASE = 0x0f;
/** Flags: right side of an encoding-A pair. */
const FLAGS_STEREO_RIGHT = 0x10;

export interface StereoEntry {
  /** Channel address (b3). */
  b3: number;
  /** u16LE target from the table. */
  target: number;
  /** Flags byte. */
  flags: number;
}

/** Which encoding produced a pair (for diagnostics). */
export type StereoEncoding = "A" | "B";

/** Read one table entry, or null when beyond the payload. */
export function readStereoEntry(payload: Buffer, b3: number): StereoEntry | null {
  const off = STEREO_TABLE_OFFSET + b3 * STEREO_ENTRY_STRIDE;
  if (off + STEREO_ENTRY_STRIDE > payload.length) return null;
  return { b3, target: payload.readUInt16LE(off), flags: payload[off + 2] };
}

/**
 * Detect the link encoding of an even/odd b3 pair, or null when the two
 * channels are not stereo-linked.
 */
export function pairEncoding(
  left: StereoEntry,
  right: StereoEntry
): StereoEncoding | null {
  // Encoding A: left is self-targeted mono, right points back at it.
  if (
    left.flags === FLAGS_STEREO_BASE &&
    right.flags === FLAGS_STEREO_RIGHT &&
    left.target === left.b3 &&
    right.target === left.b3
  ) {
    return "A";
  }
  // Encoding B: both 0x0f, targets form a consecutive X / X+1 slot pair
  // that is not the channels' own b3 and not zero.
  if (
    left.flags === FLAGS_STEREO_BASE &&
    right.flags === FLAGS_STEREO_BASE &&
    left.target !== 0 &&
    left.target !== left.b3 &&
    right.target === left.target + 1
  ) {
    return "B";
  }
  return null;
}

/**
 * Decode all stereo-linked input-channel pairs: [[leftB3, rightB3], ...]
 * in ascending order.
 */
export function decodeStereoPairs(payload: Buffer): number[][] {
  const pairs: number[][] = [];
  for (let left = 0; left + 1 < STEREO_TABLE_INPUT_ENTRIES; left += 2) {
    const l = readStereoEntry(payload, left);
    const r = readStereoEntry(payload, left + 1);
    if (!l || !r) break;
    if (pairEncoding(l, r) !== null) pairs.push([left, left + 1]);
  }
  return pairs;
}
