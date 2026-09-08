/**
 * ParamData diagnostics — stereo-link table forensics.
 *
 * The live parser reads the stereo-link table at a fixed offset (81548,
 * confirmed on SQ-5) using stereo-links.ts. If a future firmware shifts the
 * blob layout, this report helps relocate the table:
 *
 *   1. What the current parser decodes (per-entry dump + pairs).
 *   2. A full-blob scan for regions that look like the 48×4-byte table,
 *      ranked by structural match.
 */
import {
  STEREO_TABLE_OFFSET,
  STEREO_ENTRY_STRIDE,
  STEREO_TABLE_INPUT_ENTRIES,
  readStereoEntry,
  decodeStereoPairs,
  pairEncoding,
} from "./stereo-links";

interface Candidate {
  offset: number;
  /** Entries whose 4th byte is the expected 0xfe terminator. */
  tailFe: number;
  /** Entries whose flags byte is 0x0f (mono/left) or 0x10 (right side). */
  flagsValid: number;
  /** Encoding-A right-side entries whose target points at the previous channel. */
  rightAdjacent: number;
  /** Total right-side entries. */
  rightCount: number;
}

function entriesBlock(payload: Buffer, offset: number): string {
  const lines: string[] = [];
  for (let i = 0; i < STEREO_TABLE_INPUT_ENTRIES; i++) {
    const e = readStereoEntryAt(payload, offset, i);
    if (!e) break;
    let suffix = "";
    if (i % 2 === 0) {
      const r = readStereoEntryAt(payload, offset, i + 1);
      if (r) {
        const enc = pairEncoding(e, r);
        if (enc) suffix = `   ← linked (${enc})`;
      }
    }
    lines.push(
      `  b3 ${i.toString(16).padStart(2, "0")}: target=0x${e.target
        .toString(16)
        .padStart(4, "0")} flags=0x${e.flags.toString(16).padStart(2, "0")} tail=0x${e.tail
        .toString(16)
        .padStart(2, "0")}${suffix}`
    );
  }
  return lines.join("\n");
}

/** Read an entry relative to a candidate table base offset. */
function readStereoEntryAt(
  payload: Buffer,
  offset: number,
  b3: number
): { b3: number; target: number; flags: number; tail: number } | null {
  const e = offset + b3 * STEREO_ENTRY_STRIDE;
  if (e + STEREO_ENTRY_STRIDE > payload.length) return null;
  return {
    b3,
    target: payload.readUInt16LE(e),
    flags: payload[e + 2],
    tail: payload[e + 3],
  };
}

/** Score one candidate offset: how much it looks like the stereo table. */
function scoreOffset(payload: Buffer, offset: number): Candidate | null {
  let tailFe = 0;
  let flagsValid = 0;
  let rightAdjacent = 0;
  let rightCount = 0;
  for (let i = 0; i < STEREO_TABLE_INPUT_ENTRIES; i++) {
    const e = readStereoEntryAt(payload, offset, i);
    if (!e) return null;
    if (e.tail === 0xfe) tailFe++;
    if (e.flags === 0x0f || e.flags === 0x10) flagsValid++;
    if (e.flags === 0x10) {
      rightCount++;
      if (i > 0) {
        const prev = readStereoEntryAt(payload, offset, i - 1);
        if (prev && e.target === i - 1) rightAdjacent++;
      }
    }
  }
  // Require a strong flags signature — that is the most stable marker.
  if (flagsValid < STEREO_TABLE_INPUT_ENTRIES - 6) return null;
  return { offset, tailFe, flagsValid, rightAdjacent, rightCount };
}

function scanCandidates(payload: Buffer): Candidate[] {
  const found: Candidate[] = [];
  const last = payload.length - STEREO_TABLE_INPUT_ENTRIES * STEREO_ENTRY_STRIDE;
  for (let o = 0; o <= last; o++) {
    const c = scoreOffset(payload, o);
    if (c) found.push(c);
  }
  found.sort(
    (a, b) =>
      b.flagsValid - a.flagsValid ||
      b.rightAdjacent - a.rightAdjacent ||
      b.tailFe - a.tailFe ||
      a.offset - b.offset
  );
  return found.slice(0, 10);
}

export interface StereoDiagnostics {
  /** Full human-readable report (write next to the raw dump). */
  report: string;
  /** Best-scoring candidate offset, or null if nothing plausible was found. */
  bestOffset: number | null;
}

export function analyzeStereoTable(payload: Buffer): StereoDiagnostics {
  const decodedPairs = decodeStereoPairs(payload);
  const candidates = scanCandidates(payload);

  const parts: string[] = [];
  parts.push("=== ParamData stereo-table diagnostics ===");
  parts.push(`Blob size: ${payload.length} bytes`);
  parts.push("");
  parts.push(
    `Parser offset: ${STEREO_TABLE_OFFSET} (${STEREO_TABLE_INPUT_ENTRIES} × ${STEREO_ENTRY_STRIDE} bytes) → ` +
      `${decodedPairs.length} pairs: ${JSON.stringify(decodedPairs)}`
  );
  parts.push("");
  parts.push("--- Table region, per-entry decode ---");
  parts.push(entriesBlock(payload, STEREO_TABLE_OFFSET));
  parts.push("");
  parts.push("--- Candidate stereo tables (scan of whole blob) ---");
  parts.push(
    "Scoring: flagsValid = entries with flags 0x0f/0x10, rightAdjacent = " +
      "right-side entries with target == index-1, tailFe = entries ending 0xfe."
  );
  if (candidates.length === 0) {
    parts.push(
      "No plausible region found — flags at the real table differ from " +
        "0x0f/0x10 on this firmware. Send the .bin dump for manual analysis."
    );
  } else {
    for (const c of candidates) {
      const mark = c.offset === STEREO_TABLE_OFFSET ? "  ← current offset" : "";
      parts.push(
        `offset ${c.offset}: flagsValid=${c.flagsValid}/${STEREO_TABLE_INPUT_ENTRIES} rightAdjacent=${c.rightAdjacent}/${c.rightCount} tailFe=${c.tailFe}/${STEREO_TABLE_INPUT_ENTRIES}${mark}`
      );
    }
    // Per-entry detail for the two best candidates that differ from the fixed
    // offset — enough to decode the real table layout by eye.
    for (const c of candidates.filter((c) => c.offset !== STEREO_TABLE_OFFSET).slice(0, 2)) {
      parts.push("");
      parts.push(`--- Candidate region @ ${c.offset}, per-entry decode ---`);
      parts.push(entriesBlock(payload, c.offset));
    }
  }
  parts.push("");
  parts.push("Raw blob: paramdata-dump.bin (same folder).");
  return {
    report: parts.join("\n"),
    bestOffset: candidates.length > 0 ? candidates[0].offset : null,
  };
}
