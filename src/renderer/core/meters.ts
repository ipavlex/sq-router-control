/**
 * Shared meter scale helpers — dBFS → bar fill / color class.
 * Used by both the routing tab (horizontal bars) and the monitor tab
 * (vertical bars) so the scale stays identical everywhere.
 */
import type { MetersPayload } from "../../shared/ipc";

/** Meter bar spans this dynamic range (dBFS). */
export const METER_MIN_DB = -60;
/** dBFS at which the bar turns amber. */
export const METER_WARN_DB = -20;
/** dBFS at which the bar turns red. */
export const METER_HOT_DB = -6;

/** dBFS → 0..100 bar fill (null → 0). */
export function dbToPercent(db: number | null): number {
  if (db == null) return 0;
  const clamped = Math.max(METER_MIN_DB, Math.min(0, db));
  return ((clamped - METER_MIN_DB) / (0 - METER_MIN_DB)) * 100;
}

/** Color modifier class for a level ("meter-warn" / "meter-hot" / ""). */
export function meterClassName(db: number | null): string {
  if (db == null) return "";
  if (db >= METER_HOT_DB) return " meter-hot";
  if (db >= METER_WARN_DB) return " meter-warn";
  return "";
}

/** One channel's reading as display text ("−12.3 dB" / "нет сигнала"). */
export function meterDbText(
  ch: number,
  meters: MetersPayload | null
): string {
  const db = meters ? meters.inputs[ch] ?? null : null;
  return db != null && db >= METER_MIN_DB ? `${db.toFixed(1)} dB` : "нет сигнала";
}
