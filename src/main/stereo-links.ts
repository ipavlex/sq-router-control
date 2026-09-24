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
 *
 * CAUTION — known trap: the table continues past the input entries (FX
 * returns, masters, …), and encoding-B slot ids there can numerically
 * coincide with b3 addresses. On the reference SQ-5 dump, entries 44–55
 * hold targets 0x58–0x63 — which look exactly like mix-b3 self-targets
 * (mixes live at b3 0x58–0x63) but are in fact the pair-slot ids of
 * Ch45-48 and later entries. Confirmed real pairs: [44,45] and [46,47].
 * The input scan therefore covers the full 48 input entries and nothing
 * beyond is interpreted as channel pairs.
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

// ── Mix bus mono/stereo mode ────────────────────────────────────────────────
//
// The stereo-LINK table above covers input channels only. The mode of a MIX
// bus (Mix 1-12, b3 0x58-0x63) is a separate per-bus flag stored inside the
// 336-byte channel block, at byte +331 — the byte immediately before the
// documented flags byte (+332 = polarity/mute). Observed values are 0 (mono)
// and 1 (stereo).
//
// Evidence (two independent ParamData-layout snapshots):
//   * a real SQ-5 console dump  → +331 = 1 for Mix 1-10 (5 stereo pairs),
//     0 for Mix 11-12;
//   * a MixPad CurrentShow dump → +331 = 1 for Mix 1-8 (4 stereo pairs),
//     0 for Mix 9-12.
// In both cases +331 is the ONLY byte in the 336-byte block that consistently
// separates the stereo set from the mono set, and the set is always an even
// prefix of the mix list — exactly how stereo mixes allocate adjacent buses.
// It is not used by inputs, FX returns, Main LR or matrix buses (always 0
// there), so it is a mix-bus-only mode flag.
//
// TODO(verify): confirm polarity (1 = stereo) with a controlled dump — toggle
// one mix on the console and re-dump; expect a single-byte 0↔1 change at
// `884 + (0x57 + mix)·336 + 331`.

/** Channel parameter block base/stride in the ParamData blob. */
export const CHANNEL_BLOCK_BASE = 884;
export const CHANNEL_BLOCK_STRIDE = 336;
/** Byte inside a channel block holding the mix bus mono/stereo mode. */
export const BUS_MODE_OFFSET = 331;
/** Mix buses occupy b3 0x58–0x63. */
export const MIX_B3_FIRST = 0x58;
export const MIX_BUS_COUNT = 12;

/**
 * Read a channel block's bus-mode byte (0 = mono, 1 = stereo) or null when
 * the block is beyond the payload. Intended for mix buses (b3 0x58–0x63).
 */
export function readBusMode(payload: Buffer, b3: number): number | null {
  const off = CHANNEL_BLOCK_BASE + b3 * CHANNEL_BLOCK_STRIDE + BUS_MODE_OFFSET;
  if (off >= payload.length) return null;
  return payload[off] === 0 ? 0 : 1;
}

/** Per-mix stereo mode, index 0 = Mix 1. 1 = stereo, 0 = mono/unknown. */
export function decodeMixModes(payload: Buffer): number[] {
  const modes: number[] = [];
  for (let i = 0; i < MIX_BUS_COUNT; i++) {
    modes.push(readBusMode(payload, MIX_B3_FIRST + i) ?? 0);
  }
  return modes;
}

/**
 * Stereo mix pairs from the ParamData channel blocks, as 0-based mix indexes:
 * [[0, 1]] = Mix 1-2. Adjacent stereo mixes are reported as a pair; a stereo
 * mix without a stereo neighbour is reported as a single-element-style
 * [i, i] pair so the monitor still shows its L/R meter.
 */
export function decodeMixStereoPairs(payload: Buffer): number[][] {
  const stereo = decodeMixModes(payload).map((m) => m === 1);
  const pairs: number[][] = [];
  const used = new Array<boolean>(MIX_BUS_COUNT).fill(false);
  for (let i = 0; i < MIX_BUS_COUNT; i++) {
    if (!stereo[i] || used[i]) continue;
    if (i + 1 < MIX_BUS_COUNT && stereo[i + 1]) {
      pairs.push([i, i + 1]);
      used[i] = true;
      used[i + 1] = true;
    } else {
      pairs.push([i, i]);
      used[i] = true;
    }
  }
  return pairs;
}

// ── Stereo-linked bus list (forensics / diagnostics) ────────────────────────
//
// The link region also carries encoding-A entries for non-input objects:
// `[b3][0x0f][tail] [b3][0x10][tail]` marks b3 as the master of a stereo link.
// On the reference console dump this yields matrix buses 0x73/0x74/0x75 (all
// three matrices stereo), matching the console's actual configuration. Filtered
// to bus addresses only — input links are decoded separately above.

/** Bus b3 addresses in the link table (mixes, Main LR, matrix slots). */
function isBusB3(t: number): boolean {
  return (t >= 0x58 && t <= 0x63) || t === 0x68 || (t >= 0x73 && t <= 0x78);
}

/** Object addresses carrying an encoding-A stereo link, ascending. */
export function decodeLinkedBuses(payload: Buffer): number[] {
  const found = new Set<number>();
  for (let o = 0; o + 8 <= payload.length; o++) {
    const t = payload.readUInt16LE(o);
    if (t === 0 || !isBusB3(t)) continue;
    if (
      payload.readUInt16LE(o + 4) === t &&
      payload[o + 2] === 0x0f &&
      payload[o + 6] === 0x10
    ) {
      found.add(t);
    }
  }
  return Array.from(found).sort((a, b) => a - b);
}
