import { Router, type Request } from "express";
import { timingSafeEqual } from "crypto";
import { z } from "zod";
import { prisma } from "../prisma.js";
import { env } from "../env.js";
import { asyncHandler } from "../async-handler.js";
import { CATEGORIES } from "../analytics/denr.js";
import { buildOverview, eventDto, rollingWindows } from "../analytics/overview.js";
import { countDeletable, deleteReadings } from "../analytics/retention.js";
import { refreshDevice, retentionState, runCycle, schedulerState } from "../analytics/scheduler.js";
import { DAY_MS, HOUR_MS } from "../analytics/time.js";
import { POLLUTANTS } from "../analytics/pollutants.js";

export const analyticsRouter = Router();

async function findDevice(externalId: string) {
  return prisma.device.findUnique({ where: { externalId }, select: { id: true, externalId: true, name: true } });
}

/** Full analytics for one station: rolling DENR averages, trend, top pollutants, events, summary. */
analyticsRouter.get(
  "/overview",
  asyncHandler(async (req, res) => {
    const query = z
      .object({
        deviceId: z.string().min(1),
        from: z.coerce.date().optional(),
        to: z.coerce.date().optional()
      })
      .parse(req.query);

    const device = await findDevice(query.deviceId);
    if (!device) return res.status(404).json({ error: "Device not found" });

    const now = new Date();
    const to = query.to ?? now;
    const from = query.from ?? new Date(to.getTime() - 30 * DAY_MS);
    if (from >= to) return res.status(400).json({ error: "`from` must be before `to`" });

    await refreshDevice(device.id, now);
    return res.json(await buildOverview({ device, from, to, timeZone: env.ANALYTICS_TIMEZONE, now }));
  })
);

/** Rolling 1h/8h/24h averages and DENR indices for one station. */
analyticsRouter.get(
  "/summary",
  asyncHandler(async (req, res) => {
    const query = z.object({ deviceId: z.string().min(1), period: z.enum(["1h", "8h", "24h"]) }).parse(req.query);
    const device = await findDevice(query.deviceId);
    if (!device) return res.status(404).json({ error: "Device not found" });

    const now = new Date();
    await refreshDevice(device.id, now);
    const windows = await rollingWindows(device.id, now);
    const hours = query.period === "1h" ? 1 : query.period === "8h" ? 8 : 24;

    return res.json({
      deviceId: device.externalId,
      period: query.period,
      windowStart: new Date(now.getTime() - hours * HOUR_MS),
      windowEnd: now,
      pollutants: Object.fromEntries(
        Object.entries(windows).map(([key, periods]) => [key, periods[query.period]])
      )
    });
  })
);

/** Pollution events (sustained episodes and short spikes), newest first. */
analyticsRouter.get(
  "/events",
  asyncHandler(async (req, res) => {
    const query = z
      .object({
        deviceId: z.string().min(1).optional(),
        status: z.enum(["ACTIVE", "RESOLVED"]).optional(),
        from: z.coerce.date().optional(),
        to: z.coerce.date().optional(),
        limit: z.coerce.number().int().min(1).max(500).default(100)
      })
      .parse(req.query);

    let deviceId: string | undefined;
    if (query.deviceId) {
      const device = await findDevice(query.deviceId);
      if (!device) return res.status(404).json({ error: "Device not found" });
      deviceId = device.id;
    }

    const events = await prisma.pollutionEvent.findMany({
      where: {
        ...(deviceId ? { deviceId } : {}),
        ...(query.status ? { status: query.status } : {}),
        ...(query.to ? { startedAt: { lt: query.to } } : {}),
        ...(query.from ? { OR: [{ endedAt: null }, { endedAt: { gte: query.from } }] } : {})
      },
      include: { device: { select: { externalId: true, name: true } } },
      orderBy: { startedAt: "desc" },
      take: query.limit
    });

    return res.json({
      events: events.map((e) => ({ ...eventDto(e), deviceId: e.device.externalId, deviceName: e.device.name }))
    });
  })
);

/** Category scale and pollutant reference data (breakpoints, guideline values). */
analyticsRouter.get("/reference", (_req, res) => {
  res.json({
    categories: CATEGORIES,
    pollutants: Object.values(POLLUTANTS).map(({ key, label, unit, basis, aqiPeriod, guidelines }) => ({
      key,
      label,
      unit,
      basis,
      aqiPeriod,
      guidelines
    }))
  });
});

