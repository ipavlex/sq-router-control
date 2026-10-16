/**
 * SQ Router Control — Meters tab.
 *
 * A metering overview of every console channel: a sub-tab block (Inputs /
 * Mix / FX / USB) over a grid of cells. Each cell shows a graphical level
 * bar (no numeric readout), a gate indicator, a compressor indicator and a
 * mute badge — all read-only.
 *
 * Data sources:
 * - level bars: the live UDP meter stream (`sq:meters`, MetersPayload) —
 *   inputs from packets 0x06/0x17, mixes + Main LR + FX sends from 0x18;
 * - mute / gate-on / comp-on: `state.channelStates` (ParamData + live DSP
 *   frames), keyed by b3;
 * - names: the last routing snapshot (channel / mix / group / FX names).
 *
 * Scaffolded (no wire data yet — see docs/BACKLOG-NO-CONSOLE.md group B):
 * - gate / compressor *activity* (срабатывание): the flag slot is reserved
 *   and lights on processor on/off; the dynamic activity indication is
 *   wired after the meter packets are reverse-engineered on a real console;
 * - FX return levels, group levels, USB meters: cells render with an empty
 *   bar and the sub-tab note explains what is missing.
 *
 * Meter updates follow the shared coalescing pattern: incoming payloads are
 * stored in `pendingMeters` and applied once per animation frame — no DOM
 * work inside the meter-packet stream.
 */
import { elementRefs, state } from "../../core/utils";
import { dbToPercent, meterClassName } from "../../core/meters";
import { matrixButtonSpecs, MATRIX_BASE_B3 } from "../monitor/matrix-names";
import type { MetersPayload, SnapshotPayload } from "../../../shared/ipc";

/** Sub-tab ids, matching the data-sub attributes in view.html. */
type SubTab = "inputs" | "mix" | "fx" | "usb";

const SUBTABS: SubTab[] = ["inputs", "mix", "fx", "usb"];

/** b3 of the first FX return channel. */
const FX_RETURN_B3 = 0x40;
/** b3 of the first mix bus. */
const MIX_B3 = 0x58;
/** b3 of Main LR. */
const MAIN_LR_B3 = 0x68;
/** b3 of the first group bus. */
const GROUP_B3 = 0x48;
/** Input channel count of the meter stream. */
const INPUT_CHANNELS = 48;

let activeSub: SubTab = "inputs";
let lastSnapshot: SnapshotPayload | null = null;

// ── cell DOM ────────────────────────────────────────────────────────

/** One vertical level bar (same structure as the monitor tab meters). */
function buildBar(): HTMLElement {
  const meter = document.createElement("span");
  meter.className = "ch-meter";
  const fill = document.createElement("span");
  fill.className = "ch-meter-fill";
  meter.appendChild(fill);
  const clip = document.createElement("span");
  clip.className = "ch-meter-clip";
  meter.appendChild(clip);
  return meter;
}

/**
 * One status flag: "G" (gate), "C" (compressor) or "M" (mute).
 * `applicable=false` renders the dimmed n/a look (channel type has no such
 * processor — e.g. mixes have no gate/comp).
 */
function buildFlag(kind: "gate" | "comp" | "mute", applicable: boolean): HTMLElement {
  const flag = document.createElement("span");
  const label = kind === "gate" ? "G" : kind === "comp" ? "C" : "M";
  flag.className = `m-flag m-${kind}${applicable ? "" : " na"}`;
  flag.textContent = label;
  if (!applicable) flag.title = "Нет на этом типе канала";
  return flag;
}

/**
 * One meter cell: header on top (optional number line over the name),
 * bar(s) + flag row below.
 */
