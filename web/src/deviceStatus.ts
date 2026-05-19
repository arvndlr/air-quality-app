import type { Measurement } from "./api";

const ONLINE_WINDOW_MS = 5 * 60 * 1000;

export function isMeasurementOnline(measurement: Measurement | null, now = Date.now()) {
  if (!measurement?.ts) return false;
  return now - new Date(measurement.ts).getTime() < ONLINE_WINDOW_MS;
}

export function formatDurationCompact(totalSeconds: number | null | undefined) {
  if (totalSeconds == null || !Number.isFinite(totalSeconds) || totalSeconds < 0) return "\u2014";

  const seconds = Math.floor(totalSeconds);
  const days = Math.floor(seconds / 86400);
  const hours = Math.floor((seconds % 86400) / 3600);
  const minutes = Math.floor((seconds % 3600) / 60);
  const secs = seconds % 60;

  if (days > 0) return `${days}d ${hours}h`;
  if (hours > 0) return `${hours}h ${minutes}m`;
  if (minutes > 0) return `${minutes}m ${secs}s`;
  return `${secs}s`;
}

export function formatResetReason(reason: string | null | undefined) {
  if (!reason) return "\u2014";
  return reason
    .split("-")
    .map((part) => part.charAt(0).toUpperCase() + part.slice(1))
    .join(" ");
}

export function getSo2StatusSummary(measurement: Measurement | null | undefined) {
  if (!measurement) return { label: "\u2014", detail: null as string | null };

  if (measurement.so2Status === "warming") {
    const remaining = formatDurationCompact(measurement.so2WarmupRemainingSec);
    return {
      label: "Warming",
      detail: remaining === "\u2014" ? null : `${remaining} left`
    };
  }

  if (measurement.so2Status === "calibrating") {
    const progress =
      measurement.so2BaselineProgress != null && measurement.so2BaselineTarget != null
        ? `${measurement.so2BaselineProgress}/${measurement.so2BaselineTarget} samples`
        : null;
    return { label: "Calibrating", detail: progress };
  }

  if (measurement.so2Ppb != null || measurement.so2Status === "ok") {
    return {
      label: "Ready",
      detail: measurement.so2Ppb != null ? `${measurement.so2Ppb.toFixed(1)} ppb` : null
    };
  }

  return { label: "\u2014", detail: null as string | null };
}
