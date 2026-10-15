/**
 * ParamData diff — byte-level comparison of two console dumps with
 * human-readable decoding of every changed offset.
 *
 * Built for the controlled-dump verification workflow
 * (docs/VERIFY-STEREO-MODES.md): capture a baseline, change exactly ONE
 * setting on the console, capture again — the diff then points straight at
 * the field that encodes the setting (e.g. the mix mono/stereo byte +331 or
 * a link-table entry for the matrix stereo mode).
 *
 * All offsets mirror the layout confirmed on SQ-5 FW 1.6 and documented in
 * transport/connection.ts (_parseInitialState) and stereo-links.ts.
 */
import { b3ToLabel } from "./routing";

/** One changed byte. */
export interface ByteChange {
  offset: number;
  from: number;
  to: number;
}

// ── Known ParamData regions ──────────────────────────────────────────────────

const BLOCK_BASE = 884;
const BLOCK_STRIDE = 336;
/** Highest real object address (Matrix slot 6). */
const BLOCK_B3_MAX = 0x78;
const FADER_BASE = 43520;
const FADER_STRIDE = 300;
/** Real objects only — the phantom b3 0x79–0x7f tail overlaps the link areas. */
const FADER_B3_MAX = 0x78;
const GAIN_BASE = 80028;
const GAIN_B3_MAX = 0x32;
export const LINK_TABLE_OFFSET = 81548;
const LINK_ENTRY_STRIDE = 4;
const LINK_ENTRIES = 48;
/** Region where bus stereo links live (observed on the reference SQ-5 dump). */
export const BUS_LINK_REGION: readonly [number, number] = [81290, 82960];

/** Sticky per-slot flag inside a channel block (NOT the stereo mode). */
const SLOT_FLAG_OFFSET = 331;

/** Field names inside the 336-byte channel block, by relative offset. */
const BLOCK_FIELDS: Record<number, string> = {
  24: "input patch: source channel",
  26: "input patch: source type",
  84: "HPF freq (LE16 lo)",
  85: "HPF freq (LE16 hi)",
  87: "HPF on/off",
  121: "gate on/off",
  302: "compressor on/off",
  304: "delay duration (LE16 lo)",
  305: "delay duration (LE16 hi)",
  306: "delay on/off",
  324: "trim (LE16 lo)",
  325: "trim (LE16 hi)",
  331: "sticky slot flag (+331; NOT the stereo mode — see SQ-PROTOCOL.md §8.5)",
  332: "flags (bit0 polarity, bit1 mute)",
};

/** Byte-level diff of two buffers. */
export function diffBuffers(a: Buffer, b: Buffer): ByteChange[] {
  const len = Math.min(a.length, b.length);
  const changes: ByteChange[] = [];
  for (let off = 0; off < len; off++) {
    if (a[off] !== b[off]) {
      changes.push({ offset: off, from: a[off], to: b[off] });
    }
  }
  return changes;
}

/** Part name of a 4-byte link-table entry ([u16 target][flags][tail]). */
function linkPart(part: number): string {
  if (part <= 1) return `target ${part === 0 ? "lo" : "hi"}`;
  if (part === 2) return "flags";
  return "tail";
}

/**
 * Map an absolute ParamData offset to a human-readable location, e.g.
 * "Mix 5 (b3 0x5c) — channel block +331 (bus mono/stereo mode byte)".
 */
