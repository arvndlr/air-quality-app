import { Prisma, type HourlyAverage } from "@prisma/client";
import { prisma } from "../prisma.js";
import { HOUR_MS } from "./time.js";
import type { PollutantKey } from "./pollutants.js";

/** Raw Measurement column and validity condition for each pollutant. */
export const RAW_COLUMNS: Record<PollutantKey, { column: string; valid: string }> = {
  pm25: { column: `"pm25ugm3"`, valid: `"pm25ugm3" >= 0` },
  pm10: { column: `"pm10ugm3"`, valid: `"pm10ugm3" >= 0` },
  // SO2 only counts once the sensor reports "ok" (not warming, calibrating or unstable).
  so2: { column: `"so2Ppb"`, valid: `"so2Ppb" >= 0 AND "so2Status" = 'ok'` },
  co: { column: `"micsCoPpm"`, valid: `"micsCoPpm" >= 0` },
  no2: { column: `"micsNo2Ppb"`, valid: `"micsNo2Ppb" >= 0` },
  co2: { column: `"co2ppm"`, valid: `"co2ppm" >= 0` },
  voc: { column: `"vocIndex"`, valid: `"vocIndex" >= 0` },
  nh3: { column: `"micsNh3Ppm"`, valid: `"micsNh3Ppm" >= 0` }
};

const KEYS = Object.keys(RAW_COLUMNS) as PollutantKey[];

/** DENR §2.1(e): an hour is representative with at least 45 minutes of data. */
export const MIN_MINUTES_PER_HOUR = 45;

/** Hours that ended this long ago are finalized and never recomputed from raw data. */
const FINALIZE_AFTER_MS = 2 * HOUR_MS;

const insertColumns = [
  `"deviceId"`,
  `"hourStart"`,
  `"sampleCount"`,
  `"finalized"`,
  ...KEYS.flatMap((k) => [`"${k}Avg"`, `"${k}Max"`, `"${k}Minutes"`]),
  `"tempCAvg"`,
  `"rhAvg"`,
  `"updatedAt"`
];

const selectAggregates = KEYS.flatMap((k) => {
  const { column, valid } = RAW_COLUMNS[k];
  return [
    `avg(${column}) FILTER (WHERE ${valid})::float`,
    `max(${column}) FILTER (WHERE ${valid})::float`,
    `count(DISTINCT date_trunc('minute', m."ts")) FILTER (WHERE ${valid})::int`
  ];
}).join(",\n      ");

const updateAssignments = insertColumns
  .filter((c) => c !== `"deviceId"` && c !== `"hourStart"`)
  .map((c) => `${c} = EXCLUDED.${c}`)
  .join(", ");

/**
 * Upserts hourly averages for raw readings with `from <= ts < to`. Finalized hours are left
 * alone, because their raw "Good" readings may already have been purged.
 */
export async function rollupHours(params: { from: Date; to: Date; deviceId?: string; now?: Date }): Promise<number> {
  const now = params.now ?? new Date();
  const finalizeBefore = new Date(now.getTime() - FINALIZE_AFTER_MS);
  const deviceFilter = params.deviceId ? Prisma.sql`AND m."deviceId" = ${params.deviceId}` : Prisma.empty;
  const hour = Prisma.raw(`(date_trunc('hour', m."ts" AT TIME ZONE 'UTC') AT TIME ZONE 'UTC')`);

  return prisma.$executeRaw(Prisma.sql`
    INSERT INTO "HourlyAverage" (${Prisma.raw(insertColumns.join(", "))})
    SELECT
      m."deviceId",
      ${hour},
      count(*)::int,
      ${hour} < ${finalizeBefore},
      ${Prisma.raw(selectAggregates)},
      avg(m."tempC")::float,
      avg(m."rh")::float,
      now()
    FROM "Measurement" m
    WHERE m."ts" >= ${params.from} AND m."ts" < ${params.to} ${deviceFilter}
    GROUP BY 1, 2
    ON CONFLICT ("deviceId", "hourStart") DO UPDATE SET ${Prisma.raw(updateAssignments)}
    WHERE "HourlyAverage"."finalized" = false
  `);
}

/** Marks hours finalized once they are old enough, even if no new readings arrived. */
export async function finalizeHours(now = new Date()): Promise<number> {
  const finalizeBefore = new Date(now.getTime() - FINALIZE_AFTER_MS);
  return prisma.hourlyAverage.updateMany({
    where: { finalized: false, hourStart: { lt: finalizeBefore } },
    data: { finalized: true }
  }).then((r) => r.count);
}

export type HourStats = { avg: number | null; max: number | null; minutes: number; valid: boolean };

export function hourStats(row: HourlyAverage, key: PollutantKey): HourStats {
  const record = row as unknown as Record<string, number | null>;
  const minutes = (record[`${key}Minutes`] as number | null) ?? 0;
  return {
    avg: record[`${key}Avg`] ?? null,
    max: record[`${key}Max`] ?? null,
    minutes,
    valid: minutes >= MIN_MINUTES_PER_HOUR
  };
}
