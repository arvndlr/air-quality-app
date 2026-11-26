import type { HourlyAverage } from "@prisma/client";
import { hourStats } from "./rollup.js";
import type { PollutantKey } from "./pollutants.js";
import { HOUR_MS } from "./time.js";

export type HourIndex = Map<number, HourlyAverage>;

export function indexHours(rows: HourlyAverage[]): HourIndex {
  return new Map(rows.map((r) => [r.hourStart.getTime(), r]));
}

export type WindowStats = {
  /** Mean of the representative hourly averages (falls back to any hour with data). */
  avg: number | null;
  max: number | null;
  /** Hour start (ms) of the highest hourly average. */
  peakHourMs: number | null;
  validHours: number;
  hoursWithData: number;
  /** Hours in the window that have already started. */
  elapsedHours: number;
  maxConsecutiveMissing: number;
  /** Representative hours in each 8-hour third of the window. */
  blockCounts: number[];
};

/**
 * Summarises `hours` consecutive hourly rows for one pollutant, starting at `startMs`.
 * Hours that haven't started yet (after `nowMs`) are not counted as missing.
 */
export function windowStats(
  index: HourIndex,
  key: PollutantKey,
  startMs: number,
  hours: number,
  nowMs: number
): WindowStats {
  let validSum = 0;
  let validHours = 0;
  let anySum = 0;
  let hoursWithData = 0;
  let max: number | null = null;
  let peakHourMs: number | null = null;
  let elapsedHours = 0;
  let missingRun = 0;
  let maxConsecutiveMissing = 0;
  const blockSize = Math.max(1, Math.round(hours / 3));
  const blockCounts = [0, 0, 0];

  for (let i = 0; i < hours; i++) {
    const t = startMs + i * HOUR_MS;
    if (t > nowMs) break;
    elapsedHours++;

    const row = index.get(t);
    const stats = row ? hourStats(row, key) : null;

    if (stats?.avg != null) {
      anySum += stats.avg;
      hoursWithData++;
      if (max == null || stats.avg > max) {
        max = stats.avg;
        peakHourMs = t;
      }
    }

    if (stats?.valid && stats.avg != null) {
      validSum += stats.avg;
      validHours++;
      blockCounts[Math.min(2, Math.floor(i / blockSize))]!++;
      missingRun = 0;
    } else if (t + HOUR_MS <= nowMs) {
      // Only closed hours count as missing.
      missingRun++;
      maxConsecutiveMissing = Math.max(maxConsecutiveMissing, missingRun);
    }
  }

  const avg = validHours > 0 ? validSum / validHours : hoursWithData > 0 ? anySum / hoursWithData : null;

  return { avg, max, peakHourMs, validHours, hoursWithData, elapsedHours, maxConsecutiveMissing, blockCounts };
}

/** DENR §2.1(c): ≥18 representative hours, ≥6 in each 8-hour period, ≤2 consecutive missing. */
export function isRepresentativeDay(stats: WindowStats): boolean {
  return (
    stats.validHours >= 18 &&
    stats.blockCounts.every((count) => count >= 6) &&
    stats.maxConsecutiveMissing <= 2
  );
}

/** DENR §2.1(d): an 8-hour average needs at least 6 representative hours. */
export function isRepresentative8h(stats: WindowStats): boolean {
  return stats.validHours >= 6;
}

/**
 * Highest 8-hour running average whose window ends inside [startMs, startMs + hours),
 * counting only windows with at least 6 representative hours. Used for CO (8-hour AQI).
 */
export function maxRunning8h(
  index: HourIndex,
  key: PollutantKey,
  startMs: number,
  hours: number,
  nowMs: number
): { avg: number; endHourMs: number } | null {
  let best: { avg: number; endHourMs: number } | null = null;

  for (let i = 0; i < hours; i++) {
    const endHourMs = startMs + i * HOUR_MS;
    if (endHourMs > nowMs) break;
    const stats = windowStats(index, key, endHourMs - 7 * HOUR_MS, 8, nowMs);
    if (!isRepresentative8h(stats) || stats.avg == null) continue;
    if (!best || stats.avg > best.avg) best = { avg: stats.avg, endHourMs };
  }

  return best;
}
