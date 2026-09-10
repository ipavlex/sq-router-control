/**
 * SQ mixer channel state — live + initial-state model.
 *
 * Consumes DSP frames (both live changes from the mixer and synthetic events
 * synthesised by Connection._parseInitialState from the ParamData dump) and
 * maintains per-channel parameters in user-facing units (dB, Hz, -1..+1 pan).
 *
 * Register map (wire frames `F7 [x] cat reg [b3] mod valLo valHi`):
 *   cat 0x07 reg 0x0c            mute        val 1=muted, 0=unmuted
 *   cat 0x07 reg 0x0e mod 0x20   fader       0x8000-based, 256/dB (0 = −∞)
 *   cat 0x07 reg 0x0e mod 0x10-0x1b  bus send 1-12   0..35328 (0 dB at max)
 *   cat 0x07 reg 0x0e mod 0x23-0x26  FX send 1-4
 *   cat 0x07 reg 0x10 mod 0x20   pan         byte 0..74, 37 ≈ center
 *   cat 0x0c reg 0x0c            input gain  0x8000-based, 256/dB (0..+60 dB)
 *   cat 0x0c reg 0x0f            trim        26624=-24dB .. 36824=+24dB (212.5/dB)
 *   cat 0x0c reg 0x10            polarity    1=inverted
 *   cat 0x0e reg 0x0c            HPF on/off
 *   cat 0x0e reg 0x0d            HPF freq    wire = -9206 + 15308·log10(Hz)
 *   cat 0x0f reg 0x0c            gate on/off
 *   cat 0x13 reg 0x0c            comp on/off
 *   cat 0x14 reg 0x0c            delay on/off
 *   cat 0x14 reg 0x0d            delay duration, 96 units per ms (0..341 ms)
 *
 * Offsets and encodings are confirmed against SQ firmware (SQ5 FW 1.6,
 * 97376-byte ParamData) — see allen-heath-sq-tools sq-api FEATURES.md.
 */
import { DspFrame } from "./transport/connection";

/** Normalised send level 0..1 (wire 0..35328, 35328 = 0 dB / full). */
const SEND_MAX = 35328;
/** Trim: 26624 = -24 dB, 36824 = +24 dB → 0 dB at (26624+36824)/2, 212.5/dB. */
const TRIM_CENTER = (26624 + 36824) / 2;
const TRIM_PER_DB = 5100 / 24; // 212.5 wire units per dB

export interface ChannelState {
  b3: number;
  /** Fader in dB (−Infinity = pulled down / off), null = no data yet. */
  faderDb: number | null;
  muted: boolean | null;
  /** Pan −1..+1 (0 = center), null = no data. */
  pan: number | null;
  /** Input gain in dB (0..+60), null = no data (non-input addresses). */
  gainDb: number | null;
  trimDb: number | null;
  polarityOn: boolean | null;
  hpfOn: boolean | null;
  /** HPF frequency in Hz (20..2000). */
  hpfHz: number | null;
  gateOn: boolean | null;
  compOn: boolean | null;
  delayOn: boolean | null;
  delayMs: number | null;
  /** Bus send levels 1-12, normalised 0..1 (null = unknown). */
  busSends: (number | null)[];
  /** FX send levels 1-4, normalised 0..1 (null = unknown). */
  fxSends: (number | null)[];
}

function emptyState(b3: number): ChannelState {
  return {
    b3,
    faderDb: null,
    muted: null,
    pan: null,
    gainDb: null,
    trimDb: null,
    polarityOn: null,
    hpfOn: null,
    hpfHz: null,
    gateOn: null,
    compOn: null,
    delayOn: null,
    delayMs: null,
    busSends: new Array<number | null>(12).fill(null),
    fxSends: new Array<number | null>(4).fill(null),
  };
}

/** Wire → dB for 0x8000-based linear encodings (fader, gain). */
export function wireToDb(wire: number): number {
  return (wire - 0x8000) / 256;
}

/** Wire → trim dB (dedicated ±24 dB scale). */
export function wireToTrimDb(wire: number): number {
  return (wire - TRIM_CENTER) / TRIM_PER_DB;
}

