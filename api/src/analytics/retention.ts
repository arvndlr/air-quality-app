import { Prisma } from "@prisma/client";
import { prisma } from "../prisma.js";
import { DAY_MS } from "./time.js";

/**
 * Highest category a raw reading may have to be deletable. Readings at or above
 * "Unhealthy for Sensitive Groups" are never deleted, so elevated readings stay in the
 * transmission history as evidence.
 */
export type DeletableCategory = "good" | "fair";

// Concentrations below which every reported pollutant is in the category (sensor units).
const LIMITS: Record<DeletableCategory, Record<string, number>> = {
  good: { pm25: 25.1, pm10: 55, so2: 35, co: 4.5, no2: 40.5, co2: 600, voc: 50.5, nh3: 5 },
  fair: { pm25: 35.1, pm10: 155, so2: 145, co: 9.5, no2: 80.5, co2: 1000, voc: 100.5, nh3: 25 }
};

function withinCategory(category: DeletableCategory): Prisma.Sql {
  const l = LIMITS[category];
  return Prisma.sql`
    (m."pm25ugm3" IS NULL OR m."pm25ugm3" < ${l.pm25})
    AND (m."pm10ugm3" IS NULL OR m."pm10ugm3" < ${l.pm10})
    AND (m."so2Ppb" IS NULL OR m."so2Status" IS DISTINCT FROM 'ok' OR m."so2Ppb" < ${l.so2})
    AND (m."micsCoPpm" IS NULL OR m."micsCoPpm" < ${l.co})
    AND (m."micsNo2Ppb" IS NULL OR m."micsNo2Ppb" < ${l.no2})
    AND (m."co2ppm" IS NULL OR m."co2ppm" < ${l.co2})
    AND (m."vocIndex" IS NULL OR m."vocIndex" < ${l.voc})
    AND (m."micsNh3Ppm" IS NULL OR m."micsNh3Ppm" < ${l.nh3})
  `;
}

export type DeleteFilter = {
  /** Internal Device.id; omit for every device. */
  deviceId?: string | null;
  from?: Date | null;
  to: Date;
  maxCategory: DeletableCategory;
};

/**
 * Only readings whose hour is already rolled up into a finalized HourlyAverage row can be
 * deleted, so daily and annual analytics keep every reading's contribution.
 */
function deletableWhere(filter: DeleteFilter): Prisma.Sql {
  return Prisma.sql`
    h."deviceId" = m."deviceId"
    AND h."hourStart" = (date_trunc('hour', m."ts" AT TIME ZONE 'UTC') AT TIME ZONE 'UTC')
    AND h."finalized" = true
    AND m."ts" < ${filter.to}
    ${filter.from ? Prisma.sql`AND m."ts" >= ${filter.from}` : Prisma.empty}
    ${filter.deviceId ? Prisma.sql`AND m."deviceId" = ${filter.deviceId}` : Prisma.empty}
    AND ${withinCategory(filter.maxCategory)}
  `;
}

export async function countDeletable(filter: DeleteFilter): Promise<number> {
  const [row] = await prisma.$queryRaw<Array<{ count: bigint }>>(Prisma.sql`
    SELECT count(*) AS count FROM "Measurement" m, "HourlyAverage" h WHERE ${deletableWhere(filter)}
  `);
  return Number(row?.count ?? 0);
}

export async function deleteReadings(
  filter: DeleteFilter,
  log: { mode: "auto" | "manual"; note?: string }
): Promise<number> {
  const deleted = await prisma.$executeRaw(Prisma.sql`
    DELETE FROM "Measurement" m USING "HourlyAverage" h WHERE ${deletableWhere(filter)}
  `);

  if (deleted > 0 || log.mode === "manual") {
    await prisma.dataDeletionLog.create({
      data: {
        mode: log.mode,
        deviceId: filter.deviceId ?? null,
        rangeFrom: filter.from ?? null,
        rangeTo: filter.to,
        maxCategory: filter.maxCategory,
        deletedCount: deleted,
        note: log.note ?? null
      }
    });
  }

  return deleted;
}

/** Deletes raw "Good" readings older than the retention period, for every device. */
export async function purgeOldGoodReadings(retentionDays: number, now = new Date()): Promise<number> {
  const to = new Date(now.getTime() - retentionDays * DAY_MS);
  return deleteReadings(
    { to, maxCategory: "good" },
    { mode: "auto", note: `Automatic: Good readings older than ${retentionDays} days` }
  );
}
