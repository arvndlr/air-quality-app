import { Prisma, type PollutionEvent } from "@prisma/client";
import { prisma } from "../prisma.js";
import { CATEGORIES, categoryFor, subIndexDetail, type CategoryInfo } from "./denr.js";
import { dailyDetails, loadDailySummaries, type DailyDetails } from "./daily.js";
import { categoryRank, menroTierActions, type EventEvidence } from "./events.js";
import {
  APPROACHING_INDEX,
  ELEVATED_INDEX,
  POLLUTANT_KEYS,
  POLLUTANTS,
  elevatedThreshold,
  pollutantIndex,
  tierFor,
  type IndexBasis,
  type PollutantKey
} from "./pollutants.js";
import { MIN_MINUTES_PER_HOUR, RAW_COLUMNS } from "./rollup.js";
import { HOUR_MS, startOfHour, startOfZonedYear, zonedDateKey, zonedParts } from "./time.js";
import { indexHours, isRepresentative8h, isRepresentativeDay, windowStats } from "./windows.js";

export type RollingPeriod = "1h" | "8h" | "24h";

export type PeriodCell = {
  avg: number | null;
  index: number | null;
  category: CategoryInfo["key"] | null;
  /** Meets the DENR 75% data-capture rule for this averaging period. */
  valid: boolean;
  /** This is the averaging period DENR uses for the pollutant's AQI or guideline. */
  regulatory: boolean;
  capture: { have: number; need: number; of: number; unit: "minutes" | "hours" };
};

export type AnnualCell = {
  avg: number | null;
  method: "geometric" | "arithmetic";
  representativeQuarters: number;
  quartersWithData: number;
  validDays: number;
  guideline: number | null;
  exceedsGuideline: boolean | null;
  valid: boolean;
};

const AQI_KEYS: PollutantKey[] = ["pm25", "pm10", "so2"];

function round(value: number | null, digits = 2): number | null {
  return value == null ? null : Number(value.toFixed(digits));
}

function cell(key: PollutantKey, avg: number | null, valid: boolean, regulatory: boolean, capture: PeriodCell["capture"]): PeriodCell {
  const index = pollutantIndex(key, avg);
  return {
    avg: round(avg, 3),
    index,
    category: index == null ? null : categoryFor(index).key,
    valid,
    regulatory,
    capture
  };
}

/** 1-hour averages straight from raw readings (the current hour isn't rolled up yet). */
async function lastHourRaw(deviceId: string, now: Date) {
  const selects = POLLUTANT_KEYS.map((k) => {
    const { column, valid } = RAW_COLUMNS[k];
    return `avg(${column}) FILTER (WHERE ${valid})::float AS "${k}Avg", count(DISTINCT date_trunc('minute', "ts")) FILTER (WHERE ${valid})::int AS "${k}Minutes"`;
  }).join(", ");
  const [row] = await prisma.$queryRaw<Array<Record<string, number | null>>>(Prisma.sql`
    SELECT ${Prisma.raw(selects)}
    FROM "Measurement"
    WHERE "deviceId" = ${deviceId} AND "ts" > ${new Date(now.getTime() - HOUR_MS)} AND "ts" <= ${now}
  `);
  return row ?? {};
}

export async function rollingWindows(deviceId: string, now: Date) {
  const nowMs = now.getTime();
  const currentHour = startOfHour(now).getTime();
  const hourly = await prisma.hourlyAverage.findMany({
    where: { deviceId, hourStart: { gte: new Date(currentHour - 24 * HOUR_MS) } }
  });
  const index = indexHours(hourly);
  const raw = await lastHourRaw(deviceId, now);

  const result = {} as Record<PollutantKey, Record<RollingPeriod, PeriodCell>>;

  for (const key of POLLUTANT_KEYS) {
    const def = POLLUTANTS[key];
    const official = def.basis !== "indicator";
    const minutes = Number(raw[`${key}Minutes`] ?? 0);
    const s8 = windowStats(index, key, currentHour - 7 * HOUR_MS, 8, nowMs);
    const s24 = windowStats(index, key, currentHour - 23 * HOUR_MS, 24, nowMs);

    result[key] = {
      "1h": cell(key, (raw[`${key}Avg`] as number | null) ?? null, minutes >= MIN_MINUTES_PER_HOUR, false, {
        have: minutes,
        need: MIN_MINUTES_PER_HOUR,
        of: 60,
        unit: "minutes"
      }),
      "8h": cell(key, s8.avg, isRepresentative8h(s8), official && def.aqiPeriod === "8h", {
        have: s8.validHours,
        need: 6,
        of: 8,
        unit: "hours"
      }),
      "24h": cell(key, s24.avg, isRepresentativeDay(s24), official && def.aqiPeriod === "24h", {
        have: s24.validHours,
        need: 18,
        of: 24,
        unit: "hours"
      })
    };
  }

  return result;
}

