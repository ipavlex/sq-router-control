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
  decodeSlotFlags,
  decodeLinkedBuses,
  readSlotFlag,
  decodeBusComposition,
  decodeBusStereoMask,
  decodeMatrixStereoPairs,
  CHANNEL_BLOCK_BASE,
  CHANNEL_BLOCK_STRIDE,
  SLOT_FLAG_OFFSET,
  MIX_B3_FIRST,
  MIX_BUS_COUNT,
  isBusAddress,
} from "./stereo-links";

/** Human label for a bus b3. */
function busLabel(b3: number): string {
  if (b3 >= 0x48 && b3 <= 0x4b) return `Group ${b3 - 0x47}`;
  if (b3 >= 0x58 && b3 <= 0x63) return `Mix ${b3 - 0x57}`;
  if (b3 === 0x68) return "Main LR";
  if (b3 >= 0x73 && b3 <= 0x78) return `Matrix slot ${b3 - 0x72}`;
  return `0x${b3.toString(16)}`;
}

/** Bus composition, stereo bitmaps and sticky flags report. */
function busModeBlock(payload: Buffer): string {
  const lines: string[] = [];
  lines.push("--- Bus composition and stereo modes ---");
  const comp = decodeBusComposition(payload);
  if (comp) {
    lines.push(
      `  Composition (header @61/@65): ${comp.aux} aux + ${comp.groups} groups`
    );
  }
  const mask = decodeBusStereoMask(payload);
  if (mask) {
    lines.push(
      `  Mix stereo bitmap (header @90..91, bit i = Mix i+1): ${mask
        .map((b) => (b ? 1 : 0))
        .join("")}`
    );
  }
  const mtx = decodeMatrixStereoPairs(payload);
  lines.push(
    `  Matrix pairs ganged (header @93): ${
      mtx.map(([l, r]) => `0x${l.toString(16)}+0x${r.toString(16)}`).join(", ") ||
      "none"
    }`
  );
  lines.push(
    `  Sticky slot flag: block(${CHANNEL_BLOCK_BASE}) + b3·${CHANNEL_BLOCK_STRIDE} + ${SLOT_FLAG_OFFSET} ` +
      "(NOT the stereo mode — survives Bus Config changes)"
  );
  const flags = decodeSlotFlags(payload);
  for (let i = 0; i < MIX_BUS_COUNT; i++) {
    const b3 = MIX_B3_FIRST + i;
    const abs = CHANNEL_BLOCK_BASE + b3 * CHANNEL_BLOCK_STRIDE + SLOT_FLAG_OFFSET;
    lines.push(
      `  Mix ${(i + 1).toString().padStart(2)} (b3 0x${b3.toString(16)} @ ${abs}): ` +
        `sticky flag ${readSlotFlag(payload, b3) ?? "?"}`
    );
  }
  const linked = decodeLinkedBuses(payload);
  lines.push(
    `  Encoding-A gang marks in blob (sticky, secondary): ${
      linked.map((b) => `${busLabel(b)} (0x${b.toString(16)})`).join(", ") || "none"
    }`
  );
  return lines.join("\n");
}

/** Group bus blocks (b3 0x48-0x4b): name, sticky flag +331, flags +332. */
function groupBlockSection(payload: Buffer): string {
  const lines: string[] = [];
  lines.push("--- Group buses (b3 0x48-0x4b) ---");
  for (let i = 0; i < 4; i++) {
    const b3 = 0x48 + i;
    const blk = CHANNEL_BLOCK_BASE + b3 * CHANNEL_BLOCK_STRIDE;
    if (blk + CHANNEL_BLOCK_STRIDE > payload.length) {
      lines.push(`  Group ${i + 1}: block beyond payload`);
      continue;
    }
    const nameEnd = payload.indexOf(0x00, blk);
    const name = payload
      .slice(blk, nameEnd < 0 || nameEnd > blk + 16 ? blk + 16 : nameEnd)
      .toString("ascii")
      .trimEnd();
    lines.push(
      `  Group ${i + 1} (b3 0x${b3.toString(16)} @ ${blk}): name="${name}" ` +
        `sticky +331=${readSlotFlag(payload, b3) ?? "?"} +332=0x${payload[blk + 332]
          .toString(16)
          .padStart(2, "0")}`
    );
  }
  return lines.join("\n");
}

/**
 * Dump the regions where bus stereo links live. The input table at 81548 does
 * NOT cover buses: their encoding-A pairs (`[t][0f] [t][10]`) sit in separate
 * regions (~81290-82960 on the reference SQ-5 dump). Every 4-byte entry of a
 * region around a found pair is printed so a controlled dump (toggle one
 * matrix / group on the console) immediately reveals the mode-field layout.
 */
function busLinkRegions(payload: Buffer): string {
  // Offsets of encoding-A bus pairs (same pattern as decodeLinkedBuses,
  // but keeping the offsets).
  const pairAt: number[] = [];
  for (let o = 0; o + 8 <= payload.length; o++) {
    const t = payload.readUInt16LE(o);
    if (t === 0 || !isBusAddress(t)) continue;
    if (
      payload.readUInt16LE(o + 4) === t &&
      payload[o + 2] === 0x0f &&
      payload[o + 6] === 0x10
    ) {
      pairAt.push(o);
    }
  }
  const lines: string[] = [];
  lines.push("--- Bus link regions (encoding-A pairs with bus targets) ---");
  if (pairAt.length === 0) {
    lines.push("  none found");
    return lines.join("\n");
  }
  // Merge nearby pair offsets into regions (within 512 bytes of each other).
  const regions: Array<{ start: number; end: number }> = [];
  for (const o of pairAt) {
    const last = regions[regions.length - 1];
    if (last && o - last.end <= 512) last.end = o + 8;
    else regions.push({ start: o, end: o + 8 });
  }
  for (const r of regions) {
    // Widen the dump to whole 4-byte entries around the region.
    const start = Math.max(0, Math.floor(r.start / 4) * 4 - 8 * 4);
    const end = Math.min(payload.length, Math.ceil(r.end / 4) * 4 + 8 * 4);
    lines.push(`  region @${start}..${end}:`);
    for (let off = start; off + 4 <= end; off += 4) {
      const target = payload.readUInt16LE(off);
      const flags = payload[off + 2];
      const tail = payload[off + 3];
      if (target === 0 && flags === 0) continue;
      const tag =
        flags === 0x0f || flags === 0x10 ? ` (${busLabel(target)})` : "";
      lines.push(
        `    @${off}: target=0x${target.toString(16).padStart(2, "0")} ` +
          `flags=0x${flags.toString(16).padStart(2, "0")} ` +
          `tail=0x${tail.toString(16).padStart(2, "0")}${tag}`
      );
    }
  }
  return lines.join("\n");
}

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
  parts.push(busModeBlock(payload));
  parts.push("");
  parts.push(groupBlockSection(payload));
  parts.push("");
  parts.push(busLinkRegions(payload));
  parts.push("");
  parts.push("Raw blob: paramdata-dump.bin (same folder).");
  return {
    report: parts.join("\n"),
    bestOffset: candidates.length > 0 ? candidates[0].offset : null,
  };
}