export function describeOffset(offset: number): string {
  // 0. Blob header: bus composition and stereo bitmaps (verified on SQ-5
  //    fw 1.6, see SQ-PROTOCOL.md §8.5).
  if (offset === 61) return "header @61: group bus count";
  if (offset === 62) return "header @62: unknown (0x04 constant)";
  if (offset === 65) return "header @65: aux bus count";
  if (offset === 90 || offset === 91) {
    return `header @90..91: mix bus stereo bitmap u16LE (bit ${offset - 90}… = Mix ${offset - 89}… stereo)`;
  }
  if (offset === 92) return "header @92: unknown (0x05 constant)";
  if (offset === 93) {
    return "header @93: matrix pair bitmap (bit3=pair1 0x73+0x76, bit4=pair2 0x74+0x77, bit5=pair3 0x75+0x78)";
  }

  // 1. Input stereo-link table (fixed offset, 48 entries).
  const linkEnd = LINK_TABLE_OFFSET + LINK_ENTRIES * LINK_ENTRY_STRIDE;
  if (offset >= LINK_TABLE_OFFSET && offset < linkEnd) {
    const rel = offset - LINK_TABLE_OFFSET;
    const entry = Math.floor(rel / LINK_ENTRY_STRIDE);
    return `input stereo-link table, entry b3 0x${entry
      .toString(16)
      .padStart(2, "0")} (${linkPart(rel % LINK_ENTRY_STRIDE)})`;
  }

  // 2. Channel blocks of real objects (b3 0x00–0x78) — no overlap with the
  //    fader section for these addresses.
  const blockRel = offset - BLOCK_BASE;
  if (blockRel >= 0) {
    const b3 = Math.floor(blockRel / BLOCK_STRIDE);
    const rem = blockRel % BLOCK_STRIDE;
    if (b3 >= 0 && b3 <= BLOCK_B3_MAX && rem < BLOCK_STRIDE) {
      const label = b3ToLabel(b3);
      let field = BLOCK_FIELDS[rem] ?? `+${rem}`;
      if (rem <= 15) field = `name byte +${rem}`;
      return `${label} (b3 0x${b3.toString(16).padStart(2, "0")}) — channel block ${field}`;
    }
  }

  // 3. Fader/send section (300 bytes per channel).
  const faderRel = offset - FADER_BASE;
  if (faderRel >= 0) {
    const b3 = Math.floor(faderRel / FADER_STRIDE);
    const rem = faderRel % FADER_STRIDE;
    if (b3 <= FADER_B3_MAX) {
      let field = `+${rem}`;
      if (rem <= 67) field = `bus ${Math.floor(rem / 6) + 1} send, byte ${rem % 6}`;
      else if (rem === 96 || rem === 97) field = `fader (LE16 ${rem === 96 ? "lo" : "hi"})`;
      else if (rem === 98) field = "pan";
      else if (rem >= 114 && rem <= 133) {
        field = `FX ${Math.floor((rem - 114) / 6) + 1} send, byte ${(rem - 114) % 6}`;
      }
      return `b3 0x${b3.toString(16).padStart(2, "0")} — fader/send section ${field}`;
    }
  }

  // 5. Bus link region (matrix/group/Main LR stereo links; layout only
  //    partially decoded — see SQ-PROTOCOL.md §10.2). Checked BEFORE the
  //    preamp-gain formula: for higher b3 the gain offsets numerically reach
  //    into this region, and link changes are the interesting ones.
  if (offset >= BUS_LINK_REGION[0] && offset < BUS_LINK_REGION[1]) {
    const entry = Math.floor(offset / LINK_ENTRY_STRIDE) * LINK_ENTRY_STRIDE;
    return `bus link region @${entry} (entry byte ${offset % LINK_ENTRY_STRIDE})`;
  }

  // 6. Preamp gain section.
  const gainRel = offset - GAIN_BASE;
  if (gainRel >= 0) {
    const b3 = Math.floor(gainRel / BLOCK_STRIDE);
    const rem = gainRel % BLOCK_STRIDE;
    if (b3 <= GAIN_B3_MAX && rem <= 1) {
      return `b3 0x${b3.toString(16).padStart(2, "0")} — preamp gain (LE16 ${rem === 0 ? "lo" : "hi"})`;
    }
  }

  return `unknown region @${offset}`;
}

