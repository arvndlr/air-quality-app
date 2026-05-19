function resolveApiBaseUrl() {
  const configuredUrl = import.meta.env.VITE_API_URL?.trim();
  if (configuredUrl) return configuredUrl.replace(/\/$/, "");

  if (import.meta.env.DEV) return "http://localhost:4000";
  if (typeof window !== "undefined") return window.location.origin.replace(/\/$/, "");

  return "http://localhost:4000";
}

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

export type TransmissionHistoryResponse = {
  filters: {
    deviceId: string | null;
    from: string;
    to: string;
    status: TransmissionStatus | "all";
  };
  summary: TransmissionHistorySummary;
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

export type AqiResult = {
  aqi: number;
  category: string;
  color: string;
  dominantPollutant: "pm25" | "pm10" | "co" | "no2" | "so2";
  pm25SubIndex: number;
  pm10SubIndex: number;
  coSubIndex: number;
  no2SubIndex: number;
  so2SubIndex: number;
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

export async function getTransmissionHistory(params: {
  deviceId?: string | null;
  from: string;
  to: string;
  status?: TransmissionStatus | "all";
  page?: number;
  pageSize?: number;
}): Promise<TransmissionHistoryResponse> {
  const url = new URL(`${API_URL}/api/v1/transmissions`);
  url.searchParams.set("from", params.from);
  url.searchParams.set("to", params.to);

  if (params.deviceId) {
    url.searchParams.set("deviceId", params.deviceId);
  }

  if (params.status) {
    url.searchParams.set("status", params.status);
  }

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