function buildCell(
  name: string,
  bars: number,
  flags: HTMLElement[],
  num?: string
): HTMLElement {
  const cell = document.createElement("div");
  cell.className = "m-cell";
  if (num !== undefined) {
    const numEl = document.createElement("div");
    numEl.className = "m-cell-num";
    numEl.textContent = num;
    cell.appendChild(numEl);
  }
  const label = document.createElement("div");
  label.className = "m-cell-name";
  label.textContent = name;
  label.title = name;
  cell.appendChild(label);
  const body = document.createElement("div");
  body.className = "m-cell-body";
  // Bars sit together in their own container so a stereo pair renders as
  // adjacent L | R strips, centered in the space left of the flag column.
  const barRow = document.createElement("div");
  barRow.className = "m-bars";
  for (let i = 0; i < bars; i++) barRow.appendChild(buildBar());
  body.appendChild(barRow);
  const flagRow = document.createElement("div");
  flagRow.className = "m-cell-flags";
  for (const f of flags) flagRow.appendChild(f);
  body.appendChild(flagRow);
  cell.appendChild(body);
  return cell;
}

// ── grid builders per sub-tab ───────────────────────────────────────

/** Channel display names by b3, from the last snapshot's active patching. */
function inputNames(): Map<number, string> {
  const map = new Map<number, string>();
  for (const inp of lastSnapshot?.inputs ?? []) map.set(inp.destB3, inp.name);
  return map;
}

/**
 * Build the Inputs grid: all 48 input channels (b3 0x00–0x2F) with
 * console-reported stereo pairs merged into one cell (two L/R bars,
 * name + number of the left channel).
 */
function buildInputs(grid: HTMLElement): void {
  const names = inputNames();
  // Right halves of stereo pairs — covered by their merged left cell.
  const rightOfPair = new Set(state.stereoPairs.map(([l, r]) => r));
  for (let i = 0; i < INPUT_CHANNELS; i++) {
    if (rightOfPair.has(i)) continue;
    const pair = state.stereoPairs.find(([l]) => l === i);
    const r = pair ? pair[1] : null;
    const name = names.get(i) || `Ch ${i + 1}`;
    const cell = buildCell(
      name,
      r !== null ? 2 : 1,
      [
        buildFlag("gate", true),
        buildFlag("comp", true),
        buildFlag("mute", true),
      ],
      r !== null ? `${i + 1}-${r + 1}` : String(i + 1)
    );
    cell.classList.add("m-input");
    cell.dataset.b3 = String(i);
    if (r !== null) cell.dataset.b3r = String(r);
    grid.appendChild(cell);
  }
}

/** A full-row section header inside the cell grid ("Aux", "Group", …). */
function buildSection(grid: HTMLElement, title: string): void {
  const head = document.createElement("div");
  head.className = "m-section";
  head.textContent = title;
  grid.appendChild(head);
}

/**
 * Build the Mix grid in labeled sections — Aux, Group, Mtx, Master —
 * mirroring the bus composition of the console (snapshot @61/@65, see
 * SQ-PROTOCOL.md §8.5):
 * - Aux: the first `auxCount` slots of the 12-slot mix pool (b3 0x58+i),
 *   live meters from packet 0x18 (stereo mixes get L/R bars);
 * - Group: the separate group buses b3 0x48+ (count = groupCount) — no
 *   meter data in the decoded packets, scaffold bars;
 * - Mtx: matrix slots b3 0x73–0x78 (pair-aware via matrixButtonSpecs) —
 *   no meter data either, scaffold bars;
 * - Master: Main LR, live meters.
 */
