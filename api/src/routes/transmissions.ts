import { Prisma } from "@prisma/client";
import { Router } from "express";
import { z } from "zod";
import { asyncHandler } from "../async-handler.js";
import { prisma } from "../prisma.js";

export const transmissionsRouter = Router();

const statusFilters = ["all", "ready", "warming", "calibrating", "unknown"] as const;
type StatusFilter = (typeof statusFilters)[number];

type SummaryRow = {
  totalRows: bigint;
  deviceCount: bigint;
  latestTs: Date | null;
  earliestTs: Date | null;
  averageGapSec: number | null;
  readyCount: bigint;
  warmingCount: bigint;
  calibratingCount: bigint;
  unknownCount: bigint;
};

type TransmissionRow = {
  id: number;
  ts: Date;
  deviceExternalId: string;
  deviceName: string | null;
  transmissionStatus: Exclude<StatusFilter, "all">;
  gapSec: number | null;
  tempC: number | null;
  rh: number | null;
  vocIndex: number | null;
  batteryVoltage: number | null;
  chargerOn: boolean | null;
  uptimeSec: number | null;
  bootCount: number | null;
  resetReason: string | null;
  so2Status: string | null;
  so2Ppb: number | null;
  pm25ugm3: number | null;
  pm10ugm3: number | null;
  co2ppm: number | null;
  micsCoPpm: number | null;
  micsNo2Ppb: number | null;
  micsNh3Ppm: number | null;
};

function daysAgo(days: number) {
  return new Date(Date.now() - days * 24 * 60 * 60 * 1000);
}

function toNumber(value: bigint | number) {
  return typeof value === "bigint" ? Number(value) : value;
}

function buildBaseQuery(from: Date, to: Date, internalDeviceId: string | null) {
  const whereParts = [Prisma.sql`m."ts" >= ${from}`, Prisma.sql`m."ts" <= ${to}`];

  if (internalDeviceId) {
    whereParts.push(Prisma.sql`m."deviceId" = ${internalDeviceId}`);
  }

  const whereClause = Prisma.sql`WHERE ${Prisma.join(whereParts, " AND ")}`;

  return Prisma.sql`
    WITH base AS (
      SELECT
        m."id",
        m."ts",
        m."deviceId",
        d."externalId" AS "deviceExternalId",
        d."name" AS "deviceName",
        CASE
          WHEN m."so2Status" = 'warming' THEN 'warming'
          WHEN m."so2Status" = 'calibrating' THEN 'calibrating'
          WHEN m."so2Status" = 'ok' OR m."so2Ppb" IS NOT NULL THEN 'ready'
          ELSE 'unknown'
        END AS "transmissionStatus",
        LAG(m."ts") OVER (PARTITION BY m."deviceId" ORDER BY m."ts" ASC) AS "prevTs",
        m."tempC",
        m."rh",
        m."vocIndex",
        m."batteryVoltage",
        m."chargerOn",
        m."uptimeSec",
        m."bootCount",
        m."resetReason",
        m."so2Status",
        m."so2Ppb",
        m."pm25ugm3",
        m."pm10ugm3",
        m."co2ppm",
        m."micsCoPpm",
        m."micsNo2Ppb",
        m."micsNh3Ppm"
      FROM "Measurement" m
      INNER JOIN "Device" d ON d."id" = m."deviceId"
      ${whereClause}
    )
  `;
}

function buildStatusWhere(status: StatusFilter) {
  if (status === "all") {
    return Prisma.empty;
  }

  return Prisma.sql`WHERE "transmissionStatus" = ${status}`;
}

