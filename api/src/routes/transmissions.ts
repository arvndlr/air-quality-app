import { Prisma } from "@prisma/client";
import { Router } from "express";
import { z } from "zod";
import { asyncHandler } from "../async-handler.js";
import { prisma } from "../prisma.js";

export const transmissionsRouter = Router();

const statusFilters = ["all", "ready", "warming", "calibrating", "unknown"] as const;
type StatusFilter = (typeof statusFilters)[number];

const EXPORT_ROW_LIMIT = 20000;

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

type DailySummaryRow = {
  day: string;
  totalRows: bigint;
  deviceCount: bigint;
  firstTs: Date | null;
  lastTs: Date | null;
  averageGapSec: number | null;
  readyCount: bigint;
  warmingCount: bigint;
  calibratingCount: bigint;
  unknownCount: bigint;
  avgPm25: number | null;
  maxPm25: number | null;
  avgPm10: number | null;
  maxPm10: number | null;
  avgSo2: number | null;
  maxSo2: number | null;
  avgCo: number | null;
  maxCo: number | null;
  avgNo2: number | null;
  maxNo2: number | null;
  avgCo2: number | null;
  maxCo2: number | null;
  avgVoc: number | null;
  maxVoc: number | null;
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

function isValidTimeZone(timeZone: string) {
  try {
    new Intl.DateTimeFormat("en-US", { timeZone });
    return true;
  } catch {
    return false;
  }
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

function buildRowSelect(baseQuery: Prisma.Sql, statusWhere: Prisma.Sql, limit: Prisma.Sql) {
  return Prisma.sql`
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
    ${limit}
  `;
}

function buildDailyQuery(baseQuery: Prisma.Sql, statusWhere: Prisma.Sql, timeZone: string) {
  return Prisma.sql`
    ${baseQuery}
    SELECT
      to_char(("ts" AT TIME ZONE ${timeZone}::text)::date, 'YYYY-MM-DD') AS "day",
      COUNT(*) AS "totalRows",
      COUNT(DISTINCT "deviceId") AS "deviceCount",
      MIN("ts") AS "firstTs",
      MAX("ts") AS "lastTs",
      AVG(EXTRACT(EPOCH FROM ("ts" - "prevTs")))::float AS "averageGapSec",
      COALESCE(SUM(CASE WHEN "transmissionStatus" = 'ready' THEN 1 ELSE 0 END), 0) AS "readyCount",
      COALESCE(SUM(CASE WHEN "transmissionStatus" = 'warming' THEN 1 ELSE 0 END), 0) AS "warmingCount",
      COALESCE(SUM(CASE WHEN "transmissionStatus" = 'calibrating' THEN 1 ELSE 0 END), 0) AS "calibratingCount",
      COALESCE(SUM(CASE WHEN "transmissionStatus" = 'unknown' THEN 1 ELSE 0 END), 0) AS "unknownCount",
      AVG("pm25ugm3")::float AS "avgPm25",
      MAX("pm25ugm3")::float AS "maxPm25",
      AVG("pm10ugm3")::float AS "avgPm10",
      MAX("pm10ugm3")::float AS "maxPm10",
      AVG("so2Ppb")::float AS "avgSo2",
      MAX("so2Ppb")::float AS "maxSo2",
      AVG("micsCoPpm")::float AS "avgCo",
      MAX("micsCoPpm")::float AS "maxCo",
      AVG("micsNo2Ppb")::float AS "avgNo2",
      MAX("micsNo2Ppb")::float AS "maxNo2",
      AVG("co2ppm")::float AS "avgCo2",
      MAX("co2ppm")::float AS "maxCo2",
      AVG("vocIndex")::float AS "avgVoc",
      MAX("vocIndex")::float AS "maxVoc"
    FROM base
    ${statusWhere}
    GROUP BY 1
    ORDER BY 1 DESC
  `;
}

function mapDailyRow(row: DailySummaryRow) {
  return {
    day: row.day,
    totalRows: toNumber(row.totalRows),
    deviceCount: toNumber(row.deviceCount),
    firstTs: row.firstTs?.toISOString() ?? null,
    lastTs: row.lastTs?.toISOString() ?? null,
    averageGapSec: row.averageGapSec,
    statusCounts: {
      ready: toNumber(row.readyCount),
      warming: toNumber(row.warmingCount),
      calibrating: toNumber(row.calibratingCount),
      unknown: toNumber(row.unknownCount)
    },
    averages: {
      pm25: row.avgPm25,
      pm10: row.avgPm10,
      so2: row.avgSo2,
      co: row.avgCo,
      no2: row.avgNo2,
      co2: row.avgCo2,
      voc: row.avgVoc
    },
    peaks: {
      pm25: row.maxPm25,
      pm10: row.maxPm10,
      so2: row.maxSo2,
      co: row.maxCo,
      no2: row.maxNo2,
      co2: row.maxCo2,
      voc: row.maxVoc
    }
  };
}

const filterSchema = z.object({
  deviceId: z.string().min(1).optional(),
  from: z.coerce.date().optional(),
  to: z.coerce.date().optional(),
  status: z.enum(statusFilters).default("all"),
  timeZone: z.string().min(1).max(64).optional()
});

type ResolvedFilters = {
  deviceId: string | null;
  internalDeviceId: string | null;
  from: Date;
  to: Date;
  status: StatusFilter;
  timeZone: string;
};

/**
 * Resolves the shared `deviceId`/`from`/`to`/`status`/`timeZone` filters used by both the
 * JSON listing and the CSV export. Returns an error payload instead of throwing so each
 * route can answer with the status code that suits its response format.
 */
async function resolveFilters(
  query: unknown
): Promise<{ ok: true; filters: ResolvedFilters } | { ok: false; status: number; error: string }> {
  const parsed = filterSchema.parse(query);
  const from = parsed.from ?? daysAgo(7);
  const to = parsed.to ?? new Date();

  if (from > to) {
    return { ok: false, status: 400, error: "`from` must be earlier than or equal to `to`." };
  }

  const timeZone = parsed.timeZone && isValidTimeZone(parsed.timeZone) ? parsed.timeZone : "UTC";
  let internalDeviceId: string | null = null;

  if (parsed.deviceId) {
    const device = await prisma.device.findUnique({
      where: { externalId: parsed.deviceId },
      select: { id: true }
    });

    if (!device) {
      return { ok: false, status: 404, error: "Device not found" };
    }

    internalDeviceId = device.id;
  }

  return {
    ok: true,
    filters: {
      deviceId: parsed.deviceId ?? null,
      internalDeviceId,
      from,
      to,
      status: parsed.status,
      timeZone
    }
  };
}

transmissionsRouter.get(
  "/",
  asyncHandler(async (req, res) => {
    const paginationSchema = z.object({
      page: z.coerce.number().int().min(1).default(1),
      pageSize: z.coerce.number().int().min(1).max(100).default(20)
    });

    const resolved = await resolveFilters(req.query);

    if (!resolved.ok) {
      return res.status(resolved.status).json({ error: resolved.error });
    }

    const { deviceId, internalDeviceId, from, to, status, timeZone } = resolved.filters;
    const { page, pageSize } = paginationSchema.parse(req.query);

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

    const dailyRows = await prisma.$queryRaw<DailySummaryRow[]>(
      buildDailyQuery(baseQuery, statusWhere, timeZone)
    );

    const rows = await prisma.$queryRaw<TransmissionRow[]>(
      buildRowSelect(baseQuery, statusWhere, Prisma.sql`LIMIT ${pageSize} OFFSET ${offset}`)
    );

    const totalRows = summaryRow ? toNumber(summaryRow.totalRows) : 0;
    const totalPages = Math.max(1, Math.ceil(totalRows / pageSize));

    res.json({
      filters: {
        deviceId,
        from: from.toISOString(),
        to: to.toISOString(),
        status,
        timeZone
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
      daily: dailyRows.map(mapDailyRow),
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

function csvCell(value: string | number | boolean | null | undefined) {
  if (value == null) return "";

  const text = String(value);
  return /[",\r\n]/.test(text) ? `"${text.replace(/"/g, '""')}"` : text;
}

function csvLine(cells: Array<string | number | boolean | null | undefined>) {
  return cells.map(csvCell).join(",");
}

function round(value: number | null, digits: number) {
  if (value == null) return null;
  return Number(value.toFixed(digits));
}

function fileStamp(date: Date) {
  return date.toISOString().slice(0, 19).replace(/[:T]/g, "-");
}

const detailHeader = [
  "timestamp_utc",
  "device_id",
  "device_name",
  "transmission_status",
  "gap_seconds",
  "pm25_ugm3",
  "pm10_ugm3",
  "so2_ppb",
  "co_ppm",
  "no2_ppb",
  "nh3_ppm",
  "co2_ppm",
  "voc_index",
  "temperature_c",
  "humidity_pct",
  "battery_v",
  "charger_on",
  "uptime_sec",
  "boot_count",
  "reset_reason",
  "so2_sensor_status"
];

const dailyHeader = [
  "day",
  "transmissions",
  "devices",
  "first_transmission_utc",
  "last_transmission_utc",
  "avg_interval_sec",
  "ready",
  "warming",
  "calibrating",
  "unknown",
  "avg_pm25_ugm3",
  "peak_pm25_ugm3",
  "avg_pm10_ugm3",
  "peak_pm10_ugm3",
  "avg_so2_ppb",
  "peak_so2_ppb",
  "avg_co_ppm",
  "peak_co_ppm",
  "avg_no2_ppb",
  "peak_no2_ppb",
  "avg_co2_ppm",
  "peak_co2_ppm",
  "avg_voc_index",
  "peak_voc_index"
];

transmissionsRouter.get(
  "/export",
  asyncHandler(async (req, res) => {
    const exportSchema = z.object({ mode: z.enum(["detail", "daily"]).default("detail") });

    const resolved = await resolveFilters(req.query);

    if (!resolved.ok) {
      return res.status(resolved.status).json({ error: resolved.error });
    }

    const { deviceId, internalDeviceId, from, to, status, timeZone } = resolved.filters;
    const { mode } = exportSchema.parse(req.query);

    const baseQuery = buildBaseQuery(from, to, internalDeviceId);
    const statusWhere = buildStatusWhere(status);

    const lines: string[] = [
      csvLine(["# Transmission log export"]),
      csvLine(["# device", deviceId ?? "all devices"]),
      csvLine(["# from", from.toISOString()]),
      csvLine(["# to", to.toISOString()]),
      csvLine(["# status", status]),
      csvLine(["# day grouping time zone", timeZone]),
      csvLine(["# generated", new Date().toISOString()]),
      ""
    ];

    if (mode === "daily") {
      const dailyRows = await prisma.$queryRaw<DailySummaryRow[]>(
        buildDailyQuery(baseQuery, statusWhere, timeZone)
      );

      lines.push(csvLine(dailyHeader));

      for (const raw of dailyRows) {
        const row = mapDailyRow(raw);
        lines.push(
          csvLine([
            row.day,
            row.totalRows,
            row.deviceCount,
            row.firstTs,
            row.lastTs,
            round(row.averageGapSec, 1),
            row.statusCounts.ready,
            row.statusCounts.warming,
            row.statusCounts.calibrating,
            row.statusCounts.unknown,
            round(row.averages.pm25, 2),
            round(row.peaks.pm25, 2),
            round(row.averages.pm10, 2),
            round(row.peaks.pm10, 2),
            round(row.averages.so2, 2),
            round(row.peaks.so2, 2),
            round(row.averages.co, 2),
            round(row.peaks.co, 2),
            round(row.averages.no2, 2),
            round(row.peaks.no2, 2),
            round(row.averages.co2, 1),
            round(row.peaks.co2, 1),
            round(row.averages.voc, 1),
            round(row.peaks.voc, 1)
          ])
        );
      }
    } else {
      const rows = await prisma.$queryRaw<TransmissionRow[]>(
        buildRowSelect(baseQuery, statusWhere, Prisma.sql`LIMIT ${EXPORT_ROW_LIMIT}`)
      );

      if (rows.length === EXPORT_ROW_LIMIT) {
        lines.push(csvLine([`# note: truncated to the ${EXPORT_ROW_LIMIT} most recent transmissions`]));
      }

      lines.push(csvLine(detailHeader));

      for (const row of rows) {
        lines.push(
          csvLine([
            row.ts.toISOString(),
            row.deviceExternalId,
            row.deviceName,
            row.transmissionStatus,
            row.gapSec,
            round(row.pm25ugm3, 2),
            round(row.pm10ugm3, 2),
            round(row.so2Ppb, 2),
            round(row.micsCoPpm, 2),
            round(row.micsNo2Ppb, 2),
            round(row.micsNh3Ppm, 3),
            row.co2ppm,
            round(row.vocIndex, 1),
            round(row.tempC, 2),
            round(row.rh, 2),
            round(row.batteryVoltage, 3),
            row.chargerOn,
            row.uptimeSec,
            row.bootCount,
            row.resetReason,
            row.so2Status
          ])
        );
      }
    }

    const scope = deviceId ? deviceId.replace(/[^a-zA-Z0-9_-]/g, "-") : "all-devices";
    const filename = `transmissions-${mode}-${scope}-${fileStamp(from)}_to_${fileStamp(to)}.csv`;

    res.setHeader("Content-Type", "text/csv; charset=utf-8");
    res.setHeader("Content-Disposition", `attachment; filename="${filename}"`);
    // Excel needs the BOM to read the UTF-8 export correctly.
    res.send(`﻿${lines.join("\r\n")}\r\n`);
  })
);
