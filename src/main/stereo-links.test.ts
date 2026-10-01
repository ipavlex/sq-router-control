/**
 * Unit tests for the ParamData stereo-link table decoder.
 * Synthetic blob — the table only needs to exist at its fixed offset.
 */
import { describe, it } from "node:test";
import assert from "node:assert/strict";
import {
  STEREO_ENTRY_STRIDE,
  STEREO_TABLE_INPUT_ENTRIES,
  STEREO_TABLE_OFFSET,
  decodeStereoPairs,
  pairEncoding,
  readStereoEntry,
} from "./stereo-links";

const FLAGS_LEFT = 0x0f;
const FLAGS_RIGHT_A = 0x10;

/** A blob large enough to hold the whole input section of the table. */
function blob(): Buffer {
  return Buffer.alloc(STEREO_TABLE_OFFSET + STEREO_TABLE_INPUT_ENTRIES * STEREO_ENTRY_STRIDE);
}

function put(buf: Buffer, b3: number, target: number, flags: number): void {
  const off = STEREO_TABLE_OFFSET + b3 * STEREO_ENTRY_STRIDE;
  buf.writeUInt16LE(target, off);
  buf[off + 2] = flags;
}

describe("readStereoEntry", () => {
  it("reads a table entry at the fixed offset", () => {
    const buf = blob();
    put(buf, 6, 0x0030, FLAGS_LEFT);
    assert.deepEqual(readStereoEntry(buf, 6), { b3: 6, target: 0x0030, flags: FLAGS_LEFT });
  });

  it("returns null beyond the payload", () => {
    assert.equal(readStereoEntry(Buffer.alloc(STEREO_TABLE_OFFSET), 0), null);
  });
});

describe("pairEncoding", () => {
  const left = (b3: number, target: number, flags: number) => ({ b3, target, flags });

  it("recognises encoding A (right back-links to the left channel)", () => {
    assert.equal(
      pairEncoding(left(4, 4, FLAGS_LEFT), left(5, 4, FLAGS_RIGHT_A)),
      "A"
    );
  });

  it("recognises encoding B (both 0x0f, consecutive slot targets)", () => {
    assert.equal(pairEncoding(left(44, 0x58, FLAGS_LEFT), left(45, 0x59, FLAGS_LEFT)), "B");
  });

  it("rejects a shared target that is not a consecutive pair", () => {
    // Both channels point at the same slot (unlinked) — right carries 0x10.
    assert.equal(pairEncoding(left(2, 0x30, FLAGS_LEFT), left(3, 0x30, FLAGS_RIGHT_A)), null);
  });

  it("rejects encoding B when the target equals the channel's own b3", () => {
    assert.equal(pairEncoding(left(4, 4, FLAGS_LEFT), left(5, 5, FLAGS_LEFT)), null);
  });

  it("rejects encoding B when the target is zero", () => {
    assert.equal(pairEncoding(left(4, 0, FLAGS_LEFT), left(5, 1, FLAGS_LEFT)), null);
  });

  it("rejects a mismatched flag combination", () => {
    assert.equal(
      pairEncoding(left(4, 4, FLAGS_LEFT), left(5, 4, FLAGS_LEFT)),
      null
    );
  });
});

describe("decodeStereoPairs", () => {
  it("returns only even/odd linked pairs in ascending order", () => {
    const buf = blob();
    // [0,1] — encoding A.
    put(buf, 0, 0, FLAGS_LEFT);
    put(buf, 1, 0, FLAGS_RIGHT_A);
    // [2,3] — unlinked (shared target, right 0x10).
    put(buf, 2, 0x30, FLAGS_LEFT);
    put(buf, 3, 0x30, FLAGS_RIGHT_A);
    // [4,5] — encoding B.
    put(buf, 4, 0x50, FLAGS_LEFT);
    put(buf, 5, 0x51, FLAGS_LEFT);
    assert.deepEqual(decodeStereoPairs(buf), [
      [0, 1],
      [4, 5],
    ]);
  });

  it("returns an empty list for an unlinked console", () => {
    const buf = blob();
    for (let b3 = 0; b3 < STEREO_TABLE_INPUT_ENTRIES; b3 += 2) {
      put(buf, b3, b3, FLAGS_LEFT);
      put(buf, b3 + 1, b3 + 1, FLAGS_LEFT);
    }
    assert.deepEqual(decodeStereoPairs(buf), []);
  });

  it("stops cleanly when the table is truncated", () => {
    const buf = Buffer.alloc(STEREO_TABLE_OFFSET + 8);
    assert.deepEqual(decodeStereoPairs(buf), []);
  });
});
