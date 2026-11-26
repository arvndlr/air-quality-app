import { Prisma, type HourlyAverage, type PollutionEvent } from "@prisma/client";
import { prisma } from "../prisma.js";
import { CATEGORIES, categoryFor } from "../aqi.js";
import { explainCauses } from "./analysis.js";
import { dailyDetails, loadDailySummaries, type DailyDetails } from "./daily.js";
import {
  ELEVATED_INDEX,
  POLLUTANT_KEYS,
  POLLUTANTS,
  elevatedThreshold,
  pollutantIndex,
  tierFor,
  type PollutantKey
} from "./pollutants.js";
import { hourStats } from "./rollup.js";
import { addZonedDays, DAY_MS, formatHourLabel, HOUR_MS, startOfZonedDay, zonedHour } from "./time.js";

/** An hourly average at or above this index on a non-elevated day is recorded as a spike. */
const SPIKE_INDEX = 151;

type Day = { start: Date; end: Date; details: DailyDetails };

export type EventKind = "sustained" | "spike";

/** What a stored PollutionEvent's JSON columns hold, for API consumers. */
export type EventEvidence = {
  kind: EventKind;
  days: Array<{
    day: string;
    avg: number | null;
    indexValue: number | null;
    index: number | null;
    category: string | null;
    validHours: number;
    valid: boolean;
  }>;
  peakIndex: number;
  spikeHourLabel?: string;
} & ReturnType<typeof explainCauses>["evidence"];

/**
 * Rebuilds a device's pollution events from its stored daily summaries and hourly averages.
 * Both are kept permanently, so events stay reproducible after raw readings are purged.
 */
export async function rebuildEvents(params: { deviceId: string; timeZone: string; now?: Date }): Promise<number> {
  const { deviceId, timeZone } = params;
  const now = params.now ?? new Date();
  const todayStart = startOfZonedDay(now, timeZone);
  const yesterdayStart = addZonedDays(todayStart, -1, timeZone);

  const days: Day[] = (await loadDailySummaries(deviceId))
    .map((s) => ({ start: s.windowStart, end: s.windowEnd, details: dailyDetails(s) }))
    .filter((d): d is Day => d.details != null);

  type Candidate = { key: PollutantKey; kind: EventKind; days: Day[]; startedAt: Date; spikeHour?: number };
  const candidates: Candidate[] = [];

  for (const key of POLLUTANT_KEYS) {
    let run: Day[] = [];
    const flush = () => {
      if (run.length) candidates.push({ key, kind: "sustained", days: run, startedAt: run[0]!.start });
      run = [];
    };

    for (const day of days) {
      const p = day.details.pollutants[key];
      const elevated = (p.index ?? 0) >= ELEVATED_INDEX;
      const consecutive = run.length > 0 && Math.abs(day.start.getTime() - run[run.length - 1]!.end.getTime()) < HOUR_MS;

      if (elevated) {
        if (run.length > 0 && !consecutive) flush();
        run.push(day);
      } else {
        flush();
        if ((p.maxHourlyIndex ?? 0) >= SPIKE_INDEX) {
          candidates.push({ key, kind: "spike", days: [day], startedAt: day.start, spikeHour: p.peakHour ?? undefined });
        }
      }
    }
    flush();
  }

  if (candidates.length === 0) {
    await prisma.pollutionEvent.deleteMany({ where: { deviceId } });
    return 0;
  }

  // Hourly rows for the event days, for the time-of-day and humidity analysis.
  const first = Math.min(...candidates.map((c) => c.startedAt.getTime()));
  const last = Math.max(...candidates.map((c) => c.days[c.days.length - 1]!.end.getTime()));
  const hourly = await prisma.hourlyAverage.findMany({
    where: { deviceId, hourStart: { gte: new Date(first), lt: new Date(last) } },
    orderBy: { hourStart: "asc" }
  });

  const keep: Array<{ pollutant: string; startedAt: Date }> = [];

  for (const candidate of candidates) {
    const { key, kind } = candidate;
    const def = POLLUTANTS[key];
    const eventDays = candidate.days;
    const firstDay = eventDays[0]!;
    const lastDay = eventDays[eventDays.length - 1]!;

    const baselineDays = days
      .filter(
        (d) =>
          d.start < firstDay.start &&
          d.start.getTime() >= firstDay.start.getTime() - 8 * DAY_MS &&
          (d.details.pollutants[key].index ?? 0) < ELEVATED_INDEX
      )
      .slice(-7)
      .map((d) => d.details);

    const eventHours = hourly.filter((h) => h.hourStart >= firstDay.start && h.hourStart < lastDay.end);
    const analysis = explainCauses({ key, days: eventDays.map((d) => d.details), baselineDays, hourly: eventHours, timeZone });

    const peakIndex =
      kind === "spike"
        ? eventDays[0]!.details.pollutants[key].maxHourlyIndex ?? 0
        : Math.max(...eventDays.map((d) => d.details.pollutants[key].index ?? 0));
    const category = categoryFor(peakIndex);
    const tier = tierFor(category) ?? "usg";

    const values = eventDays.map((d) =>
      kind === "spike" ? d.details.pollutants[key].maxHourly : d.details.pollutants[key].indexValue
    );
    const numeric = values.filter((v): v is number => v != null);
    const peakValue = numeric.length ? Math.max(...numeric) : null;
    const averageValue = numeric.length ? numeric.reduce((a, b) => a + b, 0) / numeric.length : null;

    const spikeHour = kind === "spike" ? findSpikeHour(eventHours, key, timeZone) ?? candidate.spikeHour ?? null : null;
    const startedAt =
      kind === "spike" && spikeHour != null
        ? new Date(firstDay.start.getTime() + spikeHour * HOUR_MS)
        : candidate.startedAt;

    const active = lastDay.start >= yesterdayStart;
    const n = eventDays.length;
    const title =
      kind === "spike"
        ? `Short ${def.label} spike (${category.label})${spikeHour != null ? ` around ${formatHourLabel(spikeHour)}` : ""}`
        : n === 1
          ? `${def.label} reached ${category.label} for a day`
          : `${def.label} ${category.label} for ${n} consecutive days`;

    const threshold = elevatedThreshold(key);
    const description =
      kind === "spike"
        ? `An hourly average of ${fmt(peakValue, def.unit)} reached ${category.label} (index ${peakIndex}) even though the daily average stayed below the alert level.`
        : `The ${def.aqiPeriod === "8h" ? "highest 8-hour" : "24-hour"} average reached ${fmt(peakValue, def.unit)} (index ${peakIndex}, ${category.label}), above the ${fmt(threshold, def.unit)} level where sensitive groups are affected.` +
          (n >= 2 ? ` It stayed elevated for ${n} consecutive days.` : "");

    const evidence: EventEvidence = {
      kind,
      days: eventDays.map((d) => {
        const p = d.details.pollutants[key];
        return {
          day: d.details.day,
          avg: p.avg,
          indexValue: p.indexValue,
          index: p.index,
          category: p.category,
          validHours: p.validHours,
          valid: p.valid
        };
      }),
      peakIndex,
      ...(spikeHour != null ? { spikeHourLabel: formatHourLabel(spikeHour) } : {}),
      ...analysis.evidence
    };

    const data = {
      severity: category.key,
      status: active ? "ACTIVE" : "RESOLVED",
      lastSeenAt: new Date(Math.min(lastDay.end.getTime(), now.getTime())),
      endedAt: active ? null : lastDay.end,
      peakValue,
      averageValue,
      thresholdValue: threshold,
      unit: def.unit,
      consecutiveDays: kind === "spike" ? 0 : n,
      title,
      description,
      possibleCauses: { findings: analysis.findings, likelySources: analysis.likelySources } as Prisma.InputJsonValue,
      healthEffects: def.healthEffects[tier] as Prisma.InputJsonValue,
      affectedGroups: def.affectedGroups as Prisma.InputJsonValue,
      recommendations: {
        public: def.whatToDo[tier],
        menro: [...menroTierActions(category.key), ...def.menroActions],
        cautionary: category.cautionary
      } as Prisma.InputJsonValue,
      evidence: evidence as unknown as Prisma.InputJsonValue
    };

    await prisma.pollutionEvent.upsert({
      where: { deviceId_pollutant_startedAt: { deviceId, pollutant: key, startedAt } },
      create: { deviceId, pollutant: key, startedAt, ...data },
      update: data
    });
    keep.push({ pollutant: key, startedAt });
  }

  // Remove events that no longer match the data (for example a provisional day that settled lower).
  await prisma.pollutionEvent.deleteMany({
    where: {
      deviceId,
      NOT: { OR: keep.map((k) => ({ pollutant: k.pollutant, startedAt: k.startedAt })) }
    }
  });

  return keep.length;
}

