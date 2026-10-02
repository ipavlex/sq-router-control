/**
 * Unit tests for the SQ UDP meter decoders.
 *
 * Test datagrams are always assembled as Buffer.concat([6-byte header, body]):
 * the header's first two u16 LE slots overlap the "body" if written in place
 * (SQ-PROTOCOL.md §8.8).
 */
import { describe, it, beforeEach } from "node:test";
import assert from "node:assert/strict";
import {
  decodeMeterMessage,
  diffMeterBody,
  formatMeterChanges,
  hotMeterSlots,
  meterBody,
  meterSamplePreview,
  rawToDb,
  resetMeters,
} from "../meters";

const FLOOR = 0x1201;
const ZERO_DB = 0x8000;

/** Build a meter datagram: [0x7F][id][len u16LE][0,0][body]. */
function meterMsg(id: number, values: number[]): Buffer {
  const body = Buffer.alloc(values.length * 2);
  values.forEach((v, i) => body.writeUInt16LE(v, i * 2));
  const header = Buffer.alloc(6);
  header[0] = 0x7f;
  header[1] = id;
  header.writeUInt16LE(body.length, 2);
  return Buffer.concat([header, body]);
}

const fill = (n: number, v: number): number[] => new Array(n).fill(v);

/** 48-channel detailed packet body values (11 slots per channel). */
function detailBody(): number[] {
  return fill(48 * 11, FLOOR);
}

/** 40-bus × 6-slot packet body values. */
function busBody(): number[] {
  return fill(40 * 6, FLOOR);
}

function setBus(values: number[], bus: number, l1: number, r1: number, l2: number, r2: number): void {
  const base = bus * 6;
  values[base] = l1;
  values[base + 1] = r1;
  values[base + 3] = l2;
  values[base + 4] = r2;
}

beforeEach(() => resetMeters());

describe("rawToDb", () => {
  it("maps 0x8000 to 0 dBFS", () => {
    assert.equal(rawToDb(ZERO_DB), 0);
  });

  it("maps +1 dB per 256 raw units", () => {
    assert.equal(rawToDb(ZERO_DB + 256), 1);
    assert.equal(rawToDb(ZERO_DB - 256), -1);
  });

  it("treats the floor sentinel and below as no signal", () => {
    assert.equal(rawToDb(FLOOR), null);
    assert.equal(rawToDb(0), null);
    assert.equal(rawToDb(0x1200), null);
  });
});

describe("meterBody", () => {
  it("extracts the declared body", () => {
    const msg = meterMsg(0x17, [1, 2, 3]);
    const body = meterBody(msg);
    assert.ok(body);
    assert.deepEqual([...body], [1, 0, 2, 0, 3, 0]);
  });

  it("rejects datagrams without the 0x7F marker", () => {
    assert.equal(meterBody(Buffer.from([0, 1, 2, 3, 4, 5])), null);
    assert.equal(meterBody(Buffer.alloc(5)), null);
  });

  it("rejects a body shorter than the declared length", () => {
    const msg = meterMsg(0x17, [1, 2]);
    const truncated = msg.slice(0, msg.length - 1);
    assert.equal(meterBody(truncated), null);
  });
});

describe("decodeMeterMessage — id=0x17 (per-channel)", () => {
  it("decodes 48 input levels", () => {
    const values = fill(48, FLOOR);
    values[0] = ZERO_DB;
    values[1] = ZERO_DB - 512; // -2 dB
    const m = decodeMeterMessage(meterMsg(0x17, values));
    assert.ok(m);
    assert.equal(m.inputs[0], 0);
    assert.equal(m.inputs[1], -2);
    assert.equal(m.inputs[2], null);
    assert.equal(m.inputs.length, 48);
    assert.ok(m.clip.every((c) => c === false));
  });
});

describe("decodeMeterMessage — id=0x06 (detailed)", () => {
  it("uses the louder of the two leading slots per channel", () => {
    const values = detailBody();
    values[0] = ZERO_DB; // ch0 slot0
    values[1] = ZERO_DB - 1024; // ch0 slot1 (quieter)
    const m = decodeMeterMessage(meterMsg(0x06, values));
    assert.ok(m);
    assert.equal(m.inputs[0], 0);
  });

  it("flags a clip above 0 dBFS", () => {
    const values = detailBody();
    values[0] = ZERO_DB + 256; // +1 dB
    const m = decodeMeterMessage(meterMsg(0x06, values));
    assert.ok(m);
    assert.equal(m.inputs[0], 1);
    assert.equal(m.clip[0], true);
    assert.equal(m.clip[1], false);
  });

  it("does not flag a clip exactly at 0 dBFS", () => {
    const values = detailBody();
    values[0] = ZERO_DB;
    const m = decodeMeterMessage(meterMsg(0x06, values));
    assert.ok(m);
    assert.equal(m.clip[0], false);
  });
});

