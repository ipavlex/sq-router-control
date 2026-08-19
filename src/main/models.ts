/**
 * SQ model identification & physical I/O capacity.
 *
 * All SQ consoles share the same 48-input DSP engine, but differ in the number
 * of physical local inputs/outputs on the surface. These numbers drive the
 * routing display (which source channels are actually valid for each model).
 *
 *   Local mic pres / line outs:  SQ-5: 16 / 8    SQ-6: 32 / 16    SQ-7: 48 / 24
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
  /** Number of local mic/line inputs on the surface (16/32/48). */
  localInputs: number;
  /** Number of local line outputs on the surface. */
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
    localInputs: 16,
    localOutputs: 12,
    usbChannels: 32,
    mixBuses: 12,
    dcaGroups: 8,
    description: "48 in · 16 local / 12 local out",
  },
  0x02: {
    id: 0x02,
    name: "SQ-6",
    inputChannels: 48,
    localInputs: 32,
    localOutputs: 16,
    usbChannels: 32,
    mixBuses: 12,
    dcaGroups: 8,
    description: "48 in · 32 local / 16 local out",
  },
  0x03: {
    id: 0x03,
    name: "SQ-7",
    inputChannels: 48,
    localInputs: 48,
    localOutputs: 24,
    usbChannels: 32,
    mixBuses: 12,
    dcaGroups: 8,
    description: "48 in · 48 local / 24 local out",
  },
};

/** Generic fallback used when the model byte is unrecognised. */
export const DEFAULT_SPEC: SQModelSpec = {
  id: -1,
  name: "Unknown",
  inputChannels: 48,
  localInputs: 48,
  localOutputs: 24,
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