function findSpikeHour(hours: HourlyAverage[], key: PollutantKey, timeZone: string): number | null {
  let best: { hour: number; value: number } | null = null;
  for (const row of hours) {
    const avg = hourStats(row, key).avg;
    if (avg == null || (pollutantIndex(key, avg) ?? 0) < SPIKE_INDEX) continue;
    if (!best || avg > best.value) best = { hour: zonedHour(row.hourStart, timeZone), value: avg };
  }
  return best?.hour ?? null;
}

/** LGU/MENRO actions that scale with the severity of the category. */
export function menroTierActions(categoryKey: string): string[] {
  const actions: Record<string, string[]> = {
    fair: ["Keep monitoring; no public advisory needed yet"],
    usg: [
      "Issue a public advisory for sensitive groups through barangay channels and the LGU social media page",
      "Notify the Municipal Health Office"
    ],
    "very-unhealthy": [
      "Issue a public health advisory to all residents",
      "Advise schools to move physical activities indoors",
      "Intensify enforcement against open burning and smoke-belching"
    ],
    "acutely-unhealthy": [
      "Recommend suspension of outdoor classes and events (coordinate with DepEd and the LGU)",
      "Recommend restricting vehicle use and curtailing industrial activity near the station",
      "Coordinate with DENR-EMB Region IV-A and the MDRRMO"
    ],
    emergency: [
      "Activate the MDRRMO and recommend an air pollution emergency declaration",
      "Advise everyone to stay indoors; restrict vehicles to emergency use",
      "Request DENR-EMB Region IV-A to verify readings and lead the response"
    ]
  };
  return actions[categoryKey] ?? [];
}

export function categoryRank(key: string | null): number {
  return CATEGORIES.findIndex((c) => c.key === key);
}

function fmt(value: number | null, unit: string): string {
  if (value == null) return "—";
  const digits = Math.abs(value) >= 100 ? 0 : Math.abs(value) >= 10 ? 1 : 2;
  return `${value.toFixed(digits)} ${unit}`;
}

export type { PollutionEvent };
