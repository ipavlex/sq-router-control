/**
 * SQ Router Control — Routing tab types.
 * Editable input-patching rows, stereo merge results, and the
 * save/load routing entry shapes.
 */
import type { SnapshotInput } from "../../../shared/ipc";

/** One row of the editable Input Patching table. */
export interface EditRow {
  destB3: number;
  destLabel: string;
  name: string;
  source: number;
  sourceChannel: number;
  /** Whether the row is selected for the next Upload. */
  checked?: boolean;
}

/** Anything mergeStereoInputs can consume: live snapshots or edit-table rows. */
export type PatchInput = SnapshotInput | EditRow;

/** A merged stereo row: left channel carrying the right channel's info. */
export interface MergedInput extends SnapshotInput {
  _stereo?: boolean;
  _rightSourceChannel?: number;
}

/** Serialized snapshot of the edit table: { inputs, stereoPairs }. */
export interface SavedSet {
  inputs: EditRow[];
  stereoPairs: number[][];
}

/** A named, timestamped routing entry in the save/load list. */
export interface SavedRoutingEntry extends SavedSet {
  name: string;
  savedAt: string;
  model?: string;
}