/**
 * Annual mean for the current calendar year (DENR manual §1.3–1.4, §2.1): monthly data is
 * representative with 75% of days, a quarter with three representative months; PM uses the
 * geometric mean of quarterly means, other pollutants the arithmetic mean.
 */
function annualCell(key: PollutantKey, days: Array<{ start: Date; details: DailyDetails }>, timeZone: string): AnnualCell {
  const def = POLLUTANTS[key];
  const byMonth = new Map<number, number[]>();
  const quarterValues = new Map<number, number[]>();
  let validDays = 0;

  for (const day of days) {
    const p = day.details.pollutants[key];
    if (!p.valid || p.avg == null) continue;
    validDays++;
    const month = zonedParts(day.start, timeZone).month;
    byMonth.set(month, [...(byMonth.get(month) ?? []), p.avg]);
    const quarter = Math.ceil(month / 3);
    quarterValues.set(quarter, [...(quarterValues.get(quarter) ?? []), p.avg]);
  }

  const year = days[0] ? zonedParts(days[0].start, timeZone).year : new Date().getFullYear();
  const representativeMonth = (month: number) => {
    const daysInMonth = new Date(Date.UTC(year, month, 0)).getUTCDate();
    return (byMonth.get(month)?.length ?? 0) >= Math.round(daysInMonth * 0.75);
  };

  const quarterMeans: number[] = [];
  let representativeQuarters = 0;
  for (const [quarter, values] of quarterValues) {
    quarterMeans.push(values.reduce((a, b) => a + b, 0) / values.length);
    const months = [quarter * 3 - 2, quarter * 3 - 1, quarter * 3];
    if (months.every(representativeMonth)) representativeQuarters++;
  }

  let avg: number | null = null;
  if (quarterMeans.length > 0) {
    avg =
      def.annualMean === "geometric" && quarterMeans.every((v) => v > 0)
        ? Math.exp(quarterMeans.reduce((a, v) => a + Math.log(v), 0) / quarterMeans.length)
        : quarterMeans.reduce((a, b) => a + b, 0) / quarterMeans.length;
  }

  const guideline = def.guidelines.find((g) => g.period === "annual")?.value ?? null;
  return {
    avg: round(avg, 3),
    method: def.annualMean,
    representativeQuarters,
    quartersWithData: quarterMeans.length,
    validDays,
    guideline,
    exceedsGuideline: avg == null || guideline == null ? null : avg > guideline,
    valid: representativeQuarters === 4
  };
}

export type EventDto = {
  id: number;
  pollutant: PollutantKey;
  pollutantLabel: string;
  basis: IndexBasis;
  severity: string;
  severityLabel: string;
  color: string;
  status: string;
  kind: "sustained" | "spike";
  persistent: boolean;
  startedAt: string;
  lastSeenAt: string;
  endedAt: string | null;
  consecutiveDays: number;
  peakValue: number | null;
  averageValue: number | null;
  thresholdValue: number | null;
  unit: string | null;
  title: string;
  description: string;
  possibleCauses: { findings: Array<{ text: string; basis: string }>; likelySources: string[] } | null;
  healthEffects: string[];
  affectedGroups: string[];
  recommendations: { public: string[]; menro: string[]; cautionary: string } | null;
  evidence: EventEvidence | null;
};

