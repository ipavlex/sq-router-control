/**
 * Unit tests for the REAPER track-template generator: record inputs, disabled
 * master send and hardware outputs mirroring the record input.
 */
import { describe, it } from "node:test";
import assert from "node:assert/strict";
import {
  buildReaperTracks,
  buildReaperTrackTemplate,
  USB_DEST,
} from "../reaper-template";
import type { SnapshotOutput, SnapshotPayload } from "../ipc";

function out(destChannel: number, sourceLabel: string): SnapshotOutput {
  return { kind: "usb", sourceLabel, dest: USB_DEST, destLabel: `USB ${destChannel}`, destChannel };
}

function snap(outputs: SnapshotOutput[], stereoPairs: number[][] = []): SnapshotPayload {
  return {
    inputs: [],
    outputs,
    stereoPairs,
    updates: 0,
    routingBlockBytes: null,
  };
}

describe("buildReaperTracks", () => {
  it("keeps only USB-assigned channels sorted by USB channel", () => {
    const tracks = buildReaperTracks(
      snap([out(3, "Input 3"), out(1, "Input 1"), out(2, "Mix 1")])
    );
    assert.deepEqual(
      tracks.map((t) => [t.name, t.input, t.channels]),
      [
        ["Input 1", 0, 1],
        ["Mix 1", 1, 1],
        ["Input 3", 2, 1],
      ]
    );
  });

  it("merges a declared input stereo pair into one stereo track", () => {
    const tracks = buildReaperTracks(
      snap([out(1, "Input 1"), out(2, "Input 2")], [[0, 1]])
    );
    assert.deepEqual(tracks, [
      { name: "Input 1-2", input: 0, channels: 2, output: 0, outputStereo: true },
    ]);
  });
});

