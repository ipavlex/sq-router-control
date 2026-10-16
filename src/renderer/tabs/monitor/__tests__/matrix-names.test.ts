/**
 * Unit tests for the Monitor tab matrix-button specs (MON-B5/B6).
 *
 * The confirmed pair layout (ParamData header @93) is cross-paired:
 * pair 1 = 0x73+0x76, pair 2 = 0x74+0x77, pair 3 = 0x75+0x78 — the L buses
 * are 0x73–0x75, the R buses are 0x76–0x78.
 */
import { describe, it } from "node:test";
import assert from "node:assert/strict";
import { matrixButtonSpecs, MATRIX_BASE_B3 } from "../matrix-names";

describe("matrixButtonSpecs", () => {
  it("builds one stereo button per ganged pair, named from the L slot", () => {
    const specs = matrixButtonSpecs(
      ["A", "B", "C", "A", "B", "C"],
      [
        [0x73, 0x76],
        [0x74, 0x77],
        [0x75, 0x78],
      ]
    );
    assert.equal(specs.length, 3);
    assert.deepEqual(specs[0], { b3L: 0x73, b3R: 0x76, name: "A" });
    assert.deepEqual(specs[1], { b3L: 0x74, b3R: 0x77, name: "B" });
    assert.deepEqual(specs[2], { b3L: 0x75, b3R: 0x78, name: "C" });
  });

  it("shows only named mono buttons when no pair is ganged", () => {
    // Configured-only (v1.23.0): unnamed slots are unused matrices and get
    // no buttons while at least one slot is configured.
    const specs = matrixButtonSpecs(["MainPA", "FrntFl", "YouTMx", "", "", ""], []);
    assert.equal(specs.length, 3);
    assert.deepEqual(specs[0], { b3L: 0x73, b3R: null, name: "MainPA" });
    assert.deepEqual(specs[1], { b3L: 0x74, b3R: null, name: "FrntFl" });
    assert.deepEqual(specs[2], { b3L: 0x75, b3R: null, name: "YouTMx" });
  });

  it("mixes stereo pairs and freed mono slots in slot order", () => {
    // Pair 1 ganged; slots 0x74/0x75 split to mono; pair 3 ganged.
    const specs = matrixButtonSpecs(
      ["Subs", "Lobby", "Fill", "Subs", "", "Feed"],
      [
        [0x73, 0x76],
        [0x77, 0x78],
      ]
    );
    assert.equal(specs.length, 4);
    assert.deepEqual(specs[0], { b3L: 0x73, b3R: 0x76, name: "Subs" });
    assert.deepEqual(specs[1], { b3L: 0x74, b3R: null, name: "Lobby" });
    assert.deepEqual(specs[2], { b3L: 0x75, b3R: null, name: "Fill" });
    assert.deepEqual(specs[3], { b3L: 0x77, b3R: 0x78, name: "Feed" });
  });

  it("falls back to the R-slot name for a ganged pair with an unnamed L slot", () => {
    // The ganged pair is configured and shown with the R-slot name; the
    // five unnamed mono slots are hidden (configured-only).
    const specs = matrixButtonSpecs(["", "", "", "Subs", "", ""], [[0x73, 0x76]]);
    assert.equal(specs.length, 1);
    assert.deepEqual(specs[0], { b3L: 0x73, b3R: 0x76, name: "Subs" });
  });

  it("keeps the R slot of a ganged pair even when it carries its own name", () => {
    // A stale name on the R slot must not produce an extra mono button;
    // the named free slot 0x77 ("Ghost") still gets its mono button.
    const specs = matrixButtonSpecs(["A", "", "", "A", "Ghost", ""], [[0x73, 0x76]]);
    assert.equal(specs.length, 2);
    assert.deepEqual(specs[0], { b3L: 0x73, b3R: 0x76, name: "A" });
    assert.deepEqual(specs[1], { b3L: 0x77, b3R: null, name: "Ghost" });
    assert.equal(specs.some((s) => s.b3L === 0x76), false);
  });

  it("covers all six slots starting at b3 0x73", () => {
    const specs = matrixButtonSpecs(["", "", "", "", "", ""], []);
    assert.equal(specs.length, 6);
    assert.equal(specs[5].b3L, MATRIX_BASE_B3 + 5);
  });
});
