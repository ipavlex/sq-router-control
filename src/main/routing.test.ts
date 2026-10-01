/**
 * Unit tests for the routing decoder / state model.
 * DSP frames are synthesised in the wire layout `F7 [7 payload bytes]`:
 * raw[3]=ch, raw[4]=modifier, raw[5]=valLo, raw[6]=valHi.
 */
import { describe, it } from "node:test";
import assert from "node:assert/strict";
import {
  InputPatchSource,
  MonitorOutSource,
  OutputPatchDest,
  RoutingModel,
  b3ToLabel,
  labelToB3,
} from "./routing";
import type { DspFrame } from "./transport/connection";

/** Build a routing DSP frame for the given payload fields. */
function patchFrame(ch: number, modifier: number, valLo: number, valHi: number): DspFrame {
  const raw = Buffer.from([0x0b, 0x0b, 0x0d, ch, modifier, valLo, valHi]);
  return {
    ch,
    category: 0x0b,
    register: 0x0d,
    modifier,
    value: valLo | (valHi << 8),
    raw,
  };
}

describe("b3ToLabel", () => {
  it("maps the documented address ranges", () => {
    assert.equal(b3ToLabel(0x00), "Input 1");
    assert.equal(b3ToLabel(0x2f), "Input 48");
    assert.equal(b3ToLabel(0x30), "St In 1");
    assert.equal(b3ToLabel(0x37), "DCA 1");
    assert.equal(b3ToLabel(0x40), "FX 1");
    assert.equal(b3ToLabel(0x58), "Mix 1");
    assert.equal(b3ToLabel(0x68), "Main LR");
    assert.equal(b3ToLabel(0x73), "Matrix 1 L");
    assert.equal(b3ToLabel(0x74), "Matrix 1 R");
  });

  it("falls back to a hex label for unknown addresses", () => {
    assert.equal(b3ToLabel(0x50), "b3 0x50");
  });
});

describe("labelToB3", () => {
  it("round-trips every label produced by b3ToLabel", () => {
    for (let b3 = 0; b3 <= 0x7f; b3++) {
      const label = b3ToLabel(b3);
      const back = labelToB3(label);
      // Duplicate labels may resolve to an earlier b3; the mapping must at
      // least be self-consistent for the first b3 carrying that label.
      assert.ok(back !== null, `no b3 for label ${label}`);
      assert.equal(b3ToLabel(back), label);
    }
  });

  it("returns null for an unknown label", () => {
    assert.equal(labelToB3("Nope"), null);
  });
});

describe("RoutingModel.handleDsp — input patch", () => {
  it("decodes a local input patch", () => {
    const m = new RoutingModel();
    assert.equal(m.handleDsp(patchFrame(5, InputPatchSource.Local, 10, 0x20)), true);
    const snap = m.snapshot();
    assert.equal(snap.inputs.length, 1);
    assert.deepEqual(snap.inputs[0], {
      destB3: 10,
      destLabel: "Input 11",
      name: "",
      source: InputPatchSource.Local,
      sourceLabel: "Local",
      sourceChannel: 5,
    });
    assert.equal(snap.updates, 1);
  });

  it("keeps the channel name in sync when it arrives later", () => {
    const m = new RoutingModel();
    m.handleDsp(patchFrame(0, InputPatchSource.USB, 3, 0x20));
    m.setChannelName(3, "Kick");
    assert.equal(m.snapshot().inputs[0].name, "Kick");
  });

  it("sorts inputs by destination b3", () => {
    const m = new RoutingModel();
    m.handleDsp(patchFrame(0, InputPatchSource.Local, 5, 0x20));
    m.handleDsp(patchFrame(1, InputPatchSource.Local, 2, 0x20));
    assert.deepEqual(
      m.snapshot().inputs.map((i) => i.destB3),
      [2, 5]
    );
  });
});