describe("buildReaperTrackTemplate routing", () => {
  it("disables the master send on every track", () => {
    const tpl = buildReaperTrackTemplate(buildReaperTracks(snap([out(1, "Input 1")])));
    assert.match(tpl, /MAINSEND 0 0/);
    assert.doesNotMatch(tpl, /MAINSEND 1 /);
  });

  it("mono track: HWOUT mirrors the record input (mono output n+1)", () => {
    // USB channel 4 → 0-based input 3 → mono HWOUT dest 1024+3, src mono ch 1.
    const tpl = buildReaperTrackTemplate(buildReaperTracks(snap([out(4, "Input 4")])));
    assert.match(tpl, /REC 1 3 1 /);
    assert.match(tpl, /HWOUT 1027 0 1 0 0 0 1024 -1:U -1/);
  });

  it("stereo track on an odd 1-based pair start: single stereo HWOUT", () => {
    // USB 1/2 → 0-based start 0 (1-based 1, odd) → stereo dest 0, stereo source.
    const tracks = buildReaperTracks(snap([out(1, "Input 1"), out(2, "Input 2")], [[0, 1]]));
    const tpl = buildReaperTrackTemplate(tracks);
    assert.match(tpl, /REC 1 1024 1 /);
    assert.match(tpl, /HWOUT 0 0 1 0 0 0 0 -1:U -1/);
  });

  it("stereo track on an even 1-based pair start: first free odd-even pair", () => {
    // USB 2/3 → 0-based start 1 (1-based 2, even) → no matching stereo
    // destination; the first free pair (USB 1/2, 0-based 0) is used instead.
    const tracks = buildReaperTracks(snap([out(2, "Input 2"), out(3, "Input 3")], [[1, 2]]));
    const tpl = buildReaperTrackTemplate(tracks);
    assert.match(tpl, /REC 1 1025 1 /);
    assert.match(tpl, /HWOUT 0 0 1 0 0 0 0 -1:U -1/);
  });

  it("fallback pair skips channels already used as outputs", () => {
    // Mono track on USB 1 occupies output channel 1 (0-based 0), so the
    // stereo track recording USB 2/3 gets the next free pair (USB 3/4).
    const outputs = [out(1, "Input 1"), out(2, "Input 2"), out(3, "Input 3")];
    const tracks = buildReaperTracks(snap(outputs, [[1, 2]]));
    assert.deepEqual(
      tracks.map((t) => [t.channels, t.output, t.outputStereo]),
      [
        [1, 0, false],
        [2, 2, true],
      ]
    );
    const tpl = buildReaperTrackTemplate(tracks);
    assert.match(tpl, /HWOUT 1024 0 1 0 0 0 1024 -1:U -1/); // mono → USB 1
    assert.match(tpl, /HWOUT 2 0 1 0 0 0 0 -1:U -1/); // stereo → USB 3/4
  });

  it("misaligned stereo pairs get successive free pairs", () => {
    // Mono on USB 1 occupies output channel 1; each misaligned pair
    // (USB 2/3, 4/5, 6/7) takes the next free odd-even pair.
    const outputs = [
      out(1, "Input 1"),
      out(2, "Input 2"), out(3, "Input 3"),
      out(4, "Input 4"), out(5, "Input 5"),
      out(6, "Input 6"), out(7, "Input 7"),
    ];
    const tracks = buildReaperTracks(snap(outputs, [[1, 2], [3, 4], [5, 6]]));
    assert.deepEqual(
      tracks.map((t) => [t.channels, t.output, t.outputStereo]),
      [
        [1, 0, false],
        [2, 2, true],
        [2, 4, true],
        [2, 6, true],
      ]
    );
  });

  it("relocates one mono output when no odd-even pair is free", () => {
    // Monos on USB 1 and USB 4; aligned stereos fill USB 5/6 … 31/32 — every
    // pair is occupied. The misaligned stereo on USB 2/3 frees pair 1/2 by
    // moving the mono on USB 1 to the nearest free channel outside the pair
    // (USB 3) and takes USB 1/2 for its output.
    const outputs: SnapshotOutput[] = [
      out(1, "Input 1"),
      out(2, "Input 2"), out(3, "Input 3"),
      out(4, "Input 4"),
    ];
    const pairs: number[][] = [[1, 2]];
    for (let ch = 5; ch <= 31; ch += 2) {
      outputs.push(out(ch, `Input ${ch}`), out(ch + 1, `Input ${ch + 1}`));
      pairs.push([ch - 1, ch]);
    }
    const tracks = buildReaperTracks(snap(outputs, pairs));
    const moved = tracks.find((t) => t.name === "Input 1");
    const misaligned = tracks.find((t) => t.name === "Input 2-3");
    assert.ok(moved && misaligned);
    assert.equal(moved.output, 2); // USB 1 → USB 3
    assert.deepEqual(misaligned, {
      name: "Input 2-3",
      input: 1,
      channels: 2,
      output: 0,
      outputStereo: true,
    });
  });

  it("prefers relocating fewer mono outputs over a smaller total distance", () => {
    // Monos on USB 1, 2, 3 and 6; aligned stereos fill USB 7/8 … 31/32 —
    // every pair is occupied. For the misaligned stereo on USB 4/5: pair 1/2
    // needs two monos moved (total distance 6), while pair 3/4 needs one
    // (distance 2) — the single-move option wins.
    const outputs: SnapshotOutput[] = [
      out(1, "Input 1"), out(2, "Input 2"), out(3, "Input 3"),
      out(4, "Input 4"), out(5, "Input 5"),
      out(6, "Input 6"),
    ];
    const pairs: number[][] = [[3, 4]];
    for (let ch = 7; ch <= 31; ch += 2) {
      outputs.push(out(ch, `Input ${ch}`), out(ch + 1, `Input ${ch + 1}`));
      pairs.push([ch - 1, ch]);
    }
    const tracks = buildReaperTracks(snap(outputs, pairs));
    const byName = new Map(tracks.map((t) => [t.name, t]));
    assert.equal(byName.get("Input 1")?.output, 0); // untouched
    assert.equal(byName.get("Input 2")?.output, 1); // untouched
    assert.equal(byName.get("Input 3")?.output, 4); // USB 3 → USB 5
    assert.equal(byName.get("Input 6")?.output, 5); // untouched
    assert.equal(byName.get("Input 4-5")?.output, 2); // output pair USB 3/4
  });
});
