/**
 * SQ Router Control — demo-mode meter simulator.
 *
 * Generates a stream of MetersPayload that mimics the SQ's UDP meter stream
 * (throttled to ~5 packets/s for a calm demo), so a demo session shows live
 * input level bars exactly like a real console. Only channels present in
 * the current routing carry signal; everything else reads as the floor (null).
 *
 * Realism features:
 * - per-channel nominal level with slow random-walk drift ("breathing")
 * - transient peaks that jump and decay, like percussive material
 * - correlated L/R levels for stereo pairs
 * - talkback / click / spare channels that sit at the floor and blip rarely
 * - steadier levels for USB playback channels
 * - rare clips (>0 dBFS) with a short clip-flag hold
 */
import { MetersPayload } from "./meters";

/** Input channel count of the SQ meter stream. */
const CHANNELS = 48;

/** Simulation tick interval (ms) — throttled stream for a calm demo. */
export const DEMO_METERS_TICK_MS = 200;

/** Channel names that look like talkback / click / spares — silent most of the time. */
const SILENT_NAME_RE = /talk|tlk|clk|click|cue|sp /i;
/** Channel names that look like playback material — steadier levels. */
const PLAYBACK_NAME_RE = /stm|play|trk|loop|md |pad|sfx/i;

interface ChannelState {
  /** Nominal level the channel sits around (dBFS). */
  base: number;
  /** Current smoothed level (dBFS). */
  level: number;
  /** Drift target the level wanders toward. */
  target: number;
  /** Decaying transient peak energy (dB added on top of the level). */
  peak: number;
  /** Ticks remaining to keep the clip flag lit after a clip. */
  clipHold: number;
  /** Talkback/click/spare channel — floor with rare active blips. */
  silent: boolean;
  /** Playback material — steadier drift, fewer and smaller peaks. */
  playback: boolean;
  /** Ticks remaining of an active talkback blip. */
  blip: number;
}

function rand(min: number, max: number): number {
  return min + Math.random() * (max - min);
}

/** Fresh state for a newly-routed channel; ramps in from below the base. */
function newChannelState(name: string): ChannelState {
  const silent = SILENT_NAME_RE.test(name);
  const playback = PLAYBACK_NAME_RE.test(name);
  const r = Math.random();
  const base = silent
    ? rand(-30, -20)
    : r < 0.15
      ? rand(-38, -28) // quiet sources
      : r < 0.75
        ? rand(-28, -16) // typical sources
        : rand(-16, -8); // hot sources
  return {
    base,
    level: base - rand(8, 20), // ramp in from below, like a channel opening up
    target: base,
    peak: 0,
    clipHold: 0,
    silent,
    playback,
    blip: 0,
  };
}

export class DemoMetersSim {
  /** Per-channel simulation state, keyed by mixer input b3 address. */
  private channels = new Map<number, ChannelState>();
  /** Stereo pairs (b3 addresses) whose L/R levels should correlate. */
  private pairs: number[][] = [];

  /**
   * Reconcile the simulated channels with the current routing: channels that
   * dropped out of the routing lose their state, newly-routed channels get
   * fresh state (and ramp in), long-lived channels keep drifting untouched.
   */
  sync(inputs: { destB3: number; name: string }[], stereoPairs: number[][]): void {
    const active = new Set(inputs.map((i) => i.destB3));
    for (const ch of this.channels.keys()) {
      if (!active.has(ch)) this.channels.delete(ch);
    }
    for (const inp of inputs) {
      if (!this.channels.has(inp.destB3)) {
        this.channels.set(inp.destB3, newChannelState(inp.name));
      }
    }
    this.pairs = (stereoPairs || []).filter(([l, r]) => active.has(l) && active.has(r));
  }

  /** Advance the simulation by one tick and produce a meters payload. */
  tick(): MetersPayload {
    const inputs: (number | null)[] = new Array<number | null>(CHANNELS).fill(null);
    const clip: boolean[] = new Array<boolean>(CHANNELS).fill(false);

    for (const [ch, st] of this.channels) {
      inputs[ch] = this.tickChannel(st);
      if (st.clipHold > 0) {
        clip[ch] = true;
        st.clipHold--;
      }
    }

    // Stereo pairs: the right side mirrors the left with a small delta so
    // the bars move together, like a real stereo source.
    for (const [l, r] of this.pairs) {
      const lv = inputs[l];
      if (lv != null && inputs[r] != null) {
        inputs[r] = lv + rand(-1.2, 1.2);
        clip[r] = clip[r] || clip[l];
      }
    }

    return { inputs, clip };
  }

  /** One simulation step for a single channel; returns its level (null = floor). */
  private tickChannel(st: ChannelState): number | null {
    // Talkback / click / spares: sit at the floor, occasionally blip active.
    if (st.silent) {
      if (st.blip > 0) {
        st.blip--;
        return rand(-24, -14);
      }
      if (Math.random() < 0.003) st.blip = Math.round(rand(10, 40));
      return null;
    }

    // Slow random-walk drift around the base level.
    const retarget = st.playback ? 0.02 : 0.06;
    if (Math.random() < retarget) st.target = st.base + rand(-3, 3);
    st.level += (st.target - st.level) * 0.15;

    // Transient peaks: jump up, then decay fast (percussive material).
    if (st.peak > 0.2) {
      st.peak *= 0.55;
    } else {
      st.peak = 0;
      const peakChance = st.playback ? 0.01 : 0.04;
      if (Math.random() < peakChance) st.peak = st.playback ? rand(2, 6) : rand(4, 12);
    }

    let db = st.level + st.peak;

    // Rare clip when the channel is already running hot.
    if (db > -2 && Math.random() < 0.04) {
      db = rand(0.5, 3);
      st.clipHold = 5;
    }

    return db;
  }
}