function buildMix(grid: HTMLElement): void {
  const mixNames = lastSnapshot?.mixNames ?? [];
  const groupNames = lastSnapshot?.groupNames ?? [];

  buildSection(grid, "Aux");
  const auxCount = state.auxCount ?? 12;
  for (let i = 0; i < auxCount; i++) {
    const b3 = MIX_B3 + i;
    const stereo = state.mixStereoPairs.some(([a, b]) => a === i || b === i);
    const name = mixNames[i] || `Mix ${i + 1}`;
    const cell = buildCell(name, stereo ? 2 : 1, [
      buildFlag("gate", false),
      buildFlag("comp", false),
      buildFlag("mute", true),
    ]);
    cell.dataset.b3 = String(b3);
    cell.dataset.mixIdx = String(i);
    grid.appendChild(cell);
  }

  buildSection(grid, "Group");
  const groupCount = state.groupCount ?? 4;
  for (let i = 0; i < groupCount; i++) {
    const b3 = GROUP_B3 + i;
    const name = groupNames[i] || `Group ${i + 1}`;
    const cell = buildCell(name, 1, [
      buildFlag("gate", false),
      buildFlag("comp", false),
      buildFlag("mute", true),
    ]);
    cell.dataset.b3 = String(b3);
    cell.classList.add("m-scaffold");
    grid.appendChild(cell);
  }

  // Last Mix row: Master (Main LR) on the left with its own caption, the
  // matrices to its right at a small distance — one strip, captions on top.
  const lastRow = document.createElement("div");
  lastRow.className = "m-lastrow";

  const masterGroup = document.createElement("div");
  masterGroup.className = "m-group";
  const masterHead = document.createElement("div");
  masterHead.className = "m-section";
  masterHead.textContent = "Master";
  const masterCells = document.createElement("div");
  masterCells.className = "m-group-cells";
  const lr = buildCell("Main LR", 2, [
    buildFlag("gate", false),
    buildFlag("comp", false),
    buildFlag("mute", true),
  ]);
  lr.dataset.b3 = String(MAIN_LR_B3);
  lr.classList.add("m-mainlr");
  masterCells.appendChild(lr);
  masterGroup.append(masterHead, masterCells);
  lastRow.appendChild(masterGroup);

  const mtxGroup = document.createElement("div");
  mtxGroup.className = "m-group";
  const mtxHead = document.createElement("div");
  mtxHead.className = "m-section";
  mtxHead.textContent = "Mtx";
  const mtxCells = document.createElement("div");
  mtxCells.className = "m-group-cells";
  const specs = matrixButtonSpecs(
    lastSnapshot?.matrixNames ?? [],
    lastSnapshot?.matrixStereoPairs ?? []
  );
  for (const spec of specs) {
    const name = spec.name || `Mtx ${spec.b3L - MATRIX_BASE_B3 + 1}`;
    const cell = buildCell(name, spec.b3R !== null ? 2 : 1, [
      buildFlag("gate", false),
      buildFlag("comp", false),
      buildFlag("mute", true),
    ]);
    cell.dataset.b3 = String(spec.b3L);
    cell.classList.add("m-scaffold");
    mtxCells.appendChild(cell);
  }
  mtxGroup.append(mtxHead, mtxCells);
  lastRow.appendChild(mtxGroup);

  grid.appendChild(lastRow);
}

/** Build the FX grid: FX send 1–4 (buses) + FX return 1–4 (channels). */
function buildFx(grid: HTMLElement): void {
  const fxNames = lastSnapshot?.fxNames ?? [];
  // FX send 1-4: buses of packet 0x18 (slots 36-39). No mute/gate/comp —
  // sends are bus taps, not channels.
  for (let i = 0; i < 4; i++) {
    const cell = buildCell(`FX send ${i + 1}`, 1, [
      buildFlag("gate", false),
      buildFlag("comp", false),
      buildFlag("mute", false),
    ]);
    cell.dataset.fxSend = String(i);
    grid.appendChild(cell);
  }
  // FX return 1-4 (b3 0x40-0x43): channels with mute; levels not decoded
  // yet — the bar stays empty (scaffold).
  for (let i = 0; i < 4; i++) {
    const b3 = FX_RETURN_B3 + i;
    const name = fxNames[i] || `FX ${i + 1}`;
    const cell = buildCell(`${name} (return)`, 1, [
      buildFlag("gate", false),
      buildFlag("comp", false),
      buildFlag("mute", true),
    ]);
    cell.dataset.b3 = String(b3);
    cell.classList.add("m-scaffold");
    grid.appendChild(cell);
  }
}