export function eventDto(event: PollutionEvent): EventDto {
  const category = CATEGORIES.find((c) => c.key === event.severity) ?? categoryFor(101);
  const evidence = event.evidence as unknown as EventEvidence | null;
  const key = event.pollutant as PollutantKey;
  return {
    id: event.id,
    pollutant: key,
    pollutantLabel: POLLUTANTS[key]?.label ?? event.pollutant,
    basis: POLLUTANTS[key]?.basis ?? "indicator",
    severity: category.key,
    severityLabel: category.label,
    color: category.color,
    status: event.status,
    kind: evidence?.kind ?? "sustained",
    persistent: event.consecutiveDays >= 2,
    startedAt: event.startedAt.toISOString(),
    lastSeenAt: event.lastSeenAt.toISOString(),
    endedAt: event.endedAt?.toISOString() ?? null,
    consecutiveDays: event.consecutiveDays,
    peakValue: round(event.peakValue),
    averageValue: round(event.averageValue),
    thresholdValue: event.thresholdValue,
    unit: event.unit,
    title: event.title,
    description: event.description,
    possibleCauses: event.possibleCauses as EventDto["possibleCauses"],
    healthEffects: (event.healthEffects as string[] | null) ?? [],
    affectedGroups: (event.affectedGroups as string[] | null) ?? [],
    recommendations: event.recommendations as EventDto["recommendations"],
    evidence
  };
}

function sortEvents(a: EventDto, b: EventDto) {
  if (a.status !== b.status) return a.status === "ACTIVE" ? -1 : 1;
  const sev = categoryRank(b.severity) - categoryRank(a.severity);
  if (sev !== 0) return sev;
  return b.startedAt.localeCompare(a.startedAt);
}

function fmtValue(value: number | null, unit: string) {
  if (value == null) return "—";
  const digits = Math.abs(value) >= 100 ? 0 : Math.abs(value) >= 10 ? 1 : 2;
  return `${value.toFixed(digits)} ${unit}`;
}

