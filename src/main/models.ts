/**
 * SQ model identification & physical I/O capacity.
 *
 * All SQ consoles share the same 48-input DSP engine, but differ in the number
 * of physical local inputs/outputs on the surface. These numbers drive the
 * routing display (which source channels are actually valid for each model).
 *
 *   Local mic pres (XLR):      SQ-5: 16    SQ-6: 24    SQ-7: 32
 *   Local line in (jacks):     ST1, ST2 (1/4" TRS pairs) + ST3 (3.5mm mini)
 *                              = 6 channels on every model, continuing the
 *                              local input bank after the XLRs.
 *   Local line outs (XLR):     SQ-5: 12    SQ-6: 14    SQ-7: 16
 *   Local line outs (TRS A/B): 2 on every model, continuing the local bank
 *                              (e.g. SQ-5: TRS A = Local Out 13, B = 14).
 *   USB audio: 32×32 on all models.
 *   dSnake / SLink expansion: up to 48 channels via AB168 / DT168 / AR2412 / AR84.
 */

export interface SQModelSpec {
  /** Raw model byte from the version frame. */
  id: number;
  /** Marketing name: SQ-5 / SQ-6 / SQ-7. */
  name: string;
  /** Number of input (mixing) channels — the DSP engine. 48 on all SQ models. */
  inputChannels: number;
  /** Local mic/line inputs on XLR sockets (16/24/32). */
  xlrInputs: number;
  /** Local line inputs on jack sockets: ST1, ST2 (TRS) + ST3 (3.5mm) — 6 on all models. */
  lineInputs: number;
  /** Total local input sockets (XLR + line), continuing one bank. */
  localInputs: number;
  /** Number of local line outputs on XLR sockets (12/14/16). */
  xlrOutputs: number;
  /** Number of local line outputs on TRS jack sockets (A/B) — 2 on all models. */
  trsOutputs: number;
  /** Total assignable local outputs (XLR + TRS). */
  localOutputs: number;
  /** USB audio channel count (bidirectional). */
  usbChannels: number;
  /** Mix (aux) bus count. */
  mixBuses: number;
  /** DCA group count. */
  dcaGroups: number;
  /** One-line description for the UI. */
  description: string;
}

export const MODELS: Record<number, SQModelSpec> = {
  0x01: {
    id: 0x01,
    name: "SQ-5",
    inputChannels: 48,
    xlrInputs: 16,
    lineInputs: 6,
    localInputs: 22,
    xlrOutputs: 12,
    trsOutputs: 2,
    localOutputs: 14,
    usbChannels: 32,
    mixBuses: 12,
    dcaGroups: 8,
    description: "48 in · 16 XLR + 6 line in · 14 local out (12 XLR + 2 TRS)",
  },
  0x02: {
    id: 0x02,
    name: "SQ-6",
    inputChannels: 48,
    xlrInputs: 24,
    lineInputs: 6,
    localInputs: 30,
    xlrOutputs: 14,
    trsOutputs: 2,
    localOutputs: 16,
    usbChannels: 32,
    mixBuses: 12,
    dcaGroups: 8,
    description: "48 in · 24 XLR + 6 line in · 16 local out (14 XLR + 2 TRS)",
  },
  0x03: {
    id: 0x03,
    name: "SQ-7",
    inputChannels: 48,
    xlrInputs: 32,
    lineInputs: 6,
    localInputs: 38,
    xlrOutputs: 16,
    trsOutputs: 2,
    localOutputs: 18,
    usbChannels: 32,
    mixBuses: 12,
    dcaGroups: 8,
    description: "48 in · 32 XLR + 6 line in · 18 local out (16 XLR + 2 TRS)",
  },
};

/** Generic fallback used when the model byte is unrecognised. */
export const DEFAULT_SPEC: SQModelSpec = {
  id: -1,
  name: "Unknown",
  inputChannels: 48,
  xlrInputs: 32,
  lineInputs: 6,
  localInputs: 38,
  xlrOutputs: 12,
  trsOutputs: 2,
  localOutputs: 14,
  usbChannels: 32,
  mixBuses: 12,
  dcaGroups: 8,
  description: "Unknown model — generic SQ defaults",
};

export function modelSpec(id: number): SQModelSpec {
  return MODELS[id] ?? { ...DEFAULT_SPEC, id, name: `Unknown (0x${id.toString(16)})` };
}

export function modelName(id: number): string {
  return modelSpec(id).name;
}
