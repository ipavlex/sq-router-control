/**
 * Matrix button labels for the Monitor tab.
 *
 * The console stores one name per matrix slot (b3 0x73–0x78, six slots). The
 * Monitor tab exposes three matrix buttons, each routing one slot pair. A
 * console may name the slots:
 *   - consecutively (three mono matrices), e.g. MainPA, FrntFl, YouTMx;
 *   - on both slots of a stereo pair (same name), e.g. A, A, B, B, C, C;
 *   - on the first slot of each stereo pair only, e.g. A, "", B, "", C, "".
 *
 * Reading `names[i * 2]` (every other, L slot) dropped any name stored on the
 * odd ("R") slot — MON-B6. Collapsing empty slots and repeated adjacent names
 * keeps all three layouts intact and hands the labels out in button order:
 *   - [A, A, B, B, C, C]       → A, B, C
 *   - [A, "", B, "", C, ""]    → A, B, C
 *   - [A, B, C, "", "", ""]    → A, B, C
 *
 * Mono/stereo mode itself is not decodable from ParamData yet (MON-B5); this
 * is a display-only ordering and does not change which slots a button routes.
 */
export function matrixButtonLabels(names: string[]): string[] {
  const labels: string[] = [];
  for (const name of names) {
    if (!name) continue;
    if (labels.length > 0 && labels[labels.length - 1] === name) continue;
    labels.push(name);
  }
  return labels;
}
