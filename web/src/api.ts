import { resolveApiBaseUrl } from "./runtimeUrls";

export type Device = {
  externalId: string;
  name: string | null;
  createdAt: string;
};

export type Measurement = {
  id: number;
  deviceId: string;
  ts: string;
  tempC: number | null;
  rh: number | null;
  pressureHpa: number | null;
  gasKohm: number | null;
  vocIndex: number | null;
  batteryVoltage: number | null;
  chargerOn: boolean | null;
  uptimeSec: number | null;
  bootCount: number | null;
  resetReason: string | null;
  so2Status: string | null;
  so2WarmupRemainingSec: number | null;
  so2BaselineProgress: number | null;
  so2BaselineTarget: number | null;
  co2ppm: number | null;
  scdTempC: number | null;
  scdRh: number | null;
  pm1ugm3: number | null;
  pm25ugm3: number | null;
  pm10ugm3: number | null;
  so2Vgas: number | null;
  so2Vref: number | null;
  so2Mv: number | null;
  micsNh3V: number | null;
  micsCoV: number | null;
  micsNo2V: number | null;
  so2Ppb: number | null;
  micsCoPpm: number | null;
  micsNo2Ppb: number | null;
  micsNh3Ppm: number | null;
};

export type SeriesPoint = { bucket: string; avg: number | null; min: number | null; max: number | null };

export type TransmissionStatus = "ready" | "warming" | "calibrating" | "unknown";