export async function buildOverview(params: {
  device: { id: string; externalId: string; name: string | null };
  from: Date;
  to: Date;
  timeZone: string;
  now?: Date;
}) {
  const { device, from, to, timeZone } = params;
  const now = params.now ?? new Date();

  const [rolling, yearSummaries, rangeSummaries, rangeEvents, activeEvents, lastSample] = await Promise.all([
    rollingWindows(device.id, now),
    loadDailySummaries(device.id, startOfZonedYear(now, timeZone)),
    loadDailySummaries(device.id, from, to),
    prisma.pollutionEvent.findMany({
      where: { deviceId: device.id, startedAt: { lt: to }, OR: [{ endedAt: null }, { endedAt: { gte: from } }] },
      orderBy: { startedAt: "desc" }
    }),
    prisma.pollutionEvent.findMany({ where: { deviceId: device.id, status: "ACTIVE" }, orderBy: { startedAt: "desc" } }),
    prisma.measurement.findFirst({ where: { deviceId: device.id }, orderBy: { ts: "desc" }, select: { ts: true } })
  ]);

  const yearDays = yearSummaries
    .map((s) => ({ start: s.windowStart, details: dailyDetails(s) }))
    .filter((d): d is { start: Date; details: DailyDetails } => d.details != null);

  // ---- Pollutant table -------------------------------------------------------------
  const pollutants = POLLUTANT_KEYS.map((key) => {
    const def = POLLUTANTS[key];
    return {
      key,
      label: def.label,
      unit: def.unit,
      basis: def.basis as IndexBasis,
      aqiPeriod: def.basis === "indicator" ? null : def.aqiPeriod,
      guidelines: def.guidelines,
      periods: rolling[key],
      annual: annualCell(key, yearDays, timeZone)
    };
  });

  // ---- Current AQI ------------------------------------------------------------------
  type Pick = { key: PollutantKey; avg: number; index: number; period: RollingPeriod };
  const pick = (period: RollingPeriod, requireValid: boolean): Pick | null => {
    let best: Pick | null = null;
    for (const key of AQI_KEYS) {
      const c = rolling[key][period];
      if (c.avg == null || c.index == null || (requireValid && !c.valid)) continue;
      if (!best || c.index > best.index) best = { key, avg: c.avg, index: c.index, period };
    }
    return best;
  };
  const official = pick("24h", true);
  const fallback = official ?? pick("24h", false) ?? pick("1h", false);
  const basis = official
    ? "24-hour average"
    : fallback?.period === "24h"
      ? "24-hour average (provisional: under 75% data capture)"
      : fallback
        ? "1-hour average (indicative)"
        : null;
  const detail = fallback ? subIndexDetail(POLLUTANTS[fallback.key].aqiPollutant!, fallback.avg) : null;
  const currentCategory = detail?.category ?? null;

  const current = {
    aqi: detail?.subIndex ?? null,
    category: currentCategory?.key ?? null,
    categoryLabel: currentCategory?.label ?? null,
    color: currentCategory?.color ?? null,
    official: official != null,
    basis,
    dominantPollutant: fallback?.key ?? null,
    dominantLabel: fallback ? POLLUTANTS[fallback.key].label : null,
    dominantValue: fallback ? round(fallback.avg) : null,
    dominantUnit: fallback ? POLLUTANTS[fallback.key].unit : null,
    lastSampleAt: lastSample?.ts.toISOString() ?? null,
    computation: detail
      ? {
          pollutant: fallback!.key,
          label: POLLUTANTS[fallback!.key].label,
          averaging: detail.averaging,
          sensorValue: round(fallback!.avg, 3),
          sensorUnit: POLLUTANTS[fallback!.key].unit,
          cp: detail.cp,
          unit: detail.unit,
          bpLo: detail.bpLo,
          bpHi: detail.bpHi,
          iLo: detail.iLo,
          iHi: detail.iHi,
          exact: detail.exact,
          subIndex: detail.subIndex
        }
      : null
  };

  // ---- Daily trend for the selected range --------------------------------------------
  const rangeDays = rangeSummaries
    .map((s) => ({ summary: s, details: dailyDetails(s) }))
    .filter((d): d is { summary: (typeof rangeSummaries)[number]; details: DailyDetails } => d.details != null);

  const trend = rangeDays.map(({ summary, details }) => ({
    day: details.day,
    aqi: summary.aqi,
    category: summary.aqi == null ? null : categoryFor(summary.aqi).key,
    valid: summary.isValid,
    provisional: details.provisional,
    dominantPollutant: summary.dominantPollutant,
    samples: summary.sampleCount,
    indices: Object.fromEntries(POLLUTANT_KEYS.map((k) => [k, details.pollutants[k].index])) as Record<PollutantKey, number | null>,
    averages: Object.fromEntries(POLLUTANT_KEYS.map((k) => [k, details.pollutants[k].avg])) as Record<PollutantKey, number | null>
  }));

  const samplesInRange = rangeSummaries.reduce((sum, s) => sum + s.sampleCount, 0);

  // ---- Top pollutants in the range ---------------------------------------------------
  const ranking = POLLUTANT_KEYS.map((key) => {
    let peak: { index: number; day: string; value: number | null } | null = null;
    const values: number[] = [];
    let elevatedDays = 0;
    for (const { details } of rangeDays) {
      const p = details.pollutants[key];
      if (p.index == null) continue;
      if (p.indexValue != null) values.push(p.indexValue);
      if (p.index >= ELEVATED_INDEX) elevatedDays++;
      if (!peak || p.index > peak.index) peak = { index: p.index, day: details.day, value: p.indexValue };
    }
    if (!peak) return null;
    const category = categoryFor(peak.index);
    return {
      key,
      label: POLLUTANTS[key].label,
      unit: POLLUTANTS[key].unit,
      basis: POLLUTANTS[key].basis,
      peakIndex: peak.index,
      peakDay: peak.day,
      peakValue: round(peak.value),
      average: round(values.length ? values.reduce((a, b) => a + b, 0) / values.length : null),
      elevatedDays,
      category: category.key,
      categoryLabel: category.label,
      color: category.color
    };
  })
    .filter((r): r is NonNullable<typeof r> => r != null)
    .sort((a, b) => b.peakIndex - a.peakIndex || b.elevatedDays - a.elevatedDays);
  const topPollutants = ranking.slice(0, 3).map((r, i) => ({ rank: i + 1, ...r }));

  // ---- Events and alerts -------------------------------------------------------------
  const events = rangeEvents.map(eventDto).sort(sortEvents);
  const activeAlerts = activeEvents.map(eventDto).sort(sortEvents);

  // ---- Insights: what's approaching or rising right now -------------------------------
  const insights: Array<{ level: "info" | "watch" | "warning"; pollutant: PollutantKey | null; title: string; detail: string }> = [];
  for (const key of POLLUTANT_KEYS) {
    const def = POLLUTANTS[key];
    const period: RollingPeriod = def.aqiPeriod === "8h" ? "8h" : "24h";
    const c = rolling[key][period];
    const oneHour = rolling[key]["1h"];
    const threshold = elevatedThreshold(key);

    if (c.index != null && c.index >= APPROACHING_INDEX && c.index < ELEVATED_INDEX && threshold != null && c.avg != null) {
      insights.push({
        level: "watch",
        pollutant: key,
        title: `${def.label} is approaching the alert level`,
        detail: `The ${period === "8h" ? "8-hour" : "24-hour"} average is ${fmtValue(c.avg, def.unit)} (index ${c.index}, Fair), ${Math.round((c.avg / threshold) * 100)}% of the ${fmtValue(threshold, def.unit)} level where sensitive groups are affected.`
      });
    }

    if (
      oneHour.avg != null &&
      c.avg != null &&
      c.avg > 0 &&
      oneHour.avg >= c.avg * 1.5 &&
      (oneHour.index ?? 0) >= 51
    ) {
      insights.push({
        level: (oneHour.index ?? 0) >= ELEVATED_INDEX ? "warning" : "watch",
        pollutant: key,
        title: `${def.label} is rising quickly`,
        detail: `The last hour averaged ${fmtValue(oneHour.avg, def.unit)}, ${(oneHour.avg / c.avg).toFixed(1)}× the ${period === "8h" ? "8-hour" : "24-hour"} average. A nearby source may have just started.`
      });
    }
  }
  const pm24 = rolling.pm25["24h"];
  if (!pm24.valid && pm24.capture.have > 0) {
    insights.push({
      level: "info",
      pollutant: null,
      title: "24-hour averages are provisional",
      detail: `Only ${pm24.capture.have} of the last 24 hours have at least 45 minutes of PM2.5 data. DENR requires 18 representative hours for a valid daily average.`
    });
  }

  // ---- Narrative summary ------------------------------------------------------------
  const dailyAqis = trend.filter((t) => t.aqi != null);
  const worst = dailyAqis.reduce<(typeof trend)[number] | null>((w, t) => (!w || t.aqi! > w.aqi! ? t : w), null);
  const avgAqi = dailyAqis.length ? Math.round(dailyAqis.reduce((a, t) => a + t.aqi!, 0) / dailyAqis.length) : null;
  const elevatedDayCount = dailyAqis.filter((t) => t.aqi! >= ELEVATED_INDEX).length;
  // Health guidance only comes from DENR-calibrated pollutants; estimated (MiCS) and indicator
  // readings are listed separately so an uncalibrated sensor can't trigger alarming advice.
  const concerning = ranking.filter((p) => p.peakIndex > 50 && p.basis === "denr").slice(0, 3);
  const unverified = ranking.filter((p) => p.peakIndex >= ELEVATED_INDEX && p.basis !== "denr");
  const persistent = events.filter((e) => e.persistent);

  const fromLabel = zonedDateKey(from, timeZone);
  const toLabel = zonedDateKey(new Date(Math.min(to.getTime(), now.getTime()) - 1), timeZone);
  let text: string;
  if (!worst || avgAqi == null) {
    text = `No daily averages are available between ${fromLabel} and ${toLabel} yet.`;
  } else {
    const avgCat = categoryFor(avgAqi);
    const worstCat = categoryFor(worst.aqi!);
    text = `From ${fromLabel} to ${toLabel}, the daily AQI averaged ${avgAqi} (${avgCat.label}) and peaked at ${worst.aqi} (${worstCat.label}) on ${worst.day}.`;
    if (concerning.length) text += ` The pollutants that rose the most were ${concerning.map((p) => p.label).join(", ")}.`;
    text +=
      elevatedDayCount > 0
        ? ` ${elevatedDayCount} day${elevatedDayCount === 1 ? "" : "s"} reached Unhealthy for Sensitive Groups or worse.`
        : " No day reached Unhealthy for Sensitive Groups.";
    if (unverified.length) {
      text += ` Estimated or indicator sensors also read high (${unverified
        .map((p) => `${p.label}: ${p.categoryLabel}`)
        .join(", ")}); confirm these with calibrated instruments before acting on them.`;
    }
    const persistentOfficial = persistent.filter((e) => e.basis === "denr");
    if (persistentOfficial.length) {
      text += ` Sustained episodes: ${persistentOfficial
        .slice(0, 3)
        .map((e) => `${e.pollutantLabel} for ${e.consecutiveDays} days (${e.severityLabel})`)
        .join("; ")}.`;
    }
  }

  const healthEffects = concerning
    .map((p) => {
      const tier = tierFor(categoryFor(p.peakIndex));
      return tier ? { pollutant: p.key, label: p.label, category: p.categoryLabel, effects: POLLUTANTS[p.key].healthEffects[tier] } : null;
    })
    .filter((h): h is NonNullable<typeof h> => h != null);

  const unique = (items: string[]) => [...new Set(items)];
  const whatToDo = unique(
    concerning.flatMap((p) => {
      const tier = tierFor(categoryFor(p.peakIndex));
      return tier ? POLLUTANTS[p.key].whatToDo[tier] : [];
    })
  ).slice(0, 7);
  const elevatedPollutants = concerning.filter((p) => p.peakIndex >= ELEVATED_INDEX);
  const affectedGroups = unique(elevatedPollutants.flatMap((p) => POLLUTANTS[p.key].affectedGroups)).slice(0, 8);
  const worstOfficial = concerning.reduce<CategoryInfo | null>((w, p) => {
    const c = categoryFor(p.peakIndex);
    return !w || c.min > w.min ? c : w;
  }, null);
  const menroActions = unique([
    ...menroTierActions(worstOfficial?.key ?? "good"),
    ...elevatedPollutants.flatMap((p) => POLLUTANTS[p.key].menroActions)
  ]).slice(0, 8);

  // ---- Public advisory draft for MENRO ------------------------------------------------
  const advisoryCategory = currentCategory;
  const officialAlerts = activeAlerts.filter((a) => a.basis === "denr");
  const issued = `${zonedDateKey(now, timeZone)} ${String(zonedParts(now, timeZone).hour).padStart(2, "0")}:${String(zonedParts(now, timeZone).minute).padStart(2, "0")}`;
  const alertLines = officialAlerts.slice(0, 4).map((a) => `- ${a.title}: ${a.description}`);
  const unverifiedAlerts = activeAlerts.filter((a) => a.basis !== "denr");
  const advisoryActions = unique([
    ...(advisoryCategory && advisoryCategory.key !== "good" && advisoryCategory.key !== "fair" ? [advisoryCategory.cautionary] : []),
    ...officialAlerts.flatMap((a) => a.recommendations?.public ?? []),
    ...(current.dominantPollutant && currentCategory ? POLLUTANTS[current.dominantPollutant].whatToDo[tierFor(currentCategory) ?? "fair"] ?? [] : [])
  ]).slice(0, 6);
  const advisoryText = [
    "AIR QUALITY ADVISORY",
    `Station: ${device.name ?? device.externalId} (${device.externalId})`,
    `Issued: ${issued} (${timeZone})`,
    "",
    current.aqi != null
      ? `Air quality is ${current.categoryLabel?.toUpperCase()} (AQI ${current.aqi}, ${current.basis}). Main pollutant: ${current.dominantLabel} at ${fmtValue(current.dominantValue, current.dominantUnit ?? "")}.`
      : "No current AQI is available for this station.",
    ...(alertLines.length ? ["", "Active alerts:", ...alertLines] : []),
    ...(unverifiedAlerts.length
      ? ["", `For verification (estimated or indicator sensors): ${unverifiedAlerts.map((a) => a.title).join("; ")}.`]
      : []),
    ...(advisoryActions.length ? ["", "Recommended actions:", ...advisoryActions.map((a) => `- ${a}`)] : []),
    ...(affectedGroups.length ? ["", `Most at risk: ${affectedGroups.slice(0, 5).join("; ")}.`] : []),
    "",
    "AQI computed with DENR-EMB breakpoints (Procedural Manual, 2021). Readings come from low-cost community sensors and are indicative; CO and NO2 are estimated."
  ].join("\n");

  return {
    device: { externalId: device.externalId, name: device.name },
    generatedAt: now.toISOString(),
    timeZone,
    range: { from: from.toISOString(), to: to.toISOString() },
    categories: CATEGORIES.map(({ key, label, min, max, color, cautionary }) => ({ key, label, min, max, color, cautionary })),
    current,
    samplesInRange,
    pollutants,
    trend,
    topPollutants,
    events,
    activeAlerts,
    insights,
    summary: {
      text,
      unverified: unverified.map(({ key, label, basis, categoryLabel, peakIndex }) => ({ key, label, basis, categoryLabel, peakIndex })),
      averageAqi: avgAqi,
      peakAqi: worst?.aqi ?? null,
      peakDay: worst?.day ?? null,
      elevatedDays: elevatedDayCount,
      healthEffects,
      whatToDo,
      affectedGroups,
      menroActions,
      advisoryText
    }
  };
}

export type AnalyticsOverview = Awaited<ReturnType<typeof buildOverview>>;