/** Build the USB grid: scaffold only — no meter data decoded yet. */
function buildUsb(grid: HTMLElement): void {
  const empty = document.createElement("div");
  empty.className = "m-empty";
  empty.textContent = "Нет данных: USB-метры не декодированы (нужен пульт)";
  grid.appendChild(empty);
}

/** (Re)build the grid for the active sub-tab and re-apply the last meters. */
function rebuild(): void {
  const grid = elementRefs.metersGrid;
  grid.innerHTML = "";
  if (activeSub === "inputs") buildInputs(grid);
  else if (activeSub === "mix") buildMix(grid);
  else if (activeSub === "fx") buildFx(grid);
  else buildUsb(grid);
  applyMeters(lastMeters);
}

// ── meters application (coalesced per animation frame) ──────────────

let pendingMeters: MetersPayload | null = null;
let meterFrame: number | null = null;
/** Latest applied payload — re-applied when the grid is rebuilt. */
let lastMeters: MetersPayload | null = null;

/** Apply one reading to a single vertical bar (fill height + clip flag). */
function applyBar(
  meter: HTMLElement | null,
  db: number | null,
  isClip: boolean
): void {
  if (!meter) return;
  const fill = meter.querySelector<HTMLElement>(".ch-meter-fill");
  const clip = meter.querySelector<HTMLElement>(".ch-meter-clip");
  if (!fill || !clip) return;
  fill.style.height = `${dbToPercent(db)}%`;
  fill.className = `ch-meter-fill${meterClassName(db)}`;
  clip.classList.toggle("on", isClip);
}

/** Refresh the G / C / M flags of one cell from the channel-state model. */
function applyFlags(cell: HTMLElement): void {
  const b3 = cell.dataset.b3 !== undefined ? Number(cell.dataset.b3) : null;
  const st = b3 !== null ? state.channelStates.get(b3) : undefined;
  const gate = cell.querySelector<HTMLElement>(".m-gate");
  const comp = cell.querySelector<HTMLElement>(".m-comp");
  const mute = cell.querySelector<HTMLElement>(".m-mute");
  if (gate && !gate.classList.contains("na")) {
    const on = !!st?.gateOn;
    gate.classList.toggle("on", on);
    gate.title = `Гейт: ${on ? "вкл" : "выкл"} (срабатывание — после реверса метро-пакетов)`;
  }
  if (comp && !comp.classList.contains("na")) {
    const on = !!st?.compOn;
    comp.classList.toggle("on", on);
    comp.title = `Компрессор: ${on ? "вкл" : "выкл"} (срабатывание — после реверса метро-пакетов)`;
  }
  if (mute && !mute.classList.contains("na")) {
    const on = !!st?.muted;
    mute.classList.toggle("on", on);
    mute.title = on ? "Mute: включён" : "Mute: выключен";
  }
}

