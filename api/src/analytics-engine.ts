
import { prisma } from "./prisma.js";
import { computeAqi } from "./aqi.js";

export type AnalyticsPeriod = "1h" | "8h" | "24h" | "annual";

const PERIOD_MS: Record<AnalyticsPeriod, number> = {
  "1h": 60 * 60 * 1000,
  "8h": 8 * 60 * 60 * 1000,
  "24h": 24 * 60 * 60 * 1000,
  annual: 365 * 24 * 60 * 60 * 1000
};

const MIN_COVERAGE: Record<AnalyticsPeriod, number> = {
  "1h": 75,
  "8h": 75,
  "24h": 75,
  annual: 75
};

type Reading = {
  pm25ugm3: number | null;
  pm10ugm3: number | null;
  co2ppm: number | null;
  micsCoPpm: number | null;
  micsNo2Ppb: number | null;
  so2Ppb: number | null;
  so2Status: string | null;
  ts: Date;
};

function average(values: Array<number | null>): number | null {
  const valid = values.filter(
    (v): v is number => v !== null && Number.isFinite(v) && v >= 0
  );

  if (!valid.length) return null;

  return valid.reduce((sum, v) => sum + v, 0) / valid.length;
}

function coverage(sampleCount: number, expectedCount: number): number {
  if (expectedCount <= 0) return 0;
  return Math.min(100, (sampleCount / expectedCount) * 100);
}

function severity(aqi: number | null): string {
  if (aqi === null) return "INSUFFICIENT_DATA";
  if (aqi <= 50) return "Good";
  if (aqi <= 100) return "Moderate";
  if (aqi <= 150) return "Unhealthy for Sensitive Groups";
  if (aqi <= 200) return "Unhealthy";
  if (aqi <= 300) return "Very Unhealthy";
  return "Hazardous";
}

export async function calculateAnalytics(
  deviceExternalId: string,
  period: AnalyticsPeriod,
  now = new Date()
) {
  const device = await prisma.device.findUnique({
    where: { externalId: deviceExternalId }
  });

  if (!device) {
    throw new Error("Device not found");
  }

  const duration = PERIOD_MS[period];
  const windowEnd = now;
  const windowStart = new Date(now.getTime() - duration);

  const readings = await prisma.measurement.findMany({
    where: {
      deviceId: device.id,
      ts: {
        gte: windowStart,
        lte: windowEnd
      }
    },
    orderBy: {
      ts: "asc"
    },
    select: {
      ts: true,
      pm25ugm3: true,
      pm10ugm3: true,
      co2ppm: true,
      micsCoPpm: true,
      micsNo2Ppb: true,
      so2Ppb: true,
      so2Status: true
    }
  }) as Reading[];

  const expectedCount = Math.ceil(duration / 5000);
  const sampleCount = readings.length;
  const coveragePct = coverage(sampleCount, expectedCount);

  const avgPm25 = average(readings.map(r => r.pm25ugm3));
  const avgPm10 = average(readings.map(r => r.pm10ugm3));
  const avgCO2 = average(readings.map(r => r.co2ppm));

  // Do not treat warming or calibrating SO2 as valid.
  const avgSO2 = average(
    readings.map(r => r.so2Status === "ok" ? r.so2Ppb : null)
  );

  // MiCS concentrations are kept separate from AQI until
  // their measurement/calibration validity is established.
  const avgCO = average(readings.map(r => r.micsCoPpm));
  const avgNO2 = average(readings.map(r => r.micsNo2Ppb));

  const isValid = coveragePct >= MIN_COVERAGE[period];

  const aqi = isValid
    ? computeAqi({
        pm25: avgPm25,
        pm10: avgPm10,
        co: null,
        no2: null,
        so2: avgSO2
      })
    : null;

  const pollutantScores = [
    { pollutant: "PM2.5", value: avgPm25, unit: "µg/m³" },
    { pollutant: "PM10", value: avgPm10, unit: "µg/m³" },
    { pollutant: "SO2", value: avgSO2, unit: "ppb" },
    { pollutant: "CO2", value: avgCO2, unit: "ppm" }
  ];

  const topPollutants = pollutantScores
    .filter(p => p.value !== null)
    .sort((a, b) => (b.value ?? 0) - (a.value ?? 0))
    .slice(0, 3);

  return {
    deviceId: deviceExternalId,
    period,
    windowStart,
    windowEnd,
    computedAt: now,
    sampleCount,
    expectedCount,
    coveragePct: Number(coveragePct.toFixed(2)),
    isValid,
    averages: {
      pm25: avgPm25,
      pm10: avgPm10,
      co: avgCO,
      co2: avgCO2,
      no2: avgNO2,
      so2: avgSO2
    },
    aqi: isValid ? aqi : null,
    category: isValid ? severity(aqi?.aqi ?? null) : "INSUFFICIENT_DATA",
    dominantPollutant: aqi?.dominantPollutant ?? null,
    topPollutants
  };
}
