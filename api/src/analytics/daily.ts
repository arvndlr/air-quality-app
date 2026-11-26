import { Prisma, type AnalyticsSummary } from "@prisma/client";
import { prisma } from "../prisma.js";
import { categoryFor, type AqiCategoryKey } from "../aqi.js";
import { POLLUTANT_KEYS, POLLUTANTS, pollutantIndex, type PollutantKey } from "./pollutants.js";
import { addZonedDays, HOUR_MS, startOfZonedDay, zonedDateKey, zonedHour } from "./time.js";
import { indexHours, isRepresentativeDay, maxRunning8h, windowStats } from "./windows.js";

export const DAILY_PERIOD = "daily";

export type DailyPollutant = {
  /** 24-hour average of representative hourly averages. */
  avg: number | null;
  /** Value the index is computed from: the 24-hour average, or the max 8-hour average for CO. */
  indexValue: number | null;
  index: number | null;
  category: AqiCategoryKey | null;
  /** Highest hourly average of the day, and its local hour. */
  maxHourly: number | null;
  peakHour: number | null;
  maxHourlyIndex: number | null;
  validHours: number;
  hoursWithData: number;
  /** Meets the DENR representative-day rule (75% data capture). */
  valid: boolean;
};

export type DailyDetails = {
  day: string;
  provisional: boolean;
  elapsedHours: number;
  pollutants: Record<PollutantKey, DailyPollutant>;
};

const AQI_KEYS: PollutantKey[] = ["pm25", "pm10", "so2"];

/** Rebuilds the stored daily summaries for every zoned day in [fromDay, toDay). */
export async function rebuildDailySummaries(params: {
  deviceId: string;
  fromDay: Date;
  toDay: Date;
  timeZone: string;
  now?: Date;
}): Promise<number> {
  const { deviceId, timeZone } = params;
  const now = params.now ?? new Date();
  const nowMs = now.getTime();

  // CO's first 8-hour window of the day reaches 7 hours into the previous day.
  const hours = await prisma.hourlyAverage.findMany({
    where: {
      deviceId,
      hourStart: { gte: new Date(params.fromDay.getTime() - 7 * HOUR_MS), lt: params.toDay }
    },
    orderBy: { hourStart: "asc" }
  });
  if (hours.length === 0) return 0;

  const index = indexHours(hours);
  const daysWithData = new Set(
    hours.filter((h) => h.hourStart >= params.fromDay).map((h) => startOfZonedDay(h.hourStart, timeZone).getTime())
  );

  let written = 0;

  for (const dayMs of [...daysWithData].sort((a, b) => a - b)) {
    const dayStart = new Date(dayMs);
    const dayEnd = addZonedDays(dayStart, 1, timeZone);
    const dayHours = Math.round((dayEnd.getTime() - dayMs) / HOUR_MS);
    const provisional = dayEnd.getTime() > nowMs;

    const pollutants = {} as Record<PollutantKey, DailyPollutant>;
    let sampleCount = 0;
    let elapsedHours = 0;

    for (let t = dayMs; t < dayEnd.getTime(); t += HOUR_MS) sampleCount += index.get(t)?.sampleCount ?? 0;

    for (const key of POLLUTANT_KEYS) {
      const stats = windowStats(index, key, dayMs, dayHours, nowMs);
      elapsedHours = Math.max(elapsedHours, stats.elapsedHours);

      let indexValue = stats.avg;
      if (POLLUTANTS[key].aqiPeriod === "8h") {
        indexValue = maxRunning8h(index, key, dayMs, dayHours, nowMs)?.avg ?? stats.avg;
      }

      const idx = pollutantIndex(key, indexValue);
      pollutants[key] = {
        avg: round(stats.avg),
        indexValue: round(indexValue),
        index: idx,
        category: idx == null ? null : categoryFor(idx).key,
        maxHourly: round(stats.max),
        peakHour: stats.peakHourMs == null ? null : zonedHour(new Date(stats.peakHourMs), timeZone),
        maxHourlyIndex: pollutantIndex(key, stats.max),
        validHours: stats.validHours,
        hoursWithData: stats.hoursWithData,
        valid: !provisional && isRepresentativeDay(stats)
      };
    }

    // Day AQI: highest DENR sub-index among PM2.5, PM10 and SO2. Representative pollutants
    // decide it; if none is representative yet, the best available data gives a provisional one.
    const candidates = AQI_KEYS.filter((k) => pollutants[k].index != null);
    const representative = candidates.filter((k) => pollutants[k].valid);
    const pool = representative.length > 0 ? representative : candidates;
    const dominant = pool.reduce<PollutantKey | null>(
      (best, k) => (best == null || pollutants[k].index! > pollutants[best].index! ? k : best),
      null
    );
    const aqi = dominant ? pollutants[dominant].index : null;
    const coverage = Math.max(0, ...AQI_KEYS.map((k) => pollutants[k].validHours)) / dayHours;

    const details: DailyDetails = {
      day: zonedDateKey(dayStart, timeZone),
      provisional,
      elapsedHours,
      pollutants
    };

    const data = {
      windowEnd: dayEnd,
      computedAt: now,
      sampleCount,
      coveragePct: Number((coverage * 100).toFixed(1)),
      isValid: representative.length > 0,
      avgPm25: pollutants.pm25.avg,
      avgPm10: pollutants.pm10.avg,
      avgCO: pollutants.co.avg,
      avgCO2: pollutants.co2.avg,
      avgNO2: pollutants.no2.avg,
      avgSO2: pollutants.so2.avg,
      aqi,
      category: aqi == null ? null : categoryFor(aqi).label,
      dominantPollutant: dominant,
      pollutantDetails: details as unknown as Prisma.InputJsonValue
    };

    await prisma.analyticsSummary.upsert({
      where: { deviceId_period_windowStart: { deviceId, period: DAILY_PERIOD, windowStart: dayStart } },
      create: { deviceId, period: DAILY_PERIOD, windowStart: dayStart, ...data },
      update: data
    });
    written++;
  }

  return written;
}

export function dailyDetails(summary: AnalyticsSummary): DailyDetails | null {
  const details = summary.pollutantDetails as unknown as DailyDetails | null;
  return details && typeof details === "object" && "pollutants" in details ? details : null;
}

export async function loadDailySummaries(deviceId: string, from?: Date, to?: Date) {
  return prisma.analyticsSummary.findMany({
    where: {
      deviceId,
      period: DAILY_PERIOD,
      ...(from || to ? { windowStart: { ...(from ? { gte: from } : {}), ...(to ? { lt: to } : {}) } } : {})
    },
    orderBy: { windowStart: "asc" }
  });
}

function round(value: number | null): number | null {
  return value == null ? null : Number(value.toFixed(3));
}