transmissionsRouter.get(
  "/",
  asyncHandler(async (req, res) => {
    const querySchema = z.object({
      deviceId: z.string().min(1).optional(),
      from: z.coerce.date().optional(),
      to: z.coerce.date().optional(),
      status: z.enum(statusFilters).default("all"),
      page: z.coerce.number().int().min(1).default(1),
      pageSize: z.coerce.number().int().min(1).max(100).default(20)
    });

    const parsed = querySchema.parse(req.query);
    const { deviceId, status, page, pageSize } = parsed;
    const from = parsed.from ?? daysAgo(7);
    const to = parsed.to ?? new Date();

    if (from > to) {
      return res.status(400).json({ error: "`from` must be earlier than or equal to `to`." });
    }

    let internalDeviceId: string | null = null;

    if (deviceId) {
      const device = await prisma.device.findUnique({
        where: { externalId: deviceId },
        select: { id: true }
      });

      if (!device) {
        return res.status(404).json({ error: "Device not found" });
      }

      internalDeviceId = device.id;
    }

    const baseQuery = buildBaseQuery(from, to, internalDeviceId);
    const statusWhere = buildStatusWhere(status);
    const offset = (page - 1) * pageSize;

    const [summaryRow] = await prisma.$queryRaw<SummaryRow[]>(Prisma.sql`
      ${baseQuery}
      SELECT
        COUNT(*) AS "totalRows",
        COUNT(DISTINCT "deviceId") AS "deviceCount",
        MAX("ts") AS "latestTs",
        MIN("ts") AS "earliestTs",
        AVG(EXTRACT(EPOCH FROM ("ts" - "prevTs")))::float AS "averageGapSec",
        COALESCE(SUM(CASE WHEN "transmissionStatus" = 'ready' THEN 1 ELSE 0 END), 0) AS "readyCount",
        COALESCE(SUM(CASE WHEN "transmissionStatus" = 'warming' THEN 1 ELSE 0 END), 0) AS "warmingCount",
        COALESCE(SUM(CASE WHEN "transmissionStatus" = 'calibrating' THEN 1 ELSE 0 END), 0) AS "calibratingCount",
        COALESCE(SUM(CASE WHEN "transmissionStatus" = 'unknown' THEN 1 ELSE 0 END), 0) AS "unknownCount"
      FROM base
      ${statusWhere}
    `);

    const rows = await prisma.$queryRaw<TransmissionRow[]>(Prisma.sql`
      ${baseQuery}
      SELECT
        "id",
        "ts",
        "deviceExternalId",
        "deviceName",
        "transmissionStatus",
        CASE
          WHEN "prevTs" IS NULL THEN NULL
          ELSE EXTRACT(EPOCH FROM ("ts" - "prevTs"))::int
        END AS "gapSec",
        "tempC",
        "rh",
        "vocIndex",
        "batteryVoltage",
        "chargerOn",
        "uptimeSec",
        "bootCount",
        "resetReason",
        "so2Status",
        "so2Ppb",
        "pm25ugm3",
        "pm10ugm3",
        "co2ppm",
        "micsCoPpm",
        "micsNo2Ppb",
        "micsNh3Ppm"
      FROM base
      ${statusWhere}
      ORDER BY "ts" DESC, "id" DESC
      LIMIT ${pageSize}
      OFFSET ${offset}
    `);

    const totalRows = summaryRow ? toNumber(summaryRow.totalRows) : 0;
    const totalPages = Math.max(1, Math.ceil(totalRows / pageSize));

    res.json({
      filters: {
        deviceId: deviceId ?? null,
        from: from.toISOString(),
        to: to.toISOString(),
        status
      },
      summary: {
        totalRows,
        deviceCount: summaryRow ? toNumber(summaryRow.deviceCount) : 0,
        latestTs: summaryRow?.latestTs?.toISOString() ?? null,
        earliestTs: summaryRow?.earliestTs?.toISOString() ?? null,
        averageGapSec: summaryRow?.averageGapSec ?? null,
        statusCounts: {
          ready: summaryRow ? toNumber(summaryRow.readyCount) : 0,
          warming: summaryRow ? toNumber(summaryRow.warmingCount) : 0,
          calibrating: summaryRow ? toNumber(summaryRow.calibratingCount) : 0,
          unknown: summaryRow ? toNumber(summaryRow.unknownCount) : 0
        }
      },
      pagination: {
        page,
        pageSize,
        totalRows,
        totalPages,
        hasPreviousPage: page > 1,
        hasNextPage: page < totalPages
      },
      rows: rows.map((row) => ({
        ...row,
        ts: row.ts.toISOString()
      }))
    });
  })
);
