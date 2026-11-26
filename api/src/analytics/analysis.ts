import type { HourlyAverage } from "@prisma/client";
import type { DailyDetails } from "./daily.js";
import { APPROACHING_INDEX, POLLUTANTS, type PollutantKey } from "./pollutants.js";
import { hourStats } from "./rollup.js";
import { formatHourLabel, zonedHour } from "./time.js";

export type CauseFinding = {
  text: string;
  /** "data": derived from this station's readings. "caveat": a data-quality note. */
  basis: "data" | "caveat";
};

export type CauseAnalysis = {
  findings: CauseFinding[];
  likelySources: string[];
  evidence: {
    baselineAvg: number | null;
    eventAvg: number | null;
    increasePct: number | null;
    peakHour: number | null;
    peakHourLabel: string | null;
    timeOfDay: TimeOfDay | null;
    pm25ToPm10Ratio: number | null;
    rhAvg: number | null;
    coElevated: PollutantKey[];
  };
};

type TimeOfDay = "morning-rush" | "midday" | "evening-rush" | "night";

function timeOfDay(hour: number): TimeOfDay {
  if (hour >= 5 && hour <= 9) return "morning-rush";
  if (hour >= 10 && hour <= 15) return "midday";
  if (hour >= 16 && hour <= 20) return "evening-rush";
  return "night";
}

function mean(values: Array<number | null | undefined>): number | null {
  const nums = values.filter((v): v is number => v != null && Number.isFinite(v));
  return nums.length ? nums.reduce((a, b) => a + b, 0) / nums.length : null;
}

function fmt(value: number, unit: string): string {
  const digits = Math.abs(value) >= 100 ? 0 : Math.abs(value) >= 10 ? 1 : 2;
  return `${value.toFixed(digits)} ${unit}`;
}

/**
 * Explains a rise in one pollutant from the station's own data. Every finding is computed
 * from readings; the station can't identify a source, so they're framed as likely causes.
 */