describe("decodeMeterMessage — id=0x18 (buses)", () => {
  it("decodes Main LR and Mix 1 per-side levels", () => {
    const values = busBody();
    // Main LR (bus 23): taps -1 / floor and +1 / floor.
    setBus(values, 23, ZERO_DB - 256, FLOOR, ZERO_DB + 256, FLOOR);
    // Mix 1 (bus 24): L taps -4 / -2 (louder wins), R tap -6.
    setBus(values, 24, ZERO_DB - 1024, ZERO_DB - 1536, ZERO_DB - 512, FLOOR);
    const m = decodeMeterMessage(meterMsg(0x18, values));
    assert.ok(m);
    assert.equal(m.mixes?.length, 12);
    assert.equal(m.mixes?.[0], -2);
    assert.equal(m.mixesL?.[0], -2);
    assert.equal(m.mixesR?.[0], -6);
    assert.equal(m.mainLRL, 1);
    assert.equal(m.mainLRR, null);
    assert.equal(m.mainLR, 1);
    assert.equal(m.mainLRClip, true);
    assert.equal(m.mainLRClipL, true);
    assert.equal(m.mainLRClipR, false);
  });

  it("ignores 0x0000 and >=0xF000 placeholders", () => {
    const values = busBody();
    setBus(values, 24, 0x0000, 0xffff, 0x0000, 0xf000);
    const m = decodeMeterMessage(meterMsg(0x18, values));
    assert.ok(m);
    assert.equal(m.mixesL?.[0], null);
    assert.equal(m.mixesR?.[0], null);
    assert.equal(m.mixes?.[0], null);
  });
});

describe("decodeMeterMessage — merging and validation", () => {
  it("merges bus data into the input snapshot", () => {
    const single = fill(48, FLOOR);
    single[0] = ZERO_DB;
    decodeMeterMessage(meterMsg(0x17, single));
    const buses = busBody();
    setBus(buses, 24, ZERO_DB - 256, FLOOR, FLOOR, FLOOR);
    const m = decodeMeterMessage(meterMsg(0x18, buses));
    assert.ok(m);
    assert.equal(m.inputs[0], 0); // retained from the 0x17 read
    assert.equal(m.mixes?.[0], -1);
  });

  it("returns null for an unknown packet id", () => {
    assert.equal(decodeMeterMessage(meterMsg(0x07, [1, 2, 3])), null);
  });

  it("returns null for a short/wrong packet", () => {
    assert.equal(decodeMeterMessage(Buffer.from([0x00, 0x17, 0, 0, 0, 0])), null);
    // Correct id but body too short for 48 channels.
    assert.equal(decodeMeterMessage(meterMsg(0x17, [1, 2])), null);
  });
});

describe("resetMeters", () => {
  it("clears the accumulated state", () => {
    const single = fill(48, FLOOR);
    single[0] = ZERO_DB;
    decodeMeterMessage(meterMsg(0x17, single));
    resetMeters();
    const m = decodeMeterMessage(meterMsg(0x17, fill(48, FLOOR)));
    assert.ok(m);
    assert.equal(m.inputs[0], null);
  });
});

describe("meterSamplePreview", () => {
  it("renders one line of slots and marks the floor", () => {
    const preview = meterSamplePreview(meterMsg(0x07, [ZERO_DB, FLOOR, ZERO_DB + 256]));
    assert.equal(preview, "[0]0.0 [1]-inf [2]1.0");
  });

  it("trims large bodies and reports the omitted count", () => {
    const preview = meterSamplePreview(meterMsg(0x07, fill(100, ZERO_DB)));
    assert.ok(preview?.endsWith("…(+84)"));
  });

  it("returns null without a framed body", () => {
    assert.equal(meterSamplePreview(Buffer.from([0, 0, 0])), null);
  });
});

describe("diffMeterBody", () => {
  it("returns no changes without a baseline", () => {
    const body = Buffer.alloc(4);
    body.writeUInt16LE(ZERO_DB, 0);
    body.writeUInt16LE(FLOOR, 2);
    const d = diffMeterBody(body, null);
    assert.deepEqual(d.raws, [ZERO_DB, FLOOR]);
    assert.deepEqual(d.changed, []);
  });

  it("reports slots that moved by at least ~0.25 dB", () => {
    const prev = [ZERO_DB, ZERO_DB];
    const body = Buffer.alloc(4);
    body.writeUInt16LE(ZERO_DB + 0x40, 0); // exactly the threshold
    body.writeUInt16LE(ZERO_DB + 0x3f, 2); // just below
    const d = diffMeterBody(body, prev);
    assert.equal(d.changed.length, 1);
    assert.equal(d.changed[0].idx, 0);
    assert.equal(d.changed[0].db, 0.25);
  });

  it("skips sentinel values", () => {
    const prev = [0xffff, ZERO_DB];
    const body = Buffer.alloc(4);
    body.writeUInt16LE(0xfffe, 0);
    body.writeUInt16LE(ZERO_DB + 256, 2);
    const d = diffMeterBody(body, prev);
    assert.deepEqual(
      d.changed.map((c) => c.idx),
      [1]
    );
  });

  it("caps the number of reported changes", () => {
    const prev = fill(40, ZERO_DB);
    const body = Buffer.alloc(40 * 2);
    for (let i = 0; i < 40; i++) body.writeUInt16LE(ZERO_DB + 256, i * 2);
    const d = diffMeterBody(body, prev);
    assert.equal(d.changed.length, 16);
  });
});

describe("hotMeterSlots", () => {
  it("returns the loudest slots first, skipping floor and sentinels", () => {
    const values = [FLOOR, ZERO_DB, 0xffff, ZERO_DB - 256 * 60, ZERO_DB + 256];
    const body = Buffer.alloc(values.length * 2);
    values.forEach((v, i) => body.writeUInt16LE(v, i * 2));
    const hot = hotMeterSlots(body);
    assert.deepEqual(
      hot.map((h) => h.idx),
      [4, 1]
    );
    assert.equal(hot[0].db, 1);
  });
});

describe("formatMeterChanges", () => {
  it("formats indices with one decimal and -inf", () => {
    assert.equal(
      formatMeterChanges([
        { idx: 8, db: -14.25 },
        { idx: 23, db: null },
      ]),
      "[8]-14.3 [23]-inf"
    );
  });
});
