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

// ── Blob header: bus composition and stereo bitmaps ─────────────────────────
//
// Verified on a real SQ-5 (fw 1.6) across six controlled dumps on 2026-10-15
// (pd-dumps/: connect-test, baseA, busB…busJ; see VERIFY-STEREO-MODES.md):
//
//   @61      = number of GROUP buses of the 12 mix buses (0x02 → 0x07 on a
//              Bus Config change 10 aux + 2 grp → 5 aux + 7 grp);
//   @62      = 0x04, constant, meaning unknown;
//   @65      = number of AUX buses (0x0a → 0x05 in the same change);
//   @90..91  = u16LE stereo bitmap of the 12 mix buses:
//              bit i = bus i+1 stereo. Bus order = aux 1..N then group 1..M,
//              which is exactly the mix-pool slot order (b3 0x58+i = Mix i+1).
//              Bits 12–15 are always 1 (padding).
//              Confirmed by three clean toggles: 0xFC00 (grp 1-2 stereo) →
//              0xFFE0 (grp 1-7 stereo, aux mono) → 0xFFE1 (Mix 1 stereo) →
//              0xFFE0 (back to mono).
//   @92      = 0x05, constant, meaning unknown;
//   @93      = matrix pair bitmap: bit (3 + p) = matrix pair p ganged
//              (pair 1 = 0x73+0x76, pair 2 = 0x74+0x77, pair 3 = 0x75+0x78).
//              SQ-5 has 6 matrix buses; a STEREO matrix consumes two of them
//              (L = 0x73–0x75, R = 0x76–0x78, name stored in the L slot).
//              Breaking a stereo matrix to mono frees the R bus, which shows
//              up as an additional mono matrix in the Mix Stereo menu
//              (3 stereo → 6 mono). Confirmed by clean toggles on all three
//              pairs: 0x38 → 0x30 → 0x20 → 0x00 → 0x08.
//
// CAUTION — the per-block byte +331 is NOT the stereo mode. It is a sticky
// per-slot flag that survives Bus Config changes without being updated: in a
// dump with 10 active aux only the 5 slots that had been aux in a previous
// config carry 1. It also did not change when Mix 1 was toggled stereo.
// Kept as readSlotFlag()/decodeSlotFlags() for diagnostics only.

/** Channel parameter block base/stride in the ParamData blob. */
export const CHANNEL_BLOCK_BASE = 884;
export const CHANNEL_BLOCK_STRIDE = 336;
/** Sticky per-slot flag inside a channel block (NOT the stereo mode). */
export const SLOT_FLAG_OFFSET = 331;
/** Mix buses occupy b3 0x58–0x63. */
export const MIX_B3_FIRST = 0x58;
export const MIX_BUS_COUNT = 12;

/** Header offsets of the bus composition fields. */
export const HEADER_GROUP_COUNT_OFFSET = 61;
export const HEADER_AUX_COUNT_OFFSET = 65;
/** u16LE stereo bitmap of the 12 mix buses (bit i = Mix i+1). */
export const HEADER_BUS_STEREO_MASK_OFFSET = 90;
/** Matrix pair bitmap (bit 3/4/5 = pair 1/2/3 ganged). */
export const HEADER_MATRIX_MASK_OFFSET = 93;
/** Matrix buses occupy b3 0x73–0x78 (6 mono buses, stereo = L+R pair). */
export const MATRIX_B3_FIRST = 0x73;
export const MATRIX_BUS_COUNT = 6;

/**
 * Read the sticky per-slot flag (+331) of a channel block, or null when the
 * block is beyond the payload. Diagnostics only — NOT the stereo mode.
 */
export function readSlotFlag(payload: Buffer, b3: number): number | null {
  const off = CHANNEL_BLOCK_BASE + b3 * CHANNEL_BLOCK_STRIDE + SLOT_FLAG_OFFSET;
  if (off >= payload.length) return null;
  return payload[off] === 0 ? 0 : 1;
}

/** Sticky +331 flag per mix slot, index 0 = Mix 1. Diagnostics only. */
export function decodeSlotFlags(payload: Buffer): number[] {
  const flags: number[] = [];
  for (let i = 0; i < MIX_BUS_COUNT; i++) {
    flags.push(readSlotFlag(payload, MIX_B3_FIRST + i) ?? 0);
  }
  return flags;
}