export function explainCauses(params: {
  key: PollutantKey;
  days: DailyDetails[];
  baselineDays: DailyDetails[];
  hourly: HourlyAverage[];
  timeZone: string;
}): CauseAnalysis {
  const { key, days, baselineDays, hourly, timeZone } = params;
  const def = POLLUTANTS[key];
  const findings: CauseFinding[] = [];
  const sources: string[] = [];

  const eventAvg = mean(days.map((d) => d.pollutants[key].indexValue));
  const baselineAvg = mean(baselineDays.map((d) => d.pollutants[key].avg));
  let increasePct: number | null = null;

  if (eventAvg != null && baselineAvg != null && baselineAvg > 0) {
    increasePct = Math.round(((eventAvg - baselineAvg) / baselineAvg) * 100);
    const factor = eventAvg / baselineAvg;
    findings.push({
      basis: "data",
      text:
        factor >= 1.5
          ? `The average of ${fmt(eventAvg, def.unit)} is ${factor.toFixed(1)}× this station's typical level of ${fmt(baselineAvg, def.unit)} (previous 7 days), so a new or stronger source was active.`
          : `The average of ${fmt(eventAvg, def.unit)} is ${increasePct}% above the previous 7 days (${fmt(baselineAvg, def.unit)}), so levels were already high and rose further.`
    });
  }

  // Time-of-day profile: mean hourly average for each local hour across the event.
  const byHour = new Map<number, number[]>();
  for (const row of hourly) {
    const stats = hourStats(row, key);
    if (stats.avg == null) continue;
    const hour = zonedHour(row.hourStart, timeZone);
    byHour.set(hour, [...(byHour.get(hour) ?? []), stats.avg]);
  }
  let peakHour: number | null = null;
  let peakValue = -Infinity;
  for (const [hour, values] of byHour) {
    const m = mean(values)!;
    if (m > peakValue) {
      peakValue = m;
      peakHour = hour;
    }
  }
  const tod = peakHour == null ? null : timeOfDay(peakHour);

  if (peakHour != null && tod) {
    const at = `around ${formatHourLabel(peakHour)}`;
    const combustion = key === "pm25" || key === "co" || key === "no2" || key === "voc";
    if (tod === "morning-rush" || tod === "evening-rush") {
      findings.push({
        basis: "data",
        text: `Levels peak ${at}, during ${tod === "morning-rush" ? "the morning" : "the evening"} rush hour, which points to vehicle exhaust from nearby roads.`
      });
      sources.push("Vehicle exhaust during rush hours");
    } else if (tod === "night") {
      findings.push({
        basis: "data",
        text: `Levels peak ${at}. At night the air is calm and the mixing layer is low, so smoke from household cooking, open burning or idling engines stays near the ground.`
      });
      sources.push(combustion || key === "pm10" ? "Night-time open burning or household burning" : "Calm night-time air trapping local emissions");
    } else if (key === "pm10") {
      findings.push({
        basis: "data",
        text: `Levels peak ${at}, when construction, hauling and road traffic raise the most dust and dry surfaces release it.`
      });
      sources.push("Construction, hauling and road dust during working hours");
    } else if (key === "so2") {
      findings.push({
        basis: "data",
        text: `Levels peak ${at}. Midday SO2 usually comes from industrial combustion, or a volcanic plume carried by daytime winds.`
      });
      sources.push("Industrial fuel burning or a volcanic plume carried by daytime winds");
    } else {
      findings.push({ basis: "data", text: `Levels peak ${at}, during daytime activity near the station.` });
    }
  }

  // PM2.5/PM10 ratio separates smoke (fine) from dust (coarse).
  let ratio: number | null = null;
  if (key === "pm25" || key === "pm10") {
    const pm25 = mean(days.map((d) => d.pollutants.pm25.avg));
    const pm10 = mean(days.map((d) => d.pollutants.pm10.avg));
    if (pm25 != null && pm10 != null && pm10 > 0) {
      ratio = Number((pm25 / pm10).toFixed(2));
      if (ratio >= 0.6) {
        findings.push({
          basis: "data",
          text: `PM2.5 makes up ${Math.round(ratio * 100)}% of PM10, so most particles are fine combustion particles (smoke or exhaust) rather than dust.`
        });
        sources.push("Combustion smoke (burning, exhaust)");
      } else if (ratio <= 0.4) {
        findings.push({
          basis: "data",
          text: `PM2.5 is only ${Math.round(ratio * 100)}% of PM10, so most particles are coarse dust (roads, construction, soil) rather than smoke.`
        });
        sources.push("Coarse dust from roads, construction or soil");
      }
    }
  }

  // Pollutants that rose together share a source.
  const coElevated = (Object.keys(POLLUTANTS) as PollutantKey[]).filter(
    (other) =>
      other !== key &&
      days.some((d) => (d.pollutants[other].index ?? 0) >= APPROACHING_INDEX)
  );
  if (coElevated.length > 0) {
    const labels = coElevated.map((k) => POLLUTANTS[k].label).join(", ");
    let reason = "which suggests a shared source.";
    if (coElevated.includes("co") || coElevated.includes("no2")) {
      reason = "a combination typical of combustion (traffic or burning).";
      sources.push("Combustion (traffic or burning)");
    } else if (coElevated.includes("so2") && key !== "so2") {
      reason = "a combination typical of fuel-oil or coal burning, or volcanic smog.";
    } else if (coElevated.includes("co2") || coElevated.includes("voc")) {
      reason = "which suggests poor ventilation or activity close to the sensor.";
    }
    findings.push({ basis: "data", text: `${labels} ${coElevated.length === 1 ? "was" : "were"} also high on the same days, ${reason}` });
  }

  // Humidity: low-cost optical PM sensors over-read in very humid air or fog.
  const rhAvg = mean(hourly.map((h) => h.rhAvg));
  if ((key === "pm25" || key === "pm10") && rhAvg != null && rhAvg >= 85) {
    findings.push({
      basis: "caveat",
      text: `Relative humidity averaged ${Math.round(rhAvg)}%. Optical PM sensors can over-read in very humid air or fog, so confirm with other stations before issuing an advisory.`
    });
  }
  if (POLLUTANTS[key].basis === "denr-estimated" || key === "no2") {
    findings.push({
      basis: "caveat",
      text: `${def.label} is estimated by an uncalibrated MiCS-6814 sensor. Treat it as an early warning and confirm with a reference analyzer.`
    });
  }

  if (findings.filter((f) => f.basis === "data").length === 0) {
    findings.push({
      basis: "data",
      text: "There isn't enough hourly data around this event to pin down a pattern; the typical sources below are the usual suspects."
    });
  }

  const likelySources = [...new Set([...sources, ...def.sources])].slice(0, 5);

  return {
    findings,
    likelySources,
    evidence: {
      baselineAvg: baselineAvg == null ? null : Number(baselineAvg.toFixed(2)),
      eventAvg: eventAvg == null ? null : Number(eventAvg.toFixed(2)),
      increasePct,
      peakHour,
      peakHourLabel: peakHour == null ? null : formatHourLabel(peakHour),
      timeOfDay: tod,
      pm25ToPm10Ratio: ratio,
      rhAvg: rhAvg == null ? null : Math.round(rhAvg),
      coElevated
    }
  };
}