describe("RoutingModel.handleDsp — output patch", () => {
  it("decodes a bus → local output patch", () => {
    const m = new RoutingModel();
    assert.equal(
      m.handleDsp(patchFrame(0x58, 0x0f, 0, OutputPatchDest.Local)),
      true
    );
    const out = m.snapshot().outputs[0];
    assert.equal(out.kind, "bus");
    assert.equal(out.sourceLabel, "Mix 1");
    assert.equal(out.dest, OutputPatchDest.Local);
    assert.equal(out.destLabel, "Local Out");
    assert.equal(out.destChannel, 1);
  });

  it("replaces an existing patch on the same output socket", () => {
    const m = new RoutingModel();
    m.handleDsp(patchFrame(0x58, 0x0f, 2, OutputPatchDest.Local));
    m.handleDsp(patchFrame(0x59, 0x0f, 2, OutputPatchDest.Local));
    const outputs = m.snapshot().outputs;
    assert.equal(outputs.length, 1);
    assert.equal(outputs[0].sourceLabel, "Mix 2");
  });

  it("keeps patches on different output sockets", () => {
    const m = new RoutingModel();
    m.handleDsp(patchFrame(0x58, 0x0f, 0, OutputPatchDest.Local));
    m.handleDsp(patchFrame(0x58, 0x0f, 1, OutputPatchDest.Local));
    assert.equal(m.snapshot().outputs.length, 2);
  });

  it("decodes a linked pair's right half (modifier 0x10) from the master b3", () => {
    const m = new RoutingModel();
    // Captured from a real SQ-5: linked pair master b3 0x1a → Local Out 1 (L,
    // modifier 0x0f) and Local Out 2 (R, modifier 0x10); both carry the master.
    m.handleDsp(patchFrame(0x1a, 0x0f, 0, OutputPatchDest.Local));
    m.handleDsp(patchFrame(0x1a, 0x10, 1, OutputPatchDest.Local));
    const outputs = m.snapshot().outputs.sort((a, b) => a.destChannel - b.destChannel);
    assert.equal(outputs.length, 2);
    assert.equal(outputs[0].sourceLabel, outputs[1].sourceLabel);
    assert.equal(outputs[0].rightHalf ?? false, false);
    assert.equal(outputs[1].rightHalf, true);
    assert.equal(outputs[1].destChannel, 2);
  });
});

describe("RoutingModel.handleDsp — FX and monitor patches", () => {
  it("decodes FX return L/R output patches", () => {
    const m = new RoutingModel();
    m.handleDsp(patchFrame(0, 0x16, 0, OutputPatchDest.USB));
    m.handleDsp(patchFrame(0, 0x17, 1, OutputPatchDest.USB));
    const labels = m.snapshot().outputs.map((o) => o.sourceLabel).sort();
    assert.deepEqual(labels, ["FX1 L", "FX1 R"]);
  });

  it("decodes a monitor output patch", () => {
    const m = new RoutingModel();
    m.handleDsp(patchFrame(MonitorOutSource.PaflL, 0x11, 0, OutputPatchDest.SLink));
    const out = m.snapshot().outputs[0];
    assert.equal(out.kind, "monitor");
    assert.equal(out.sourceLabel, "PAFL L");
  });
});

describe("RoutingModel.handleDsp — non-patch frames", () => {
  it("ignores a different category/register", () => {
    const m = new RoutingModel();
    const other = { ...patchFrame(0, 1, 1, 1), category: 0x0c as number };
    assert.equal(m.handleDsp(other), false);
  });

  it("ignores an unknown modifier", () => {
    const m = new RoutingModel();
    assert.equal(m.handleDsp(patchFrame(0, 0x05, 0, 0)), false);
  });

  it("ignores synthesised frames with an empty raw payload", () => {
    const m = new RoutingModel();
    assert.equal(
      m.handleDsp({ ch: 0, category: 0x0b, register: 0x0d, modifier: 1, value: 0, raw: Buffer.alloc(0) }),
      false
    );
  });
});

describe("RoutingModel — names, stereo pairs and reset", () => {
  it("exposes mix / FX / matrix names in bus order", () => {
    const m = new RoutingModel();
    m.setChannelName(0x58, "Drums");
    m.setChannelName(0x40, "Hall");
    m.setChannelName(0x73, "MTX A");
    const snap = m.snapshot();
    assert.equal(snap.mixNames[0], "Drums");
    assert.equal(snap.fxNames[0], "Hall");
    assert.equal(snap.matrixNames[0], "MTX A");
    assert.equal(snap.mixNames.length, 12);
    assert.equal(snap.fxNames.length, 4);
    assert.equal(snap.matrixNames.length, 6);
  });

  it("filters stereo pairs to contiguous even/odd addresses", () => {
    const m = new RoutingModel();
    m.stereoPairs = [
      [0, 1],
      [1, 2],
      [2, 4],
      [4, 5],
    ];
    assert.deepEqual(m.stereoPairs, [
      [0, 1],
      [4, 5],
    ]);
  });

  it("resets all model state", () => {
    const m = new RoutingModel();
    m.handleDsp(patchFrame(0, InputPatchSource.Local, 0, 0x20));
    m.setChannelName(0, "Kick");
    m.stereoPairs = [[0, 1]];
    m.reset();
    const snap = m.snapshot();
    assert.deepEqual(snap.inputs, []);
    assert.deepEqual(snap.outputs, []);
    assert.deepEqual(snap.stereoPairs, []);
    assert.equal(snap.updates, 0);
    assert.equal(snap.routingBlockBytes, null);
  });
});