/** Wire → pan −1..+1 (byte 0..74, 37 = center). */
export function wireToPan(wire: number): number {
  return wire / 37 - 1;
}

/** Wire → HPF frequency in Hz (log scale 20 Hz..2 kHz). */
export function wireToHpfHz(wire: number): number {
  return Math.pow(10, (wire + 9206) / 15308);
}

/** Wire → delay duration in ms (96 units per ms). */
export function wireToDelayMs(wire: number): number {
  return wire / 96;
}

export class MixerState {
  private channels = new Map<number, ChannelState>();

  /** Addresses that can meaningfully carry preamp parameters. */
  private static readonly B3_MAX = 0x7f;

  /**
   * Decode one DSP frame into the state model. Returns true when a known
   * parameter was updated (either from a live frame or from the initial
   * ParamData dump — both arrive in the same live-frame format).
   */
  handleDsp(d: DspFrame): boolean {
    if (d.ch < 0 || d.ch > MixerState.B3_MAX) return false;
    const v = d.value;

    switch (d.category) {
      case 0x07:
        if (d.register === 0x0c) {
          this.ch(d.ch).muted = v !== 0;
          return true;
        }
        if (d.register === 0x0e) {
          if (d.modifier === 0x20) {
            // 0 = fader fully down (−∞); the console sends 0 there.
            this.ch(d.ch).faderDb = v === 0 ? -Infinity : wireToDb(v);
            return true;
          }
          if (d.modifier >= 0x10 && d.modifier <= 0x1b) {
            this.ch(d.ch).busSends[d.modifier - 0x10] = v / SEND_MAX;
            return true;
          }
          if (d.modifier >= 0x23 && d.modifier <= 0x26) {
            this.ch(d.ch).fxSends[d.modifier - 0x23] = v / SEND_MAX;
            return true;
          }
          return false;
        }
        if (d.register === 0x10 && d.modifier === 0x20) {
          this.ch(d.ch).pan = wireToPan(v);
          return true;
        }
        return false;

      case 0x0c: // preamp
        if (d.register === 0x0c) {
          this.ch(d.ch).gainDb = wireToDb(v);
          return true;
        }
        if (d.register === 0x0f) {
          this.ch(d.ch).trimDb = wireToTrimDb(v);
          return true;
        }
        if (d.register === 0x10) {
          this.ch(d.ch).polarityOn = v !== 0;
          return true;
        }
        return false;

      case 0x0e: // HPF
        if (d.register === 0x0c) {
          this.ch(d.ch).hpfOn = v !== 0;
          return true;
        }
        if (d.register === 0x0d) {
          this.ch(d.ch).hpfHz = wireToHpfHz(v);
          return true;
        }
        return false;

      case 0x0f: // gate
        if (d.register === 0x0c) {
          this.ch(d.ch).gateOn = v !== 0;
          return true;
        }
        return false;

      case 0x13: // compressor
        if (d.register === 0x0c) {
          this.ch(d.ch).compOn = v !== 0;
          return true;
        }
        return false;

      case 0x14: // delay
        if (d.register === 0x0c) {
          this.ch(d.ch).delayOn = v !== 0;
          return true;
        }
        if (d.register === 0x0d) {
          this.ch(d.ch).delayMs = wireToDelayMs(v);
          return true;
        }
        return false;

      default:
        return false;
    }
  }

  private ch(b3: number): ChannelState {
    let c = this.channels.get(b3);
    if (!c) {
      c = emptyState(b3);
      this.channels.set(b3, c);
    }
    return c;
  }

  get(b3: number): ChannelState | null {
    return this.channels.get(b3) ?? null;
  }

  /** Number of channels with any known parameter. */
  get knownCount(): number {
    return this.channels.size;
  }

  snapshot(): ChannelState[] {
    return Array.from(this.channels.values())
      .sort((a, b) => a.b3 - b.b3)
      .map((c) => ({
        ...c,
        busSends: [...c.busSends],
        fxSends: [...c.fxSends],
      }));
  }

  reset(): void {
    this.channels.clear();
  }
}
