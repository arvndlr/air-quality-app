import { env } from "../env.js";
import { prisma } from "../prisma.js";
import { rebuildDailySummaries } from "./daily.js";
import { rebuildEvents } from "./events.js";
import { purgeOldGoodReadings } from "./retention.js";
import { finalizeHours, rollupHours } from "./rollup.js";
import { addZonedDays, HOUR_MS, startOfZonedDay } from "./time.js";

type RetentionState = { lastRunAt: Date | null; lastDeleted: number; lastError: string | null };

export const retentionState: RetentionState = { lastRunAt: null, lastDeleted: 0, lastError: null };
export const schedulerState = { lastCycleAt: null as Date | null, lastError: null as string | null };

const PURGE_EVERY_MS = HOUR_MS;
let running: Promise<void> | null = null;

/** Brings one device's hourly rollups and today's/yesterday's daily summaries up to date. */
export async function refreshDevice(deviceId: string, now = new Date()) {
  const tz = env.ANALYTICS_TIMEZONE;
  await rollupHours({ deviceId, from: new Date(now.getTime() - 3 * HOUR_MS), to: new Date(now.getTime() + 60_000), now });
  const today = startOfZonedDay(now, tz);
  await rebuildDailySummaries({
    deviceId,
    fromDay: addZonedDays(today, -1, tz),
    toDay: addZonedDays(today, 1, tz),
    timeZone: tz,
    now
  });
}

async function cycle(full: boolean) {
  const tz = env.ANALYTICS_TIMEZONE;
  const now = new Date();
  const devices = await prisma.device.findMany({ select: { id: true, externalId: true } });

  // A full cycle backfills every hour; finalized hours are never overwritten.
  await rollupHours({
    from: full ? new Date(0) : new Date(now.getTime() - 3 * HOUR_MS),
    to: new Date(now.getTime() + 60_000),
    now
  });
  await finalizeHours(now);

  const today = startOfZonedDay(now, tz);

  for (const device of devices) {
    const startedAt = new Date();
    try {
      let fromDay = addZonedDays(today, -1, tz);
      if (full) {
        const first = await prisma.hourlyAverage.findFirst({
          where: { deviceId: device.id },
          orderBy: { hourStart: "asc" },
          select: { hourStart: true }
        });
        if (!first) continue;
        fromDay = startOfZonedDay(first.hourStart, tz);
      }

      const days = await rebuildDailySummaries({
        deviceId: device.id,
        fromDay,
        toDay: addZonedDays(today, 1, tz),
        timeZone: tz,
        now
      });
      const events = await rebuildEvents({ deviceId: device.id, timeZone: tz, now });

      if (full) {
        await prisma.analyticsRun.create({
          data: {
            deviceId: device.id,
            startedAt,
            completedAt: new Date(),
            status: "COMPLETED",
            windowsProcessed: days,
            eventsDetected: events
          }
        });
      }
    } catch (error) {
      const message = error instanceof Error ? error.message : String(error);
      // eslint-disable-next-line no-console
      console.error(`[analytics] ${device.externalId}:`, error);
      await prisma.analyticsRun.create({
        data: { deviceId: device.id, startedAt, completedAt: new Date(), status: "FAILED", errorMessage: message.slice(0, 1000) }
      });
    }
  }

  const purgeDue = !retentionState.lastRunAt || now.getTime() - retentionState.lastRunAt.getTime() >= PURGE_EVERY_MS;
  if (env.RETENTION_AUTO_DELETE && purgeDue) {
    try {
      retentionState.lastDeleted = await purgeOldGoodReadings(env.RETENTION_GOOD_DAYS, now);
      retentionState.lastError = null;
      if (retentionState.lastDeleted > 0) {
        // eslint-disable-next-line no-console
        console.log(`[analytics] Deleted ${retentionState.lastDeleted} Good readings older than ${env.RETENTION_GOOD_DAYS} days`);
      }
    } catch (error) {
      retentionState.lastError = error instanceof Error ? error.message : String(error);
      // eslint-disable-next-line no-console
      console.error("[analytics] Retention purge failed:", error);
    }
    retentionState.lastRunAt = now;
  }

  schedulerState.lastCycleAt = now;
}

export function runCycle(full = false): Promise<void> {
  if (running) return running;
  running = cycle(full)
    .then(() => {
      schedulerState.lastError = null;
    })
    .catch((error) => {
      schedulerState.lastError = error instanceof Error ? error.message : String(error);
      // eslint-disable-next-line no-console
      console.error("[analytics] Cycle failed:", error);
    })
    .finally(() => {
      running = null;
    });
  return running;
}

export function startAnalyticsScheduler() {
  // The first cycle backfills hourly averages, daily summaries and events from existing data.
  void runCycle(true);
  const timer = setInterval(() => void runCycle(false), env.ANALYTICS_INTERVAL_MINUTES * 60_000);
  timer.unref();
}