/** Apply a meters payload to the active grid, coalesced per frame. */
function applyMeters(m: MetersPayload | null): void {
  lastMeters = m;
  const grid = elementRefs.metersGrid;
  for (const cell of grid.querySelectorAll<HTMLElement>(".m-cell")) {
    const bars = cell.querySelectorAll<HTMLElement>(".ch-meter");
    // Inputs: one bar per channel, two bars for a merged stereo pair
    // (b3 = left channel, b3r = right).
    if (cell.dataset.b3 !== undefined && activeSub === "inputs") {
      const b3 = Number(cell.dataset.b3);
      const b3r = cell.dataset.b3r !== undefined ? Number(cell.dataset.b3r) : null;
      applyBar(bars[0] ?? null, m ? m.inputs[b3] ?? null : null, m ? !!m.clip[b3] : false);
      if (b3r !== null) {
        applyBar(bars[1] ?? null, m ? m.inputs[b3r] ?? null : null, m ? !!m.clip[b3r] : false);
      }
    }
    // Mix buses: stereo → L/R bars, mono → single bar. Groups (scaffold)
    // have no meter slots in the payload — bars stay empty.
    if (cell.dataset.mixIdx !== undefined) {
      const mixIdx = Number(cell.dataset.mixIdx);
      if (bars.length >= 2) {
        applyBar(bars[0], m?.mixesL?.[mixIdx] ?? null, !!m?.mixClipL?.[mixIdx]);
        applyBar(bars[1], m?.mixesR?.[mixIdx] ?? null, !!m?.mixClipR?.[mixIdx]);
      } else {
        applyBar(bars[0] ?? null, m?.mixes?.[mixIdx] ?? null, !!m?.mixClip?.[mixIdx]);
      }
    }
    if (cell.classList.contains("m-mainlr")) {
      applyBar(bars[0] ?? null, m?.mainLRL ?? m?.mainLR ?? null, !!(m?.mainLRClipL ?? m?.mainLRClip));
      applyBar(bars[1] ?? null, m?.mainLRR ?? m?.mainLR ?? null, !!(m?.mainLRClipR ?? m?.mainLRClip));
    }
    // FX send buses (levels from packet 0x18, buses 36-39).
    if (cell.dataset.fxSend !== undefined) {
      const k = Number(cell.dataset.fxSend);
      applyBar(bars[0] ?? null, m?.fxSends?.[k] ?? null, !!m?.fxSendClip?.[k]);
    }
    applyFlags(cell);
  }
}

/**
 * Receive a meters payload from the UDP stream. Coalesces per animation
 * frame (same pattern as the routing / monitor tabs) — no DOM work inside
 * the meter-packet stream.
 */
export function updateMeters(p: MetersPayload | null): void {
  pendingMeters = p;
  if (meterFrame !== null) return;
  meterFrame = requestAnimationFrame(() => {
    meterFrame = null;
    const m = pendingMeters;
    pendingMeters = null;
    applyMeters(m);
  });
}

/** Clear all meters (disconnect / fresh session). */
export function clearMeters(): void {
  lastMeters = null;
  updateMeters(null);
}

// ── snapshot intake ─────────────────────────────────────────────────

/**
 * Consume a routing snapshot: names, stereo pairs and channel states feed
 * the cell grid. Rebuilds the active sub-tab (names/pairs may have changed)
 * and re-applies the last meters payload.
 */
export function onRoutingSnapshot(snapshot: SnapshotPayload): void {
  lastSnapshot = snapshot;
  state.mixStereoPairs = snapshot.mixStereoPairs ?? [];
  rebuild();
}

/** Reset the tab (fresh session): drop snapshot/meters state. */
export function reset(): void {
  lastSnapshot = null;
  lastMeters = null;
  activeSub = "inputs";
  for (const btn of elementRefs.metersSubtabs.querySelectorAll<HTMLButtonElement>(".meters-subtab")) {
    const on = btn.dataset.sub === "inputs";
    btn.classList.toggle("active", on);
    btn.setAttribute("aria-selected", String(on));
  }
  rebuild();
}

// ── sub-tab switching ───────────────────────────────────────────────

elementRefs.metersSubtabs.addEventListener("click", (ev: MouseEvent) => {
  const btn = (ev.target as HTMLElement).closest<HTMLButtonElement>(".meters-subtab");
  if (!btn) return;
  const sub = btn.dataset.sub as SubTab | undefined;
  if (!sub || !SUBTABS.includes(sub) || sub === activeSub) return;
  activeSub = sub;
  for (const b of elementRefs.metersSubtabs.querySelectorAll<HTMLButtonElement>(".meters-subtab")) {
    const on = b === btn;
    b.classList.toggle("active", on);
    b.setAttribute("aria-selected", String(on));
  }
  rebuild();
});
