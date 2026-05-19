import { Router } from "express";
import { z } from "zod";
import { Prisma } from "@prisma/client";
import { prisma } from "../prisma.js";
import { asyncHandler } from "../async-handler.js";

export const seriesRouter = Router();

const metrics = {
  tempC: `"tempC"`,
  rh: `"rh"`,
  pressureHpa: `"pressureHpa"`,
  gasKohm: `"gasKohm"`,
  vocIndex: `"vocIndex"`,
  co2ppm: `"co2ppm"`,
  scdTempC: `"scdTempC"`,
  scdRh: `"scdRh"`,
  pm1ugm3: `"pm1ugm3"`,
  pm25ugm3: `"pm25ugm3"`,
  pm10ugm3: `"pm10ugm3"`,
  so2Vgas: `"so2Vgas"`,
  so2Vref: `"so2Vref"`,
  so2Mv: `"so2Mv"`,
  micsNh3V: `"micsNh3V"`,
  micsCoV: `"micsCoV"`,
  micsNo2V: `"micsNo2V"`,
  so2Ppb: `"so2Ppb"`,
  micsCoPpm: `"micsCoPpm"`,
  micsNo2Ppb: `"micsNo2Ppb"`,
  micsNh3Ppm: `"micsNh3Ppm"`
} as const;

type MetricKey = keyof typeof metrics;

const buckets = ["minute", "hour", "day", "week", "month", "year", "5min", "15min"] as const;
type Bucket = (typeof buckets)[number];

function bucketExpr(bucket: Bucket) {
  if (bucket === "5min") {
    return `date_bin(interval '5 minutes', "ts", timestamptz '2000-01-01')`;
  }
  if (bucket === "15min") {
    return `date_bin(interval '15 minutes', "ts", timestamptz '2000-01-01')`;
  }
  return `date_trunc('${bucket}', "ts")`;
}

seriesRouter.get(
  "/",
  asyncHandler(async (req, res) => {
    const querySchema = z.object({
      deviceId: z.string().min(1),
      metric: z.enum(Object.keys(metrics) as [MetricKey, ...MetricKey[]]),
      from: z.coerce.date(),
      to: z.coerce.date(),
      bucket: z.enum(buckets).default("hour")
    });

    const { deviceId, metric, from, to, bucket } = querySchema.parse(req.query);

    const device = await prisma.device.findUnique({ where: { externalId: deviceId } });
    if (!device) return res.status(404).json({ error: "Device not found" });

    const metricColumn = metrics[metric];
    const bucketSql = bucketExpr(bucket);

    const rows = await prisma.$queryRaw<
      Array<{ bucket: Date; avg: number | null; min: number | null; max: number | null }>
    >(Prisma.sql`
      SELECT
        ${Prisma.raw(bucketSql)} as bucket,
        avg(${Prisma.raw(metricColumn)})::float as avg,
        min(${Prisma.raw(metricColumn)})::float as min,
        max(${Prisma.raw(metricColumn)})::float as max
      FROM "Measurement"
      WHERE "deviceId" = ${device.id}
        AND "ts" >= ${from}
        AND "ts" <= ${to}
        AND ${Prisma.raw(metricColumn)} IS NOT NULL
      GROUP BY bucket
      ORDER BY bucket ASC
    `);

    res.json({ deviceId, metric, bucket, from: from.toISOString(), to: to.toISOString(), points: rows });
  })
);
