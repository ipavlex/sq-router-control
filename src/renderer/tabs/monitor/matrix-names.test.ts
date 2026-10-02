/**
 * Unit tests for the Monitor tab matrix-button labels (MON-B6).
 */
import { describe, it } from "node:test";
import assert from "node:assert/strict";
import { matrixButtonLabels } from "./matrix-names";

describe("matrixButtonLabels", () => {
  it("keeps consecutively named mono slots without skipping", () => {
    assert.deepEqual(
      matrixButtonLabels(["MainPA", "FrntFl", "YouTMx", "", "", ""]),
      ["MainPA", "FrntFl", "YouTMx"]
    );
  });

  it("collapses a stereo pair named on both slots to one label", () => {
    assert.deepEqual(
      matrixButtonLabels(["A", "A", "B", "B", "C", "C"]),
      ["A", "B", "C"]
    );
  });

  it("keeps stereo names stored on the first slot only", () => {
    assert.deepEqual(
      matrixButtonLabels(["A", "", "B", "", "C", ""]),
      ["A", "B", "C"]
    );
  });

  it("returns no labels when no slot is named", () => {
    assert.deepEqual(matrixButtonLabels(["", "", "", "", "", ""]), []);
  });
});
