import { useEffect, useMemo, useState } from "react";
import { format, formatDistanceToNowStrict, formatISO, subDays, subMonths, subWeeks } from "date-fns";
import { BarChart, Bar, PieChart, Pie, Cell, XAxis, YAxis, CartesianGrid, Tooltip, Legend, ResponsiveContainer } from "recharts";
import { getBatteryStatus } from "../battery";
import {
  getLatest,
  getTransmissionHistory,
  listDevices,
  type AqiResult,
  type Device,
  type Measurement,
  type TransmissionHistoryResponse
} from "../api";
import { formatDurationCompact, formatResetReason, getSo2StatusSummary, isMeasurementOnline } from "../deviceStatus";

type RangeKey = "day" | "week" | "month";

type DeviceSnapshot = {
  device: Device;
  latest: Measurement | null;
  aqi: AqiResult | null;
};

const ranges: Array<{ key: RangeKey; label: string }> = [
  { key: "day", label: "24 Hours" },
  { key: "week", label: "7 Days" },
  { key: "month", label: "30 Days" }
];

const numberFormatter = new Intl.NumberFormat("en-US");

function computeWindow(range: RangeKey) {
  const now = new Date();

  if (range === "day") return { from: subDays(now, 1), to: now };
  if (range === "week") return { from: subWeeks(now, 1), to: now };
  return { from: subMonths(now, 1), to: now };
}

function formatCount(value: number) {
  return numberFormatter.format(value);
}

function formatDateTime(value: string | null) {
  if (!value) return "—";
  return format(new Date(value), "MMM d, yyyy HH:mm:ss");
}

function formatRelative(value: string | null) {
  if (!value) return "No transmissions yet";
  return formatDistanceToNowStrict(new Date(value), { addSuffix: true });
}

function formatMetric(value: number | null | undefined, digits: number, suffix: string) {
  if (value == null) return "—";
  return `${value.toFixed(digits)} ${suffix}`;
}

function formatWholeMetric(value: number | null | undefined, suffix: string) {
  if (value == null) return "—";
  return `${Math.round(value)} ${suffix}`;
}

function formatAqi(aqi: AqiResult | null) {
  if (!aqi) return "No AQI";
  return `${aqi.aqi} • ${aqi.category}`;
}

type ChartType = "bar" | "pie" | "table";

