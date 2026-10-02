/**
 * Unit tests for mixer channel-state decoding and wire→unit converters.
 */
import { describe, it } from "node:test";
import assert from "node:assert/strict";
import {
  MixerState,
  wireToDb,
  wireToDelayMs,
  wireToHpfHz,
  wireToPan,
  wireToTrimDb,
} from "../state";
import type { DspFrame } from "../transport/connection";

/** Build a DSP frame with the given register fields. */
function dsp(
  category: number,
  register: number,
  modifier: number,
  value: number,
  ch = 0
): DspFrame {
  return { ch, category, register, modifier, value, raw: Buffer.alloc(0) };
}

describe("wire converters", () => {
  it("wireToDb is 0x8000-based, 256 units per dB", () => {
    assert.equal(wireToDb(0x8000), 0);
    assert.equal(wireToDb(0x8000 + 256), 1);
    assert.equal(wireToDb(0x8000 - 512), -2);
  });

  it("wireToTrimDb spans ±24 dB around the centre", () => {
    const centre = (26624 + 36824) / 2;
    assert.equal(wireToTrimDb(centre), 0);
    assert.ok(Math.abs(wireToTrimDb(centre + 212.5) - 1) < 1e-9);
    assert.ok(Math.abs(wireToTrimDb(centre - 212.5) + 1) < 1e-9);
  });

  it("wireToPan maps 0..74 to -1..+1 with 37 at centre", () => {
    assert.equal(wireToPan(37), 0);
    assert.equal(wireToPan(0), -1);
    assert.equal(wireToPan(74), 1);
  });

  it("wireToHpfHz decodes the log scale to 20 Hz / 2 kHz", () => {
    assert.ok(Math.abs(wireToHpfHz(10710) - 20) < 0.1);
    assert.ok(Math.abs(wireToHpfHz(41327) - 2000) < 1);
  });

  it("wireToDelayMs is 96 units per ms", () => {
    assert.equal(wireToDelayMs(0), 0);
    assert.equal(wireToDelayMs(96), 1);
    assert.equal(wireToDelayMs(96 * 341), 341);
  });
});

describe("MixerState.handleDsp — fader / mute / pan", () => {
  it("decodes mute", () => {
    const m = new MixerState();
    assert.equal(m.handleDsp(dsp(0x07, 0x0c, 0, 1)), true);
    assert.equal(m.get(0)?.muted, true);
    m.handleDsp(dsp(0x07, 0x0c, 0, 0));
    assert.equal(m.get(0)?.muted, false);
  });

  it("decodes fader dB, with 0 meaning -Infinity", () => {
    const m = new MixerState();
    m.handleDsp(dsp(0x07, 0x0e, 0x20, 0x8000 + 1536));
    assert.equal(m.get(0)?.faderDb, 6);
    m.handleDsp(dsp(0x07, 0x0e, 0x20, 0));
    assert.equal(m.get(0)?.faderDb, -Infinity);
  });

  it("decodes pan", () => {
    const m = new MixerState();
    m.handleDsp(dsp(0x07, 0x10, 0x20, 37));
    assert.equal(m.get(0)?.pan, 0);
    m.handleDsp(dsp(0x07, 0x10, 0x20, 0));
    assert.equal(m.get(0)?.pan, -1);
  });
});

describe("MixerState.handleDsp — sends", () => {
  it("decodes bus sends 1-12 normalised to 0..1", () => {
    const m = new MixerState();
    assert.equal(m.handleDsp(dsp(0x07, 0x0e, 0x10, 35328)), true);
    assert.equal(m.get(0)?.busSends[0], 1);
    m.handleDsp(dsp(0x07, 0x0e, 0x1b, 0));
    assert.equal(m.get(0)?.busSends[11], 0);
  });

  it("decodes FX sends 1-4 normalised to 0..1", () => {
    const m = new MixerState();
    m.handleDsp(dsp(0x07, 0x0e, 0x23, 17664));
    assert.equal(m.get(0)?.fxSends[0], 0.5);
  });

  it("ignores an out-of-range send modifier", () => {
    const m = new MixerState();
    assert.equal(m.handleDsp(dsp(0x07, 0x0e, 0x30, 1)), false);
  });
});

describe("MixerState.handleDsp — preamp and dynamics", () => {
  it("decodes gain, trim and polarity", () => {
    const m = new MixerState();
    m.handleDsp(dsp(0x0c, 0x0c, 0, 0x8000 + 1536));
    assert.equal(m.get(0)?.gainDb, 6);
    m.handleDsp(dsp(0x0c, 0x0f, 0, 26624));
    assert.ok(Math.abs((m.get(0)?.trimDb as number) + 24) < 1e-9);
    m.handleDsp(dsp(0x0c, 0x10, 0, 1));
    assert.equal(m.get(0)?.polarityOn, true);
  });

  it("decodes HPF on/off and frequency", () => {
    const m = new MixerState();
    m.handleDsp(dsp(0x0e, 0x0c, 0, 1));
    m.handleDsp(dsp(0x0e, 0x0d, 0, 10710));
    assert.equal(m.get(0)?.hpfOn, true);
    assert.ok(Math.abs((m.get(0)?.hpfHz as number) - 20) < 0.1);
  });

  it("decodes gate, compressor and delay", () => {
    const m = new MixerState();
    m.handleDsp(dsp(0x0f, 0x0c, 0, 1));
    m.handleDsp(dsp(0x13, 0x0c, 0, 1));
    m.handleDsp(dsp(0x14, 0x0c, 0, 1));
    m.handleDsp(dsp(0x14, 0x0d, 0, 96));
    assert.equal(m.get(0)?.gateOn, true);
    assert.equal(m.get(0)?.compOn, true);
    assert.equal(m.get(0)?.delayOn, true);
    assert.equal(m.get(0)?.delayMs, 1);
  });
});

describe("MixerState — validation, snapshot, reset", () => {
  it("returns false for unknown category/register and out-of-range channel", () => {
    const m = new MixerState();
    assert.equal(m.handleDsp(dsp(0x99, 0x0c, 0, 1)), false);
    assert.equal(m.handleDsp(dsp(0x07, 0x99, 0, 1)), false);
    assert.equal(m.handleDsp(dsp(0x07, 0x0c, 0, 1, 0x80)), false);
  });

  it("tracks known channels and returns null for unknown ones", () => {
    const m = new MixerState();
    assert.equal(m.get(5), null);
    m.handleDsp(dsp(0x07, 0x0c, 0, 1, 5));
    m.handleDsp(dsp(0x07, 0x0c, 0, 1, 2));
    assert.equal(m.knownCount, 2);
    assert.deepEqual(
      m.snapshot().map((c) => c.b3),
      [2, 5]
    );
  });

  it("snapshot copies the send arrays", () => {
    const m = new MixerState();
    m.handleDsp(dsp(0x07, 0x0e, 0x10, 35328));
    const snap = m.snapshot();
    snap[0].busSends[0] = 123;
    assert.equal(m.get(0)?.busSends[0], 1);
  });

  it("reset clears every channel", () => {
    const m = new MixerState();
    m.handleDsp(dsp(0x07, 0x0c, 0, 1));
    m.reset();
    assert.equal(m.knownCount, 0);
    assert.equal(m.get(0), null);
  });
});
