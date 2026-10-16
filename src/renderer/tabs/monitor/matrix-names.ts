/**
 * Matrix button specs for the Monitor tab.
 *
 * The console stores six matrix buses at b3 0x73–0x78. The confirmed pair
 * layout (ParamData header @93, verified by controlled dumps — see
 * SQ-PROTOCOL.md §8.5) is CROSS-paired, not adjacent:
 *
 *   pair 1 = 0x73 + 0x76, pair 2 = 0x74 + 0x77, pair 3 = 0x75 + 0x78
 *
 * i.e. the L buses are 0x73–0x75 and the R buses are 0x76–0x78. A ganged
 * (stereo) matrix occupies both buses of its pair — the name lives on the L
 * slot. Breaking a stereo matrix to mono frees the R bus, which shows up as
 * an additional mono matrix (3 stereo → 6 mono in the console menu).
 *
 * `matrixButtonSpecs` turns the slot names plus the ganged-pair list into
 * button descriptors in slot order:
 *   - a ganged pair  → one stereo button (L slot → L out, R slot → R out);
 *   - any other slot → one mono button (slot → both L/R outs).
 *
 * The button count therefore varies between 3 (all stereo) and 6 (all mono).
 * The earlier name-collapsing heuristic (`matrixButtonLabels`) is superseded:
 * with the pairs known, each button takes the name of its own L slot (or the
 * R slot as a fallback for a ganged pair whose L slot is unnamed).
 */

/** Matrix buses occupy b3 0x73–0x78 (six slots). */
export const MATRIX_BASE_B3 = 0x73;
export const MATRIX_SLOT_COUNT = 6;

/** One matrix button: a stereo pair (b3R set) or a mono bus (b3R null). */
export interface MatrixButtonSpec {
  /** L slot b3 — the only bus for a mono matrix. */
  b3L: number;
  /** R slot b3 for a stereo matrix; null for a mono matrix. */
  b3R: number | null;
  /** Console name (L slot, falling back to the R slot of a ganged pair). */
  name: string;
}

/**
 * Build matrix button descriptors from slot names (index 0 = b3 0x73) and
 * the ganged pairs from the snapshot (b3 addresses, e.g. [[0x73, 0x76]]).
 */
export function matrixButtonSpecs(
  names: string[],
  pairs: number[][]
): MatrixButtonSpec[] {
  const gangedR = new Set(pairs.map((p) => p[1]));
  const specs: MatrixButtonSpec[] = [];
  for (let slot = 0; slot < MATRIX_SLOT_COUNT; slot++) {
    const b3 = MATRIX_BASE_B3 + slot;
    // R side of a ganged pair — already covered by its L partner.
    if (gangedR.has(b3)) continue;
    const pair = pairs.find((p) => p[0] === b3);
    const name = names[slot] || (pair ? names[pair[1] - MATRIX_BASE_B3] || "" : "");
    specs.push({ b3L: b3, b3R: pair ? pair[1] : null, name });
  }
  // Only configured matrices get buttons: a slot is shown when it carries a
  // console name or is part of a ganged (stereo) pair — unnamed free slots
  // are unused matrices. Fallback: with no names and no pairs at all (the
  // blob header has not been decoded yet), keep the full six-slot layout so
  // the buttons don't disappear before the first snapshot arrives.
  const configured = specs.filter((s) => s.name !== "" || s.b3R !== null);
  return configured.length > 0 || pairs.length > 0 ? configured : specs;
}