export type TransmissionRow = {
  id: number;
  ts: string;
  deviceExternalId: string;
  deviceName: string | null;
  transmissionStatus: TransmissionStatus;
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

export type TransmissionHistorySummary = {
  totalRows: number;
  deviceCount: number;
  latestTs: string | null;
  earliestTs: string | null;
  averageGapSec: number | null;
  statusCounts: Record<TransmissionStatus, number>;
};

export type TransmissionPollutantRollup = {
  pm25: number | null;
  pm10: number | null;
  so2: number | null;
  co: number | null;
  no2: number | null;
  co2: number | null;
  voc: number | null;
};

export type TransmissionDailySummary = {
  day: string;
  totalRows: number;
  deviceCount: number;
  firstTs: string | null;
  lastTs: string | null;
  averageGapSec: number | null;
  statusCounts: Record<TransmissionStatus, number>;
  averages: TransmissionPollutantRollup;
  peaks: TransmissionPollutantRollup;
};

export type TransmissionHistoryResponse = {
  filters: {
    deviceId: string | null;
    from: string;
    to: string;
    status: TransmissionStatus | "all";
    timeZone: string;
  };
  summary: TransmissionHistorySummary;
  daily: TransmissionDailySummary[];
  pagination: {
    page: number;
    pageSize: number;
    totalRows: number;
    totalPages: number;
    hasPreviousPage: boolean;
    hasNextPage: boolean;
  };
  rows: TransmissionRow[];
};

/** DENR-EMB AQI. Only PM2.5, PM10 and SO2 set `aqi`; CO is estimated and NO2 has no breakpoints. */
export type AqiResult = {
  aqi: number;
  category: string;
  color: string;
  dominantPollutant: "pm25" | "pm10" | "so2";
  pm25SubIndex: number | null;
  pm10SubIndex: number | null;
  coSubIndex: number | null;
  no2SubIndex: null;
  so2SubIndex: number | null;
};

const API_URL = resolveApiBaseUrl();

export async function listDevices(): Promise<Device[]> {
  const res = await fetch(`${API_URL}/api/v1/devices`);
  if (!res.ok) throw new Error("Failed to load devices");
  const json = (await res.json()) as { devices: Device[] };
  return json.devices;
}

export async function getLatest(deviceId: string): Promise<{ latest: Measurement | null; aqi: AqiResult | null }> {
  const url = new URL(`${API_URL}/api/v1/latest`);
  url.searchParams.set("deviceId", deviceId);
  const res = await fetch(url);
  if (!res.ok) throw new Error("Failed to load latest");
  const json = (await res.json()) as { latest: Measurement | null; aqi: AqiResult | null };
  return json;
}

export async function getSeries(params: {
  deviceId: string;
  metric: string;
  from: string;
  to: string;
  bucket: string;
}): Promise<SeriesPoint[]> {
  const url = new URL(`${API_URL}/api/v1/series`);
  url.searchParams.set("deviceId", params.deviceId);
  url.searchParams.set("metric", params.metric);
  url.searchParams.set("from", params.from);
  url.searchParams.set("to", params.to);
  url.searchParams.set("bucket", params.bucket);
  const res = await fetch(url);
  if (!res.ok) throw new Error("Failed to load series");
  const json = (await res.json()) as { points: SeriesPoint[] };
  return json.points;
}

export type TransmissionQuery = {
  deviceId?: string | null;
  from: string;
  to: string;
  status?: TransmissionStatus | "all";
};

/** Day buckets and export filenames follow the browser's zone so saved logs match what admins see. */
export function getBrowserTimeZone(): string {
  try {
    return Intl.DateTimeFormat().resolvedOptions().timeZone || "UTC";
  } catch {
    return "UTC";
  }
}

function applyTransmissionQuery(url: URL, params: TransmissionQuery) {
  url.searchParams.set("from", params.from);
  url.searchParams.set("to", params.to);
  url.searchParams.set("timeZone", getBrowserTimeZone());

  if (params.deviceId) {
    url.searchParams.set("deviceId", params.deviceId);
  }

  if (params.status) {
    url.searchParams.set("status", params.status);
  }
}

export async function getTransmissionHistory(
  params: TransmissionQuery & { page?: number; pageSize?: number }
): Promise<TransmissionHistoryResponse> {
  const url = new URL(`${API_URL}/api/v1/transmissions`);
  applyTransmissionQuery(url, params);

  if (params.page != null) {
    url.searchParams.set("page", String(params.page));
  }

  if (params.pageSize != null) {
    url.searchParams.set("pageSize", String(params.pageSize));
  }

  const res = await fetch(url);
  if (!res.ok) throw new Error("Failed to load transmission history");
  return (await res.json()) as TransmissionHistoryResponse;
}

export type TransmissionExportMode = "detail" | "daily";

/** Fetches the CSV export and hands it to the browser as a download. */
export async function downloadTransmissionCsv(
  params: TransmissionQuery & { mode?: TransmissionExportMode }
): Promise<void> {
  const mode = params.mode ?? "detail";
  const url = new URL(`${API_URL}/api/v1/transmissions/export`);
  applyTransmissionQuery(url, params);
  url.searchParams.set("mode", mode);

  const res = await fetch(url);
  if (!res.ok) throw new Error("Failed to export the transmission log");

  const blob = await res.blob();
  const objectUrl = URL.createObjectURL(blob);
  const scope = params.deviceId ? params.deviceId.replace(/[^a-zA-Z0-9_-]/g, "-") : "all-devices";
  const stamp = (value: string) => value.slice(0, 19).replace(/[:T]/g, "-");

  const link = document.createElement("a");
  link.href = objectUrl;
  link.download = `transmissions-${mode}-${scope}-${stamp(params.from)}_to_${stamp(params.to)}.csv`;
  document.body.appendChild(link);
  link.click();
  link.remove();
  URL.revokeObjectURL(objectUrl);
}

// ---- Analytics ----------------------------------------------------------------------

export type PollutantKey = "pm25" | "pm10" | "so2" | "co" | "no2" | "co2" | "voc" | "nh3";
export type IndexBasis = "denr" | "denr-estimated" | "guideline" | "indicator";
export type RollingPeriod = "1h" | "8h" | "24h";

export type AnalyticsPeriodCell = {
  avg: number | null;
  index: number | null;
  category: string | null;
  valid: boolean;
  regulatory: boolean;
  capture: { have: number; need: number; of: number; unit: "minutes" | "hours" };
};

export type AnalyticsAnnualCell = {
  avg: number | null;
  method: "geometric" | "arithmetic";
  representativeQuarters: number;
  quartersWithData: number;
  validDays: number;
  guideline: number | null;
  exceedsGuideline: boolean | null;
  valid: boolean;
};

export type AnalyticsPollutantRow = {
  key: PollutantKey;
  label: string;
  unit: string;
  basis: IndexBasis;
  aqiPeriod: "24h" | "8h" | null;
  guidelines: Array<{ period: string; value: number; unit: string; source: string }>;
  periods: Record<RollingPeriod, AnalyticsPeriodCell>;
  annual: AnalyticsAnnualCell;
};

export type AnalyticsEvent = {
  id: number;
  pollutant: PollutantKey;
  pollutantLabel: string;
  basis: IndexBasis;
  severity: string;
  severityLabel: string;
  color: string;
  status: "ACTIVE" | "RESOLVED";
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
  possibleCauses: { findings: Array<{ text: string; basis: "data" | "caveat" }>; likelySources: string[] } | null;
  healthEffects: string[];
  affectedGroups: string[];
  recommendations: { public: string[]; menro: string[]; cautionary: string } | null;
  evidence: {
    kind: "sustained" | "spike";
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
    baselineAvg: number | null;
    increasePct: number | null;
    peakHourLabel: string | null;
    pm25ToPm10Ratio: number | null;
    rhAvg: number | null;
    coElevated: PollutantKey[];
  } | null;
};

export type AnalyticsComputation = {
  pollutant: PollutantKey;
  label: string;
  averaging: string;
  sensorValue: number | null;
  sensorUnit: string;
  cp: number;
  unit: string;
  bpLo: number;
  bpHi: number;
  iLo: number;
  iHi: number;
  exact: number;
  subIndex: number;
};

export type AnalyticsTrendPoint = {
  day: string;
  aqi: number | null;
  category: string | null;
  valid: boolean;
  provisional: boolean;
  dominantPollutant: string | null;
  samples: number;
  indices: Record<PollutantKey, number | null>;
  averages: Record<PollutantKey, number | null>;
};

export type AnalyticsTopPollutant = {
  rank: number;
  key: PollutantKey;
  label: string;
  unit: string;
  basis: IndexBasis;
  peakIndex: number;
  peakDay: string;
  peakValue: number | null;
  average: number | null;
  elevatedDays: number;
  category: string;
  categoryLabel: string;
  color: string;
};

export type AnalyticsOverview = {
  device: { externalId: string; name: string | null };
  generatedAt: string;
  timeZone: string;
  range: { from: string; to: string };
  categories: Array<{ key: string; label: string; min: number; max: number; color: string; cautionary: string }>;
  current: {
    aqi: number | null;
    category: string | null;
    categoryLabel: string | null;
    color: string | null;
    official: boolean;
    basis: string | null;
    dominantPollutant: PollutantKey | null;
    dominantLabel: string | null;
    dominantValue: number | null;
    dominantUnit: string | null;
    lastSampleAt: string | null;
    computation: AnalyticsComputation | null;
  };
  samplesInRange: number;
  pollutants: AnalyticsPollutantRow[];
  trend: AnalyticsTrendPoint[];
  topPollutants: AnalyticsTopPollutant[];
  events: AnalyticsEvent[];
  activeAlerts: AnalyticsEvent[];
  insights: Array<{ level: "info" | "watch" | "warning"; pollutant: PollutantKey | null; title: string; detail: string }>;
  summary: {
    text: string;
    unverified: Array<{ key: PollutantKey; label: string; basis: IndexBasis; categoryLabel: string; peakIndex: number }>;
    averageAqi: number | null;
    peakAqi: number | null;
    peakDay: string | null;
    elevatedDays: number;
    healthEffects: Array<{ pollutant: PollutantKey; label: string; category: string; effects: string[] }>;
    whatToDo: string[];
    affectedGroups: string[];
    menroActions: string[];
    advisoryText: string;
  };
};

export async function getAnalyticsOverview(params: { deviceId: string; from: string; to: string }): Promise<AnalyticsOverview> {
  const url = new URL(`${API_URL}/api/v1/analytics/overview`);
  url.searchParams.set("deviceId", params.deviceId);
  url.searchParams.set("from", params.from);
  url.searchParams.set("to", params.to);
  const res = await fetch(url);
  if (!res.ok) throw new Error("Failed to load analytics");
  return (await res.json()) as AnalyticsOverview;
}

export type RetentionStatus = {
  autoDeleteEnabled: boolean;
  goodRetentionDays: number;
  manualDeleteEnabled: boolean;
  cutoff: string;
  lastAutoRun: string | null;
  lastAutoDeleted: number;
  lastAutoError: string | null;
  lastCycleAt: string | null;
  rawRows: number;
  oldestRawAt: string | null;
  hourlyRows: number;
  dailyRows: number;
  eventCount: number;
  eligibleNow: number;
  recentDeletions: Array<{
    id: number;
    createdAt: string;
    mode: "auto" | "manual";
    deviceId: string | null;
    rangeFrom: string | null;
    rangeTo: string;
    maxCategory: "good" | "fair";
    deletedCount: number;
    note: string | null;
  }>;
};

export async function getRetentionStatus(): Promise<RetentionStatus> {
  const res = await fetch(`${API_URL}/api/v1/analytics/retention`);
  if (!res.ok) throw new Error("Failed to load data retention status");
  return (await res.json()) as RetentionStatus;
}

export type RecordDeleteRequest = {
  deviceId: string | null;
  from: string | null;
  to: string;
  maxCategory: "good" | "fair";
};

async function postAnalytics<T>(path: string, body: unknown, headers: Record<string, string> = {}): Promise<T> {
  const res = await fetch(`${API_URL}/api/v1/analytics${path}`, {
    method: "POST",
    headers: { "Content-Type": "application/json", ...headers },
    body: JSON.stringify(body)
  });
  const json = (await res.json().catch(() => ({}))) as T & { error?: string };
  if (!res.ok) throw new Error(json.error ?? `Request failed (${res.status})`);
  return json;
}

export function previewRecordDeletion(request: RecordDeleteRequest) {
  return postAnalytics<{ count: number }>("/records/preview", request);
}

export function deleteRecords(request: RecordDeleteRequest, adminKey: string) {
  return postAnalytics<{ deleted: number }>("/records/delete", request, { "X-Admin-Key": adminKey });
}
