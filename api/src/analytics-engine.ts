import { Prisma } from "@prisma/client";
import { prisma } from "./prisma.js";
import { computeAqi } from "./aqi.js";

export type AnalyticsPeriod = "1h" | "8h" | "24h" | "annual";

const HOUR_MS = 60 * 60 * 1000;

const PERIOD_MS: Record<AnalyticsPeriod, number> = {
  "1h": HOUR_MS,
  "8h": 8 * HOUR_MS,
  "24h": 24 * HOUR_MS,
  annual: 365 * 24 * HOUR_MS
};

// Must match SEND_INTERVAL_MS in firmware/esp32-air-quality/esp32-air-quality.ino.
const SAMPLE_INTERVAL_MS = 10_000;

// Minimum share of expected samples a window needs before its AQI is reported.
const MIN_COVERAGE_PCT = 75;

type AggregateRow = {
  sampleCount: bigint;
  avgPm25: number | null;
  avgPm10: number | null;
  avgCO2: number | null;
  avgCO: number | null;
  avgNO2: number | null;
  avgSO2: number | null;
};

type DeviceRef = { id: string; externalId: string };

export async function calculateAnalytics(
  device: DeviceRef,
  period: AnalyticsPeriod,
  now = new Date()
) {
  const duration = PERIOD_MS[period];

  // Align the window to the minute so repeated requests within the same minute
  // share one AnalyticsSummary row instead of inserting a new one each time.
  const windowEnd = new Date(Math.floor(now.getTime() / 60_000) * 60_000);
  const windowStart = new Date(windowEnd.getTime() - duration);

  // Aggregate in Postgres: the annual window can hold millions of rows.
  // Negative values are sensor faults and are ignored, matching computeAqi.
  // SO2 counts only once the sensor reports "ok" (not warming/calibrating/unstable).
  const [row] = await prisma.$queryRaw<AggregateRow[]>(Prisma.sql`
    SELECT
      count(*) AS "sampleCount",
      avg("pm25ugm3")   FILTER (WHERE "pm25ugm3" >= 0)::float   AS "avgPm25",
      avg("pm10ugm3")   FILTER (WHERE "pm10ugm3" >= 0)::float   AS "avgPm10",
      avg("co2ppm")     FILTER (WHERE "co2ppm" >= 0)::float     AS "avgCO2",
      avg("micsCoPpm")  FILTER (WHERE "micsCoPpm" >= 0)::float  AS "avgCO",
      avg("micsNo2Ppb") FILTER (WHERE "micsNo2Ppb" >= 0)::float AS "avgNO2",
      avg("so2Ppb")     FILTER (WHERE "so2Ppb" >= 0 AND "so2Status" = 'ok')::float AS "avgSO2"
    FROM "Measurement"
    WHERE "deviceId" = ${device.id}
      AND "ts" > ${windowStart}
      AND "ts" <= ${windowEnd}
  `);

  const sampleCount = Number(row?.sampleCount ?? 0);
  const expectedCount = Math.floor(duration / SAMPLE_INTERVAL_MS);
  const coveragePct = Number(Math.min(100, (sampleCount / expectedCount) * 100).toFixed(2));
  const isValid = coveragePct >= MIN_COVERAGE_PCT;

  const avgPm25 = row?.avgPm25 ?? null;
  const avgPm10 = row?.avgPm10 ?? null;
  const avgCO2 = row?.avgCO2 ?? null;
  const avgCO = row?.avgCO ?? null;
  const avgNO2 = row?.avgNO2 ?? null;
  const avgSO2 = row?.avgSO2 ?? null;

  // MiCS CO/NO2 stay out of the AQI until their calibration is validated.
  const aqi = isValid
    ? computeAqi({ pm25: avgPm25, pm10: avgPm10, co: null, no2: null, so2: avgSO2 })
    : null;

  // Rank by AQI sub-index, not raw concentration: the units differ, so raw
  // values aren't comparable. CO2 has no AQI breakpoints and is not ranked.
  const topPollutants = aqi
    ? [
        { pollutant: "pm25", value: avgPm25, unit: "µg/m³", subIndex: aqi.pm25SubIndex },
        { pollutant: "pm10", value: avgPm10, unit: "µg/m³", subIndex: aqi.pm10SubIndex },
        { pollutant: "so2", value: avgSO2, unit: "ppb", subIndex: aqi.so2SubIndex }
      ]
        .filter((p) => p.value !== null)
        .sort((a, b) => b.subIndex - a.subIndex)
    : [];

  const category = aqi?.category ?? "INSUFFICIENT_DATA";
  const dominantPollutant = aqi?.dominantPollutant ?? null;
  const computedAt = new Date();

  const summary = {
    sampleCount,
    coveragePct,
    isValid,
    avgPm25,
    avgPm10,
    avgCO,
    avgCO2,
    avgNO2,
    avgSO2,
    aqi: aqi?.aqi ?? null,
    category,
    dominantPollutant,
    pollutantDetails: topPollutants,
    computedAt
  };

  await prisma.analyticsSummary.upsert({
    where: {
      deviceId_period_windowStart: { deviceId: device.id, period, windowStart }
    },
    create: { deviceId: device.id, period, windowStart, windowEnd, ...summary },
    update: { windowEnd, ...summary }
  });

  return {
    deviceId: device.externalId,
    period,
    windowStart,
    windowEnd,
    computedAt,
    sampleCount,
    expectedCount,
    coveragePct,
    isValid,
    averages: {
      pm25: avgPm25,
      pm10: avgPm10,
      co: avgCO,
      co2: avgCO2,
      no2: avgNO2,
      so2: avgSO2
    },
    aqi,
    category,
    dominantPollutant,
    topPollutants
  };
}