/** Group consecutive offsets into runs for compact display. */
function runs(changes: ByteChange[]): ByteChange[][] {
  const groups: ByteChange[][] = [];
  for (const c of changes) {
    const last = groups[groups.length - 1];
    if (last && c.offset === last[last.length - 1].offset + 1) last.push(c);
    else groups.push([c]);
  }
  return groups;
}

/**
 * Full human-readable diff of two ParamData dumps. Changed bytes are grouped
 * into consecutive runs, every run is decoded to its ParamData location, and
 * obvious single-cause patterns get a verdict hint at the end.
 */
export function diffParamData(a: Buffer, b: Buffer): string {
  const lines: string[] = [];
  lines.push("=== ParamData diff ===");
  lines.push(`A: ${a.length} bytes, B: ${b.length} bytes`);
  if (a.length !== b.length) {
    lines.push("WARNING: sizes differ — different firmware or truncated capture.");
  }
  const changes = diffBuffers(a, b);
  lines.push(`Changed bytes: ${changes.length}`);
  if (changes.length === 0) {
    lines.push("Dumps are identical.");
    return lines.join("\n");
  }

  lines.push("");
  for (const run of runs(changes)) {
    const first = run[0];
    const desc = describeOffset(first.offset);
    if (run.length === 1) {
      lines.push(
        `  @${first.offset}: 0x${first.from.toString(16).padStart(2, "0")} → 0x${first.to
          .toString(16)
          .padStart(2, "0")}  — ${desc}`
      );
    } else {
      const last = run[run.length - 1];
      const hexFrom = run.map((c) => c.from.toString(16).padStart(2, "0")).join(" ");
      const hexTo = run.map((c) => c.to.toString(16).padStart(2, "0")).join(" ");
      lines.push(`  @${first.offset}..${last.offset} (${run.length} bytes):`);
      lines.push(`    from: ${hexFrom}`);
      lines.push(`    to:   ${hexTo}`);
      lines.push(`    — ${desc}`);
    }
  }

  // Verdict hints for the classic controlled-dump experiments.
  lines.push("");
  lines.push("Hints:");
  const headerMaskChanges = changes.filter((c) => c.offset >= 90 && c.offset <= 93);
  if (headerMaskChanges.length > 0) {
    lines.push(
      `- Header stereo bitmap changed (@90..93) — mix bus stereo toggle is @90..91 ` +
        "(u16LE, bit i = Mix i+1), matrix pair gang is @93 (bit3/4/5 = pair 1/2/3)."
    );
  }
  const mixModeRuns = runs(changes).filter((run) => {
    const rel = run[0].offset - BLOCK_BASE;
    if (rel < 0) return false;
    const b3 = Math.floor(rel / BLOCK_STRIDE);
    const rem = rel % BLOCK_STRIDE;
    return run.length === 1 && rem === SLOT_FLAG_OFFSET && b3 >= 0x58 && b3 <= 0x63;
  });
  if (mixModeRuns.length > 0) {
    lines.push(
      `- Sticky slot flag (+331) changed in ${mixModeRuns.length} place(s) — ` +
        "this flag is NOT the stereo mode (it survives Bus Config changes " +
        "without being updated); the stereo state lives in header @90..91."
    );
  }
  const busLinkChanges = changes.filter(
    (c) => c.offset >= BUS_LINK_REGION[0] && c.offset < BUS_LINK_REGION[1]
  );
  if (busLinkChanges.length > 0) {
    lines.push(
      `- ${busLinkChanges.length} changed byte(s) inside the bus link region ` +
        `(${BUS_LINK_REGION[0]}–${BUS_LINK_REGION[1]}) — sticky gang marks ` +
        "(0x10 entries vanish when a matrix is broken to mono, but do not " +
        "come back on re-gang). Authoritative state: header @90..93."
    );
  }
  if (
    mixModeRuns.length === 0 &&
    busLinkChanges.length === 0 &&
    headerMaskChanges.length === 0
  ) {
    lines.push("- No link/mode changes — the diffs above are channel state (names, levels).");
  }
  return lines.join("\n");
}
