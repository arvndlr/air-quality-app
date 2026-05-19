import { useEffect, useMemo, useState } from "react";
import { formatDistanceToNowStrict, formatISO, subDays, subMonths, subWeeks, subYears } from "date-fns";
import { getLatest, getSeries, listDevices, type AqiResult, type Device, type Measurement, type SeriesPoint } from "../api";
import { getBatteryStatus } from "../battery";
import { ChartCard } from "../components/ChartCard";
import { formatDurationCompact, formatResetReason, getSo2StatusSummary, isMeasurementOnline } from "../deviceStatus";
import { AqiCard } from "../components/AqiCard";
import { PollutantCard } from "../components/PollutantCard";
import { useDeviceWebSocket } from "../useWebSocket";

type RangeKey = "day" | "week" | "month" | "year";

const ranges: Array<{ key: RangeKey; label: string }> = [
  { key: "day", label: "Day" },
  { key: "week", label: "Week" },
  { key: "month", label: "Month" },
  { key: "year", label: "Year" }
];

const metrics = [
  { key: "co2ppm", label: "CO\u2082 (ppm)" },
  { key: "pm25ugm3", label: "PM\u2082.\u2085 (\u00b5g/m\u00b3)" },
  { key: "pm10ugm3", label: "PM\u2081\u2080 (\u00b5g/m\u00b3)" },
  { key: "so2Ppb", label: "SO\u2082 (ppb)" },
  { key: "micsCoPpm", label: "CO (ppm)" },
  { key: "micsNo2Ppb", label: "NO\u2082 (ppb)" },
  { key: "micsNh3Ppm", label: "NH\u2083 (ppm)" },
  { key: "tempC", label: "Temperature (\u00b0C)" },
  { key: "rh", label: "Humidity (%)" },
  { key: "vocIndex", label: "VOC Index" },
  { key: "gasKohm", label: "Gas (k\u03a9)" }
] as const;

const metricLabel = new Map(metrics.map((m) => [m.key, m.label] as const));
const selectedDeviceStorageKey = "aqi:selectedDeviceId";

function loadSavedDeviceId(): string | null {
  if (typeof window === "undefined") return null;

  try {
    return window.localStorage.getItem(selectedDeviceStorageKey);
  } catch {
    return null;
  }
}

function computeWindow(range: RangeKey) {
  const now = new Date();
  if (range === "day") return { from: subDays(now, 1), to: now, bucket: "5min" };
  if (range === "week") return { from: subWeeks(now, 1), to: now, bucket: "hour" };
  if (range === "month") return { from: subMonths(now, 1), to: now, bucket: "day" };
  return { from: subYears(now, 1), to: now, bucket: "week" };
}

