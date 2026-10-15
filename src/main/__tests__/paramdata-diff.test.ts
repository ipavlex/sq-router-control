/**
 * Unit tests for the ParamData diff decoder. Synthetic buffers — only the
 * diff/describe logic is exercised, no console needed.
 */
import { describe, it } from "node:test";
import assert from "node:assert/strict";
import {
  BUS_LINK_REGION,
  LINK_TABLE_OFFSET,
  describeOffset,
  diffBuffers,
  diffParamData,
} from "../paramdata-diff";

/** Reference blob size (SQ-5 dump). */
const SIZE = 97376;

/** Mix 1 bus-mode byte: 884 + 0x58*336 + 331. */
const MIX1_MODE = 884 + 0x58 * 336 + 331;

describe("diffBuffers", () => {
  it("reports every changed byte with from/to values", () => {
    const a = Buffer.from([1, 2, 3, 4]);
    const b = Buffer.from([1, 5, 3, 6]);
    assert.deepEqual(diffBuffers(a, b), [
      { offset: 1, from: 2, to: 5 },
      { offset: 3, from: 4, to: 6 },
    ]);
  });

  it("returns an empty list for identical buffers", () => {
    const a = Buffer.alloc(64, 0xab);
    assert.deepEqual(diffBuffers(a, Buffer.from(a)), []);
  });
});

describe("describeOffset", () => {
  it("decodes a mix channel-block bus-mode byte", () => {
    const desc = describeOffset(MIX1_MODE);
    assert.match(desc, /Mix 1 \(b3 0x58\)/);
    assert.match(desc, /\+331/);
    assert.match(desc, /mono\/stereo/);
  });

  it("decodes a group name byte and flags byte", () => {
    const group1Base = 884 + 0x48 * 336;
    assert.match(describeOffset(group1Base + 3), /Group 1 .*name byte \+3/);
    assert.match(describeOffset(group1Base + 332), /Group 1 .*flags/);
  });

  it("decodes a matrix block offset", () => {
    const mtx = 884 + 0x75 * 336 + 100;
    assert.match(describeOffset(mtx), /Matrix 2 L \(b3 0x75\).*\+100/);
  });

  it("decodes the input stereo-link table entries", () => {
    const desc = describeOffset(LINK_TABLE_OFFSET + 6 * 4 + 2);
    assert.match(desc, /input stereo-link table, entry b3 0x06 \(flags\)/);
  });

  it("decodes the fader/send section", () => {
    // Fader LE16 lo of b3 0x02: 43520 + 2*300 + 96.
    assert.match(describeOffset(43520 + 2 * 300 + 96), /fader\/send section fader \(LE16 lo\)/);
    // Bus 3 send of b3 0x00: bytes 12..17.
    assert.match(describeOffset(43520 + 12), /bus 3 send/);
  });

  it("decodes the preamp gain section", () => {
    // b3 0: 80028..80029 — below the bus-link region, unambiguous gain.
    assert.match(describeOffset(80028), /preamp gain \(LE16 lo\)/);
    assert.match(describeOffset(80028 + 1), /preamp gain \(LE16 hi\)/);
  });

  it("decodes the bus link region and unknown offsets", () => {
    // Inside the observed region, outside the input link table.
    assert.match(describeOffset(82485), /bus link region/);
    assert.match(describeOffset(500), /unknown region @500/);
  });
});

describe("diffParamData", () => {
  it("flags a clean single mix-mode experiment with a verdict", () => {
    const a = Buffer.alloc(SIZE);
    const b = Buffer.from(a);
    b[MIX1_MODE] = 1;
    const report = diffParamData(a, b);
    assert.match(report, /Changed bytes: 1/);
    assert.match(report, /Mix 1 \(b3 0x58\).*\+331/);
    assert.match(report, /CONFIRMS the mix mono\/stereo mode byte \(polarity 1 = stereo\)/);
  });

  it("flags a bus-link-only experiment as clean", () => {
    const a = Buffer.alloc(SIZE);
    const b = Buffer.from(a);
    b[82485] = 0x10; // inside the bus link region
    b[82489] = 0x0f;
    const report = diffParamData(a, b);
    assert.match(report, /bus link region/);
    assert.match(report, /ALL changes are in the bus link region/);
  });

  it("identical dumps produce an empty diff", () => {
    const a = Buffer.alloc(1024, 7);
    assert.match(diffParamData(a, Buffer.from(a)), /Dumps are identical/);
  });

  it("groups consecutive name bytes into one run", () => {
    const a = Buffer.alloc(SIZE);
    const b = Buffer.from(a);
    const name = 884 + 0x48 * 336; // Group 1 name
    b[name + 2] = 0x56; // 'V'
    b[name + 3] = 0x6f; // 'o'
    const report = diffParamData(a, b);
    assert.match(report, /2 bytes\)/);
    assert.match(report, /Group 1 .*name byte \+2/);
  });
});