export function AdminReports() {
  const [devices, setDevices] = useState<Device[]>([]);
  const [deviceId, setDeviceId] = useState<string>("");
  const [range, setRange] = useState<RangeKey>("week");
  const [history, setHistory] = useState<TransmissionHistoryResponse | null>(null);
  const [snapshots, setSnapshots] = useState<DeviceSnapshot[]>([]);
  const [loading, setLoading] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const [chartTypes, setChartTypes] = useState<Record<string, ChartType>>({
    pollutants: "bar",
    pollutantTotal: "pie"
  });

  const timeWindow = useMemo(() => computeWindow(range), [range]);
  const selectedDevice = devices.find((device) => device.externalId === deviceId) ?? null;
  const generatedAt = useMemo(() => new Date(), [history?.summary.latestTs, history?.summary.totalRows, snapshots.length, range, deviceId]);

  useEffect(() => {
    let active = true;

    listDevices()
      .then((result) => {
        if (!active) return;
        setDevices(result);
      })
      .catch((cause) => {
        if (!active) return;
        setError(cause instanceof Error ? cause.message : "Failed to load devices");
      });

    return () => {
      active = false;
    };
  }, []);

  useEffect(() => {
    let active = true;
    setLoading(true);
    setError(null);

    const scopedDevices = deviceId ? devices.filter((device) => device.externalId === deviceId) : devices;

    Promise.all([
      getTransmissionHistory({
        deviceId: deviceId || null,
        from: formatISO(timeWindow.from),
        to: formatISO(timeWindow.to),
        status: "all",
        page: 1,
        pageSize: 8
      }),
      Promise.allSettled(scopedDevices.map((device) => getLatest(device.externalId)))
    ])
      .then(([historyResult, latestResults]) => {
        if (!active) return;

        setHistory(historyResult);
        setSnapshots(
          scopedDevices.map((device, index) => {
            const result = latestResults[index];
            if (!result || result.status !== "fulfilled") {
              return { device, latest: null, aqi: null };
            }

            return {
              device,
              latest: result.value.latest,
              aqi: result.value.aqi
            };
          })
        );
      })
      .catch((cause) => {
        if (!active) return;
        setError(cause instanceof Error ? cause.message : "Failed to load report");
      })
      .finally(() => {
        if (!active) return;
        setLoading(false);
      });

    return () => {
      active = false;
    };
  }, [deviceId, devices, timeWindow.from, timeWindow.to]);

  const now = Date.now();
  const onlineCount = snapshots.filter((snapshot) => isMeasurementOnline(snapshot.latest, now)).length;
  const offlineCount = Math.max(0, snapshots.length - onlineCount);
  const readyCount = snapshots.filter((snapshot) => getSo2StatusSummary(snapshot.latest).label === "Ready").length;
  const warmingCount = snapshots.filter((snapshot) => getSo2StatusSummary(snapshot.latest).label === "Warming").length;
  const calibratingCount = snapshots.filter((snapshot) => getSo2StatusSummary(snapshot.latest).label === "Calibrating").length;

  // Aggregate pollutant data by device
  const pollutantByDevice = useMemo(() => {
    if (!history) return [];

    const deviceData: Record<string, {
      pm25: number[];
      pm10: number[];
      so2: number[];
      co: number[];
      voc: number[];
    }> = {};

    history.rows.forEach((row) => {
      const deviceKey = row.deviceName || row.deviceExternalId;
      if (!deviceData[deviceKey]) {
        deviceData[deviceKey] = { pm25: [], pm10: [], so2: [], co: [], voc: [] };
      }
      if (row.pm25ugm3 != null) deviceData[deviceKey].pm25.push(row.pm25ugm3);
      if (row.pm10ugm3 != null) deviceData[deviceKey].pm10.push(row.pm10ugm3);
      if (row.so2Ppb != null) deviceData[deviceKey].so2.push(row.so2Ppb);
      if (row.micsCoPpm != null) deviceData[deviceKey].co.push(row.micsCoPpm);
      if (row.vocIndex != null) deviceData[deviceKey].voc.push(row.vocIndex);
    });

    // Calculate averages per device with all pollutants
    const result: any[] = [];
    Object.entries(deviceData).forEach(([device, data]) => {
      result.push({
        device: device.substring(0, 15),
        PM25: data.pm25.length > 0 ? Math.round((data.pm25.reduce((a, b) => a + b) / data.pm25.length) * 10) / 10 : 0,
        PM10: data.pm10.length > 0 ? Math.round((data.pm10.reduce((a, b) => a + b) / data.pm10.length) * 10) / 10 : 0,
        SO2: data.so2.length > 0 ? Math.round((data.so2.reduce((a, b) => a + b) / data.so2.length) * 10) / 10 : 0,
        CO: data.co.length > 0 ? Math.round((data.co.reduce((a, b) => a + b) / data.co.length) * 10) / 10 : 0,
        VOC: data.voc.length > 0 ? Math.round((data.voc.reduce((a, b) => a + b) / data.voc.length) * 10) / 10 : 0
      });
    });

    return result;
  }, [history]);

  // Aggregate total pollutant distribution
  const pollutantDistribution = useMemo(() => {
    if (pollutantByDevice.length === 0) return [];

    const totals = {
      pm25: 0,
      pm10: 0,
      so2: 0,
      co: 0,
      voc: 0
    };

    pollutantByDevice.forEach((device) => {
      totals.pm25 += device.PM25;
      totals.pm10 += device.PM10;
      totals.so2 += device.SO2;
      totals.co += device.CO;
      totals.voc += device.VOC;
    });

    return [
      { name: "PM2.5", value: Math.round(totals.pm25 * 10) / 10 },
      { name: "PM10", value: Math.round(totals.pm10 * 10) / 10 },
      { name: "SO2", value: Math.round(totals.so2 * 10) / 10 },
      { name: "CO", value: Math.round(totals.co * 10) / 10 },
      { name: "VOC", value: Math.round(totals.voc * 10) / 10 }
    ];
  }, [pollutantByDevice]);

  function handlePrint() {
    window.print();
  }

  function toggleChartType(metricKey: string, nextType: ChartType) {
    setChartTypes((prev) => ({
      ...prev,
      [metricKey]: nextType
    }));
  }

  function renderChart(metricKey: string, data: any[], dataKey: string | string[], title: string, colors?: string[]) {
    const chartType = chartTypes[metricKey] || "bar";
    const defaultColors = colors || ["#3b82f6", "#10b981", "#f59e0b", "#ef4444"];
    const xAxisKey = data.length > 0 && data[0].device ? "device" : "name";
    const isMultiSeries = Array.isArray(dataKey);

    return (
      <div style={{ background: "var(--surface)", padding: "1.5rem", borderRadius: "8px" }}>
        <div style={{ display: "flex", justifyContent: "space-between", alignItems: "center", marginBottom: "1rem" }}>
          <h3 style={{ fontSize: "0.9rem", fontWeight: 600, textTransform: "uppercase", color: "var(--text-secondary)", margin: 0 }}>
            {title}
          </h3>
          <div className="segmented" role="group" style={{ fontSize: "0.8rem" }}>
            <button
              type="button"
              data-active={chartType === "bar"}
              onClick={() => toggleChartType(metricKey, "bar")}
              style={{ padding: "0.4rem 0.8rem" }}
            >
              Bar
            </button>
            <button
              type="button"
              data-active={chartType === "pie"}
              onClick={() => toggleChartType(metricKey, "pie")}
              style={{ padding: "0.4rem 0.8rem" }}
            >
              Pie
            </button>
          </div>
        </div>

        {chartType === "bar" && (
          <ResponsiveContainer width="100%" height={300}>
            <BarChart data={data}>
              <CartesianGrid strokeDasharray="3 3" />
              <XAxis dataKey={xAxisKey} />
              <YAxis />
              <Tooltip />
              {isMultiSeries ? (
                (dataKey as string[]).map((key: string, index: number) => (
                  <Bar key={key} dataKey={key} fill={defaultColors[index % defaultColors.length]} />
                ))
              ) : (
                <Bar dataKey={dataKey as string} fill={defaultColors[0]} />
              )}
            </BarChart>
          </ResponsiveContainer>
        )}

        {chartType === "pie" && (
          <ResponsiveContainer width="100%" height={300}>
            <PieChart>
              <Pie
                data={data}
                cx="50%"
                cy="50%"
                labelLine={false}
                label={({ [xAxisKey]: name, [isMultiSeries ? "value" : dataKey]: val }) => `${name}: ${val}`}
                outerRadius={80}
                fill="#8884d8"
                dataKey={isMultiSeries ? "value" : (dataKey as string)}
              >
                {data.map((_, index) => (
                  <Cell key={`cell-${index}`} fill={defaultColors[index % defaultColors.length]} />
                ))}
              </Pie>
              <Tooltip />
            </PieChart>
          </ResponsiveContainer>
        )}
      </div>
    );
  }

  const sortedSnapshots = [...snapshots].sort((left, right) => {
    const leftOnline = isMeasurementOnline(left.latest, now) ? 1 : 0;
    const rightOnline = isMeasurementOnline(right.latest, now) ? 1 : 0;

    if (leftOnline !== rightOnline) {
      return rightOnline - leftOnline;
    }

    const leftName = left.device.name ?? left.device.externalId;
    const rightName = right.device.name ?? right.device.externalId;
    return leftName.localeCompare(rightName);
  });

  return (
    <div className="page report-page">
      <header className="topbar report-toolbar print-hidden">
        <div className="topbar__left">
          <div className="topbar__title">Admin Reports</div>
          <div className="topbar__status">
            {selectedDevice ? `Device: ${selectedDevice.name ?? selectedDevice.externalId}` : "Scope: all sensor nodes"}
            {" | "}Window: {ranges.find((item) => item.key === range)?.label ?? "Custom"}
            {history?.summary.latestTs ? ` | Latest ${formatRelative(history.summary.latestTs)}` : ""}
            {loading ? " | Preparing report" : ""}
          </div>
        </div>
        <div className="topbar__controls">
          <select aria-label="Report device" value={deviceId} onChange={(event) => setDeviceId(event.target.value)}>
            <option value="">All devices</option>
            {devices.map((device) => (
              <option key={device.externalId} value={device.externalId}>
                {device.name ? `${device.name} (${device.externalId})` : device.externalId}
              </option>
            ))}
          </select>

          <div className="segmented" role="group" aria-label="Report range">
            {ranges.map((item) => (
              <button key={item.key} type="button" data-active={range === item.key} onClick={() => setRange(item.key)}>
                {item.label}
              </button>
            ))}
          </div>

          <button className="report-print-button" onClick={handlePrint} type="button">
            Print report
          </button>
        </div>
      </header>

      {error && <div className="error">{error}</div>}

      {history && (
        <article className="report-sheet">
          <section className="report-hero">
            <div>
              <div className="report-hero__eyebrow">Community Air Monitoring System</div>
              <h1 className="report-hero__title">Administrative Monitoring Report</h1>
              <p className="report-hero__summary">
                Operational summary for {selectedDevice ? selectedDevice.name ?? selectedDevice.externalId : "the Balayan, Batangas sensor network"} covering{" "}
                {ranges.find((item) => item.key === range)?.label.toLowerCase() ?? "the selected range"}.
              </p>
            </div>
            <div className="report-meta-card">
              <div className="report-meta-row">
                <span>Generated</span>
                <strong>{format(generatedAt, "MMM d, yyyy HH:mm:ss")}</strong>
              </div>
              <div className="report-meta-row">
                <span>Window</span>
                <strong>
                  {formatDateTime(history.filters.from)} to {formatDateTime(history.filters.to)}
                </strong>
              </div>
              <div className="report-meta-row">
                <span>Coverage</span>
                <strong>{selectedDevice ? "Single device report" : "Network-wide report"}</strong>
              </div>
            </div>
          </section>

          <section className="report-stat-grid">
            <div className="report-stat-card">
              <div className="report-stat-card__label">Transmissions logged</div>
              <div className="report-stat-card__value">{formatCount(history.summary.totalRows)}</div>
              <div className="report-stat-card__meta">Stored records in the selected reporting window.</div>
            </div>
            <div className="report-stat-card">
              <div className="report-stat-card__label">Devices represented</div>
              <div className="report-stat-card__value">{formatCount(history.summary.deviceCount)}</div>
              <div className="report-stat-card__meta">Nodes that submitted at least one transmission.</div>
            </div>
            <div className="report-stat-card">
              <div className="report-stat-card__label">Operational availability</div>
              <div className="report-stat-card__value">
                {formatCount(onlineCount)} online / {formatCount(offlineCount)} offline
              </div>
              <div className="report-stat-card__meta">Based on the most recent sample from each included node.</div>
            </div>
            <div className="report-stat-card">
              <div className="report-stat-card__label">Average cadence</div>
              <div className="report-stat-card__value">
                {history.summary.averageGapSec == null ? "No cadence yet" : formatDurationCompact(history.summary.averageGapSec)}
              </div>
              <div className="report-stat-card__meta">Average interval between successive transmissions.</div>
            </div>
          </section>

          <section className="dashboard-section report-section">
            <div className="dashboard-section__header">
              <div>
                <h2 className="dashboard-section__title">Executive Summary</h2>
                <span className="dashboard-section__hint">Concise operational snapshot for administrative review.</span>
              </div>
            </div>
            <div className="report-summary-grid">
              <div className="report-summary-card">
                <div className="report-summary-card__label">SO2 readiness</div>
                <div className="report-summary-card__value">
                  {formatCount(readyCount)} ready / {formatCount(warmingCount)} warming / {formatCount(calibratingCount)} calibrating
                </div>
                <p>
                  Historical state counts in this window: ready {formatCount(history.summary.statusCounts.ready)}, warming{" "}
                  {formatCount(history.summary.statusCounts.warming)}, calibrating {formatCount(history.summary.statusCounts.calibrating)}, unknown{" "}
                  {formatCount(history.summary.statusCounts.unknown)}.
                </p>
              </div>
              <div className="report-summary-card">
                <div className="report-summary-card__label">Latest ingestion</div>
                <div className="report-summary-card__value">{formatRelative(history.summary.latestTs)}</div>
                <p>Most recent stored transmission occurred at {formatDateTime(history.summary.latestTs)}.</p>
              </div>
            </div>
          </section>

          <section className="dashboard-section report-section">
            <div className="dashboard-section__header">
              <div>
                <h2 className="dashboard-section__title">Pollutant Analysis</h2>
                <span className="dashboard-section__hint">Average pollutant concentrations across all devices in the reporting window.</span>
              </div>
            </div>

            {pollutantByDevice.length === 0 ? (
              <div className="chart__empty" style={{ height: 220 }}>
                No pollutant data available for this report window.
              </div>
            ) : (
              <div style={{ display: "grid", gridTemplateColumns: "repeat(auto-fit, minmax(600px, 1fr))", gap: "2rem", marginTop: "2rem" }}>
                {renderChart(
                  "pollutants",
                  pollutantByDevice,
                  ["PM25", "PM10", "SO2", "CO", "VOC"],
                  "Pollutant Distribution by Device",
                  ["#ef4444", "#f97316", "#f59e0b", "#8b5cf6", "#06b6d4"]
                )}

                {renderChart(
                  "pollutantTotal",
                  pollutantDistribution,
                  "value",
                  "Overall Pollutant Distribution",
                  ["#ef4444", "#f97316", "#f59e0b", "#8b5cf6", "#06b6d4"]
                )}
              </div>
            )}
          </section>

          <section className="dashboard-section report-section">
            <div className="dashboard-section__header">
              <div>
                <h2 className="dashboard-section__title">Current Device Snapshot</h2>
                <span className="dashboard-section__hint">Latest sample, power condition, AQI, and sensor readiness per included device.</span>
              </div>
            </div>

            {sortedSnapshots.length === 0 ? (
              <div className="chart__empty" style={{ height: 220 }}>
                No devices are available for this report.
              </div>
            ) : (
              <div className="aqi-table-wrapper report-table-wrapper">
                <table className="aqi-table report-table">
                  <thead>
                    <tr>
                      <th>Device</th>
                      <th>Health</th>
                      <th>Last sample</th>
                      <th>AQI</th>
                      <th>Battery</th>
                      <th>Runtime</th>
                      <th>Pollutants</th>
                    </tr>
                  </thead>
                  <tbody>
                    {sortedSnapshots.map((snapshot) => {
                      const online = isMeasurementOnline(snapshot.latest, now);
                      const battery = getBatteryStatus(snapshot.latest);
                      const so2 = getSo2StatusSummary(snapshot.latest);

                      return (
                        <tr key={snapshot.device.externalId}>
                          <td>
                            <div className="report-cell-stack">
                              <strong>{snapshot.device.name ?? snapshot.device.externalId}</strong>
                              <span>{snapshot.device.externalId}</span>
                            </div>
                          </td>
                          <td>
                            <div className="report-cell-stack">
                              <span className={`report-status-badge ${online ? "report-status-badge--online" : "report-status-badge--offline"}`}>
                                {online ? "Online" : "Offline"}
                              </span>
                              <span>{so2.detail ? `${so2.label} • ${so2.detail}` : so2.label}</span>
                            </div>
                          </td>
                          <td>
                            <div className="report-cell-stack">
                              <strong>{formatDateTime(snapshot.latest?.ts ?? null)}</strong>
                              <span>{formatRelative(snapshot.latest?.ts ?? null)}</span>
                            </div>
                          </td>
                          <td>
                            <div className="report-cell-stack">
                              <strong style={{ color: snapshot.aqi?.color ?? "var(--text)" }}>{formatAqi(snapshot.aqi)}</strong>
                              <span>{snapshot.aqi?.dominantPollutant ? `Dominant: ${snapshot.aqi.dominantPollutant.toUpperCase()}` : "No dominant pollutant"}</span>
                            </div>
                          </td>
                          <td>
                            <div className="report-cell-stack">
                              <strong style={{ color: battery.color }}>{battery.summary}</strong>
                              <span>{battery.voltageText}</span>
                            </div>
                          </td>
                          <td>
                            <div className="report-cell-stack">
                              <strong>{formatDurationCompact(snapshot.latest?.uptimeSec)}</strong>
                              <span>Reset: {formatResetReason(snapshot.latest?.resetReason)}</span>
                            </div>
                          </td>
                          <td>
                            <div className="report-metric-list">
                              <span>PM2.5: {formatMetric(snapshot.latest?.pm25ugm3, 1, "ug/m3")}</span>
                              <span>PM10: {formatMetric(snapshot.latest?.pm10ugm3, 1, "ug/m3")}</span>
                              <span>SO2: {formatMetric(snapshot.latest?.so2Ppb, 1, "ppb")}</span>
                              <span>CO2: {formatWholeMetric(snapshot.latest?.co2ppm, "ppm")}</span>
                              <span>VOC: {formatWholeMetric(snapshot.latest?.vocIndex, "index")}</span>
                            </div>
                          </td>
                        </tr>
                      );
                    })}
                  </tbody>
                </table>
              </div>
            )}
          </section>

          <section className="dashboard-section report-section">
            <div className="dashboard-section__header">
              <div>
                <h2 className="dashboard-section__title">Recent Transmission Log</h2>
                <span className="dashboard-section__hint">Most recent stored transmissions included in this reporting window.</span>
              </div>
            </div>

            {history.rows.length === 0 ? (
              <div className="chart__empty" style={{ height: 220 }}>
                No transmissions were recorded in the current report window.
              </div>
            ) : (
              <div className="aqi-table-wrapper report-table-wrapper">
                <table className="aqi-table report-table">
                  <thead>
                    <tr>
                      <th>Timestamp</th>
                      <th>Device</th>
                      <th>Telemetry state</th>
                      <th>Cadence</th>
                      <th>Environment</th>
                      <th>Air values</th>
                    </tr>
                  </thead>
                  <tbody>
                    {history.rows.map((row) => (
                      <tr key={row.id}>
                        <td>
                          <div className="report-cell-stack">
                            <strong>{formatDateTime(row.ts)}</strong>
                            <span>{formatRelative(row.ts)}</span>
                          </div>
                        </td>
                        <td>
                          <div className="report-cell-stack">
                            <strong>{row.deviceName ?? row.deviceExternalId}</strong>
                            <span>{row.deviceExternalId}</span>
                          </div>
                        </td>
                        <td>
                          <div className="report-cell-stack">
                            <span className={`history-badge history-badge--${row.transmissionStatus}`}>{row.transmissionStatus}</span>
                            <span>{row.so2Status ?? "No SO2 system status"}</span>
                          </div>
                        </td>
                        <td>
                          <div className="report-cell-stack">
                            <strong>{row.gapSec == null ? "First sample" : formatDurationCompact(row.gapSec)}</strong>
                            <span>Boot {row.bootCount != null ? `#${row.bootCount}` : "—"}</span>
                          </div>
                        </td>
                        <td>
                          <div className="report-metric-list">
                            <span>Temp: {formatMetric(row.tempC, 1, "C")}</span>
                            <span>Humidity: {formatMetric(row.rh, 1, "%")}</span>
                            <span>Battery: {formatMetric(row.batteryVoltage, 2, "V")}</span>
                          </div>
                        </td>
                        <td>
                          <div className="report-metric-list">
                            <span>PM2.5: {formatMetric(row.pm25ugm3, 1, "ug/m3")}</span>
                            <span>PM10: {formatMetric(row.pm10ugm3, 1, "ug/m3")}</span>
                            <span>SO2: {formatMetric(row.so2Ppb, 1, "ppb")}</span>
                            <span>CO: {formatMetric(row.micsCoPpm, 1, "ppm")}</span>
                            <span>VOC: {formatWholeMetric(row.vocIndex, "index")}</span>
                          </div>
                        </td>
                      </tr>
                    ))}
                  </tbody>
                </table>
              </div>
            )}
          </section>
        </article>
      )}
    </div>
  );
}
