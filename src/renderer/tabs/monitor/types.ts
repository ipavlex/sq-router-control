/**
 * SQ Router Control — Monitor tab types.
 * Output selector options, parsed L/R destinations, and mix button items.
 */

/** One option in the L/R output <select>: value = "destType:channel". */
export interface OutputOption {
  value: string;
  label: string;
}

/** Parsed L/R destination selector value. */
export interface Dest {
  destType: number;
  destChannel: number;
}

/** One mix group button: b3 address + display label. */
export interface MixItem {
  b3: number;
  label: string;
}