/** Bus composition from the blob header. */
export interface BusComposition {
  /** Number of group buses (of the 12 mix buses). */
  groups: number;
  /** Number of aux buses. */
  aux: number;
}

/** Decode @61 (groups) / @65 (aux), or null when the payload is too short. */
export function decodeBusComposition(payload: Buffer): BusComposition | null {
  if (payload.length < HEADER_AUX_COUNT_OFFSET + 1) return null;
  return {
    groups: payload[HEADER_GROUP_COUNT_OFFSET],
    aux: payload[HEADER_AUX_COUNT_OFFSET],
  };
}

/**
 * Stereo bitmap of the 12 mix buses from the header (@90..91, u16LE):
 * index 0 = Mix 1. Bits 12–15 are padding and ignored. Returns null when
 * the payload is too short.
 */
export function decodeBusStereoMask(payload: Buffer): boolean[] | null {
  if (payload.length < HEADER_BUS_STEREO_MASK_OFFSET + 2) return null;
  const word = payload.readUInt16LE(HEADER_BUS_STEREO_MASK_OFFSET);
  const mask: boolean[] = [];
  for (let i = 0; i < MIX_BUS_COUNT; i++) mask.push((word & (1 << i)) !== 0);
  return mask;
}

/**
 * Ganged matrix pairs from the header (@93): b3 pairs like [0x73, 0x76]
 * (L bus, R bus). A stereo matrix occupies both; mono matrices appear as
 * single buses. Returns [] when the payload is too short.
 */
export function decodeMatrixStereoPairs(payload: Buffer): number[][] {
  if (payload.length < HEADER_MATRIX_MASK_OFFSET + 1) return [];
  const byte = payload[HEADER_MATRIX_MASK_OFFSET];
  const pairs: number[][] = [];
  for (let p = 0; p < 3; p++) {
    if ((byte & (1 << (3 + p))) !== 0) {
      pairs.push([MATRIX_B3_FIRST + p, MATRIX_B3_FIRST + 3 + p]);
    }
  }
  return pairs;
}

/**
 * Stereo mix buses from the header bitmap, as 0-based mix indexes:
 * [[i, i]] = Mix i+1 is a single stereo bus (its own L/R metering pair).
 * A stereo mix bus is independent — adjacent stereo mixes are NOT merged.
 */
export function decodeMixStereoPairs(payload: Buffer): number[][] {
  const mask = decodeBusStereoMask(payload);
  if (!mask) return [];
  const pairs: number[][] = [];
  for (let i = 0; i < MIX_BUS_COUNT; i++) {
    if (mask[i]) pairs.push([i, i]);
  }
  return pairs;
}

// ── Stereo-linked bus list (forensics / diagnostics) ────────────────────────
//
// The link region also carries encoding-A entries for non-input objects:
// `[b3][0x0f][tail] [b3][0x10][tail]` marks b3 as the master of a stereo link.
// These entries live in a SEPARATE region of the blob (~81290–82960 on the
// reference SQ-5 dump), not in the input table at 81548.
//
// CAUTION — these bus pairs are STICKY gang marks, not a reliable stereo
// indicator: the `0x10` entries vanish when a matrix is broken to mono, but
// they do NOT come back when it is re-ganged, and they can be lost as a side
// effect of Bus Config changes while the bus stays stereo. The authoritative
// stereo state lives in the header bitmaps (@90..91 for mix buses, @93 for
// matrix pairs). Filtered to bus addresses only — input links are decoded
// separately above.

/** Bus b3 addresses in the link table (groups, mixes, Main LR, matrix slots). */
export function isBusAddress(t: number): boolean {
  return (
    (t >= 0x48 && t <= 0x4b) ||
    (t >= 0x58 && t <= 0x63) ||
    t === 0x68 ||
    (t >= 0x73 && t <= 0x78)
  );
}

/** Object addresses carrying an encoding-A stereo link, ascending. */
export function decodeLinkedBuses(payload: Buffer): number[] {
  const found = new Set<number>();
  for (let o = 0; o + 8 <= payload.length; o++) {
    const t = payload.readUInt16LE(o);
    if (t === 0 || !isBusAddress(t)) continue;
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