export function Dashboard() {
  const [devices, setDevices] = useState<Device[]>([]);
  const [deviceId, setDeviceId] = useState<string | null>(() => loadSavedDeviceId());
  const [range, setRange] = useState<RangeKey>("day");
  const [metric, setMetric] = useState<(typeof metrics)[number]["key"]>(metrics[0]!.key);

  const [latest, setLatest] = useState<Measurement | null>(null);
  const [aqiData, setAqiData] = useState<AqiResult | null>(null);
  const [series, setSeries] = useState<SeriesPoint[]>([]);
  const [loading, setLoading] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const [statusNow, setStatusNow] = useState(() => Date.now());

  useEffect(() => {
    let active = true;

    listDevices()
      .then((d) => {
        if (!active) return;
        setDevices(d);
        setDeviceId((current) => {
          if (current && d.some((device) => device.externalId === current)) return current;
          return d[0]?.externalId ?? null;
        });
      })
      .catch((e) => {
        if (!active) return;
        setError(e instanceof Error ? e.message : "Failed to load devices");
      });

    return () => {
      active = false;
    };
  }, []);

  useEffect(() => {
    if (typeof window === "undefined") return;

    try {
      if (deviceId) {
        window.localStorage.setItem(selectedDeviceStorageKey, deviceId);
      } else {
        window.localStorage.removeItem(selectedDeviceStorageKey);
      }
    } catch {
      // Ignore storage failures and keep the dashboard usable.
    }
  }, [deviceId]);

  useEffect(() => {
    const intervalId = window.setInterval(() => setStatusNow(Date.now()), 30000);
    return () => window.clearInterval(intervalId);
  }, []);

  const timeWindow = useMemo(() => computeWindow(range), [range]);
  const ws = useDeviceWebSocket(deviceId);

  useEffect(() => {
    if (!deviceId) return;
    setLoading(true);
    setError(null);

    const from = formatISO(timeWindow.from);
    const to = formatISO(timeWindow.to);

    Promise.all([getLatest(deviceId), getSeries({ deviceId, metric, from, to, bucket: timeWindow.bucket })])
      .then(([latestResult, s]) => {
        setLatest(latestResult.latest);
        setAqiData(latestResult.aqi);
        setSeries(s);
      })
      .catch((e) => setError(e instanceof Error ? e.message : "Failed to load data"))
      .finally(() => setLoading(false));
  }, [deviceId, metric, timeWindow.bucket, timeWindow.from, timeWindow.to]);

  useEffect(() => {
    if (!ws.lastMessage) return;
    const msg = ws.lastMessage as { type?: string; deviceId?: string; measurement?: Measurement; aqi?: AqiResult | null };
    if (msg.type !== "measurement") return;
    if (msg.deviceId !== deviceId) return;
    if (!msg.measurement) return;
    setLatest(msg.measurement);
    setAqiData(msg.aqi ?? null);
  }, [ws.lastMessage, deviceId]);

  const selectedDevice = devices.find((d) => d.externalId === deviceId);
  const deviceLocation = selectedDevice?.name ?? "Gumaranita, Balayan";
  const batteryStatus = getBatteryStatus(latest);
  const deviceOnline = isMeasurementOnline(latest, statusNow);
  const deviceUptime = formatDurationCompact(latest?.uptimeSec);
  const resetReasonText = formatResetReason(latest?.resetReason);
  const so2Status = getSo2StatusSummary(latest);
  const so2PendingText = latest && latest.so2Ppb == null ? so2Status.label : "\u2014";

  return (
    <div className="page">
      <header className="topbar">
        <div className="topbar__left">
          <div className="topbar__title">AQI Dashboard</div>
          <div className="topbar__status">
            Device: {deviceOnline ? <span className="status-dot status-dot--on" /> : <span className="status-dot status-dot--off" />}
            {deviceOnline ? "Online" : "Offline"}
            {" | "}Live feed: {ws.connected ? <span className="status-dot status-dot--on" /> : <span className="status-dot status-dot--off" />}
            {ws.connected ? "Connected" : "Disconnected"}
            {latest?.ts ? ` | Last sample ${formatDistanceToNowStrict(new Date(latest.ts), { addSuffix: true })}` : ""}
            {latest?.batteryVoltage != null ? ` | Battery ${batteryStatus.summary} (${batteryStatus.voltageText})` : ""}
            {latest?.uptimeSec != null ? ` | Uptime ${deviceUptime}` : ""}
            {latest?.resetReason ? ` | Reset ${resetReasonText}` : ""}
          </div>
        </div>
        <div className="topbar__controls">
          <select aria-label="Device" value={deviceId ?? ""} onChange={(e) => setDeviceId(e.target.value || null)}>
            <option value="" disabled>{devices.length === 0 ? "No devices registered" : "Select device..."}</option>
            {devices.map((d) => (
              <option key={d.externalId} value={d.externalId}>
                {d.name ? `${d.name} (${d.externalId})` : d.externalId}
              </option>
            ))}
          </select>
          <div className="segmented" role="group" aria-label="Range">
            {ranges.map((r) => (
              <button key={r.key} type="button" data-active={range === r.key} onClick={() => setRange(r.key)}>
                {r.label}
              </button>
            ))}
          </div>
          <div className="segmented" role="group" aria-label="Metric">
            {metrics.map((m) => (
              <button key={m.key} type="button" data-active={metric === m.key} onClick={() => setMetric(m.key)}>
                {m.label}
              </button>
            ))}
          </div>
        </div>
      </header>

      {error && <div className="error">{error}</div>}

      <div className="dashboard-top">
        <AqiCard aqi={aqiData} loading={loading} location={deviceLocation} />
        <ChartCard
          title="Analog AQI Signal Trend"
          subtitle={`${metricLabel.get(metric) ?? metric} | ${range} | bucket ${timeWindow.bucket}`}
          points={series}
          loading={loading}
        />
      </div>

      <div className="dashboard-section">
        <div className="dashboard-section__header">
          <h2 className="dashboard-section__title">Monitored Pollutants</h2>
          <span className="dashboard-section__hint">Click any pollutant card to view thresholds, health notes, and specific recommendations.</span>
        </div>
        <div className="pollutant-grid-row">
          <PollutantCard
            title="PM<sub>2.5</sub>"
            unit="&micro;g/m&sup3;"
            value={latest?.pm25ugm3 ?? null}
            subIndex={aqiData?.pm25SubIndex ?? null}
            loading={loading}
            format={(v) => v.toFixed(1)}
          />
          <PollutantCard
            title="PM<sub>10</sub>"
            unit="&micro;g/m&sup3;"
            value={latest?.pm10ugm3 ?? null}
            subIndex={aqiData?.pm10SubIndex ?? null}
            loading={loading}
            format={(v) => v.toFixed(1)}
          />
          <PollutantCard
            title="SO<sub>2</sub>"
            unit="ppb"
            value={latest?.so2Ppb ?? null}
            subIndex={aqiData?.so2SubIndex ?? null}
            loading={loading}
            format={(v) => v.toFixed(1)}
            emptyText={so2PendingText}
          />
          <PollutantCard
            title="CO"
            unit="ppm"
            value={latest?.micsCoPpm ?? null}
            subIndex={aqiData?.coSubIndex ?? null}
            loading={loading}
            format={(v) => v.toFixed(1)}
          />
          <PollutantCard
            title="CO<sub>2</sub>"
            unit="ppm"
            value={latest?.co2ppm ?? null}
            subIndex={null}
            indicatorKind="co2"
            loading={loading}
            format={(v) => v.toFixed(1)}
          />
          <PollutantCard
            title="VOC"
            unit="index"
            value={latest?.vocIndex ?? null}
            subIndex={null}
            indicatorKind="voc"
            loading={loading}
            format={(v) => v.toFixed(0)}
          />
          <PollutantCard
            title="NO<sub>2</sub>"
            unit="ppb"
            value={latest?.micsNo2Ppb ?? null}
            subIndex={aqiData?.no2SubIndex ?? null}
            loading={loading}
            format={(v) => v.toFixed(1)}
          />
          <PollutantCard
            title="NH<sub>3</sub>"
            unit="ppm"
            value={latest?.micsNh3Ppm ?? null}
            subIndex={null}
            indicatorKind="nh3"
            loading={loading}
            format={(v) => v.toFixed(2)}
          />
        </div>
      </div>

      <div className="dashboard-section">
        <h2 className="dashboard-section__title">Additional Readings</h2>
        <div className="stats-grid">
          <div className="mini-stat">
            <div className="mini-stat__label">Temperature</div>
            <div className="mini-stat__value">{latest?.tempC != null ? `${latest.tempC.toFixed(1)}\u00b0C` : "\u2014"}</div>
          </div>
          <div className="mini-stat">
            <div className="mini-stat__label">Humidity</div>
            <div className="mini-stat__value">{latest?.rh != null ? `${latest.rh.toFixed(1)}%` : "\u2014"}</div>
          </div>
          <div className="mini-stat">
            <div className="mini-stat__label">VOC Index</div>
            <div className="mini-stat__value">{latest?.vocIndex != null ? `${latest.vocIndex.toFixed(0)}` : "\u2014"}</div>
          </div>
          <div className="mini-stat">
            <div className="mini-stat__label">Gas Resistance</div>
            <div className="mini-stat__value">{latest?.gasKohm != null ? `${latest.gasKohm.toFixed(1)} k\u03a9` : "\u2014"}</div>
          </div>
          <div className="mini-stat">
            <div className="mini-stat__label">Battery</div>
            <div className="mini-stat__value" style={{ color: batteryStatus.color }}>{batteryStatus.summary}</div>
            <div className="mini-stat__subvalue">{batteryStatus.voltageText}</div>
          </div>
          <div className="mini-stat">
            <div className="mini-stat__label">SO\u2082</div>
            <div className="mini-stat__value">{latest?.so2Ppb != null ? `${latest.so2Ppb.toFixed(1)} ppb` : so2PendingText}</div>
            {so2Status.detail ? <div className="mini-stat__subvalue">{so2Status.detail}</div> : null}
          </div>
          <div className="mini-stat">
            <div className="mini-stat__label">SO\u2082 State</div>
            <div className="mini-stat__value">{so2Status.label}</div>
          </div>
          <div className="mini-stat">
            <div className="mini-stat__label">Uptime</div>
            <div className="mini-stat__value">{deviceUptime}</div>
          </div>
          <div className="mini-stat">
            <div className="mini-stat__label">Boot</div>
            <div className="mini-stat__value">{latest?.bootCount != null ? `#${latest.bootCount}` : "\u2014"}</div>
          </div>
          <div className="mini-stat">
            <div className="mini-stat__label">Reset</div>
            <div className="mini-stat__value">{resetReasonText}</div>
          </div>
          <div className="mini-stat">
            <div className="mini-stat__label">NO\u2082</div>
            <div className="mini-stat__value">{latest?.micsNo2Ppb != null ? `${latest.micsNo2Ppb.toFixed(1)} ppb` : "\u2014"}</div>
          </div>
          <div className="mini-stat">
            <div className="mini-stat__label">NH\u2083</div>
            <div className="mini-stat__value">{latest?.micsNh3Ppm != null ? `${latest.micsNh3Ppm.toFixed(2)} ppm` : "\u2014"}</div>
          </div>
        </div>
      </div>
    </div>
  );
}