// ---- Data retention ------------------------------------------------------------------

analyticsRouter.get(
  "/retention",
  asyncHandler(async (_req, res) => {
    const cutoff = new Date(Date.now() - env.RETENTION_GOOD_DAYS * DAY_MS);
    const [rawRows, oldest, hourlyRows, dailyRows, eventCount, eligibleNow, recentDeletions] = await Promise.all([
      prisma.measurement.count(),
      prisma.measurement.findFirst({ orderBy: { ts: "asc" }, select: { ts: true } }),
      prisma.hourlyAverage.count(),
      prisma.analyticsSummary.count({ where: { period: "daily" } }),
      prisma.pollutionEvent.count(),
      countDeletable({ to: cutoff, maxCategory: "good" }),
      prisma.dataDeletionLog.findMany({ orderBy: { createdAt: "desc" }, take: 10 })
    ]);

    const devices = await prisma.device.findMany({ select: { id: true, externalId: true } });
    const byId = new Map(devices.map((d) => [d.id, d.externalId]));

    res.json({
      autoDeleteEnabled: env.RETENTION_AUTO_DELETE,
      goodRetentionDays: env.RETENTION_GOOD_DAYS,
      manualDeleteEnabled: env.ADMIN_API_KEY != null,
      cutoff: cutoff.toISOString(),
      lastAutoRun: retentionState.lastRunAt?.toISOString() ?? null,
      lastAutoDeleted: retentionState.lastDeleted,
      lastAutoError: retentionState.lastError,
      lastCycleAt: schedulerState.lastCycleAt?.toISOString() ?? null,
      rawRows,
      oldestRawAt: oldest?.ts.toISOString() ?? null,
      hourlyRows,
      dailyRows,
      eventCount,
      eligibleNow,
      recentDeletions: recentDeletions.map((d) => ({
        ...d,
        deviceId: d.deviceId ? byId.get(d.deviceId) ?? d.deviceId : null
      }))
    });
  })
);

const deleteSchema = z
  .object({
    deviceId: z.string().min(1).nullable().optional(),
    from: z.coerce.date().nullable().optional(),
    to: z.coerce.date(),
    maxCategory: z.enum(["good", "fair"])
  })
  .refine((v) => !v.from || v.from < v.to, { message: "`from` must be before `to`" });

async function resolveDeleteFilter(body: unknown) {
  const input = deleteSchema.parse(body);
  let deviceId: string | null = null;
  if (input.deviceId) {
    const device = await findDevice(input.deviceId);
    if (!device) return { error: "Device not found" as const };
    deviceId = device.id;
  }
  return { filter: { deviceId, from: input.from ?? null, to: input.to, maxCategory: input.maxCategory } };
}

function hasAdminKey(req: Request): boolean {
  const expected = env.ADMIN_API_KEY;
  const given = req.header("x-admin-key");
  if (!expected || !given) return false;
  const a = Buffer.from(given);
  const b = Buffer.from(expected);
  return a.length === b.length && timingSafeEqual(a, b);
}

/** How many raw readings a manual delete would remove. */
analyticsRouter.post(
  "/records/preview",
  asyncHandler(async (req, res) => {
    const resolved = await resolveDeleteFilter(req.body);
    if ("error" in resolved) return res.status(404).json({ error: resolved.error });
    // Make sure recent hours are rolled up, so they become eligible once finalized.
    await runCycle(false);
    return res.json({ count: await countDeletable(resolved.filter) });
  })
);

/** Deletes raw Good (or Good and Fair) readings. Hourly/daily analytics and events are kept. */
analyticsRouter.post(
  "/records/delete",
  asyncHandler(async (req, res) => {
    if (!env.ADMIN_API_KEY) {
      return res.status(403).json({ error: "Manual deletion is disabled. Set ADMIN_API_KEY on the API to enable it." });
    }
    if (!hasAdminKey(req)) return res.status(401).json({ error: "Invalid admin key" });

    const resolved = await resolveDeleteFilter(req.body);
    if ("error" in resolved) return res.status(404).json({ error: resolved.error });

    await runCycle(false);
    const deleted = await deleteReadings(resolved.filter, { mode: "manual" });
    return res.json({ deleted });
  })
);
