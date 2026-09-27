import { useEffect, useMemo, useState } from "react";
import { format, formatDistanceToNowStrict, formatISO, parseISO } from "date-fns";
import { getBatteryStatus } from "../battery";
import {
  downloadTransmissionCsv,
  getLatest,
  getTransmissionHistory,
  listDevices,
  type AqiResult,
  type Device,
  type Measurement,
  type TransmissionExportMode,
  type TransmissionHistoryResponse
} from "../api";
import { formatDurationCompact, formatResetReason, getSo2StatusSummary, isMeasurementOnline } from "../deviceStatus";
import {
  defaultCustomEnd,
  defaultCustomStart,
  describeRange,
  rangeOptions,
  resolveRange,
  toDateInputValue,
  type RangeKey
} from "../reportRange";

type DeviceSnapshot = {
  device: Device;
  latest: Measurement | null;
  aqi: AqiResult | null;
};

const numberFormatter = new Intl.NumberFormat("en-US");

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

function formatDayLabel(day: string) {
  return format(parseISO(day), "EEE, MMM d, yyyy");
}

function formatRollup(value: number | null, digits: number) {
  if (value == null) return "—";
  return value.toFixed(digits);
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
  const [customFrom, setCustomFrom] = useState<string>(defaultCustomStart);
  const [customTo, setCustomTo] = useState<string>(defaultCustomEnd);
  const [history, setHistory] = useState<TransmissionHistoryResponse | null>(null);
  const [snapshots, setSnapshots] = useState<DeviceSnapshot[]>([]);
  const [loading, setLoading] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const [exporting, setExporting] = useState<TransmissionExportMode | null>(null);

  const resolved = useMemo(() => resolveRange(range, customFrom, customTo), [range, customFrom, customTo]);
  const rangeError = resolved.error;
  const fromIso = rangeError ? null : formatISO(resolved.from);
  const toIso = rangeError ? null : formatISO(resolved.to);
  const windowLabel = describeRange(range, resolved.from, resolved.to);
  const todayValue = toDateInputValue(new Date());
  const selectedDevice = devices.find((device) => device.externalId === deviceId) ?? null;
  const generatedAt = useMemo(
    () => new Date(),
    [history?.summary.latestTs, history?.summary.totalRows, snapshots.length, range, customFrom, customTo, deviceId]
  );

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
    if (!fromIso || !toIso) return;

    let active = true;
    setLoading(true);
    setError(null);

    const scopedDevices = deviceId ? devices.filter((device) => device.externalId === deviceId) : devices;

    Promise.all([
      getTransmissionHistory({
        deviceId: deviceId || null,
        from: fromIso,
        to: toIso,
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
  }, [deviceId, devices, fromIso, toIso]);

  const now = Date.now();
  const onlineCount = snapshots.filter((snapshot) => isMeasurementOnline(snapshot.latest, now)).length;
  const offlineCount = Math.max(0, snapshots.length - onlineCount);
  const readyCount = snapshots.filter((snapshot) => getSo2StatusSummary(snapshot.latest).label === "Ready").length;
  const warmingCount = snapshots.filter((snapshot) => getSo2StatusSummary(snapshot.latest).label === "Warming").length;
  const calibratingCount = snapshots.filter((snapshot) => getSo2StatusSummary(snapshot.latest).label === "Calibrating").length;

  function handlePrint() {
    window.print();
  }

  async function handleExport(mode: TransmissionExportMode) {
    if (!fromIso || !toIso) return;

    setExporting(mode);
    setError(null);

    try {
      await downloadTransmissionCsv({ deviceId: deviceId || null, from: fromIso, to: toIso, status: "all", mode });
    } catch (cause) {
      setError(cause instanceof Error ? cause.message : "Failed to save the transmission log");
    } finally {
      setExporting(null);
    }
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
            {" | "}Window: {windowLabel}
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
            {rangeOptions.map((item) => (
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

      <div className="date-search-bar print-hidden">
        {range === "custom" ? (
          <div className="date-search-bar__fields">
            <label className="date-search-field">
              <span>Report from</span>
              <input
                type="date"
                max={customTo || todayValue}
                value={customFrom}
                onChange={(event) => setCustomFrom(event.target.value)}
              />
            </label>
            <label className="date-search-field">
              <span>Report to</span>
              <input
                type="date"
                min={customFrom || undefined}
                value={customTo}
                onChange={(event) => setCustomTo(event.target.value)}
              />
            </label>
            <button
              className="date-search-bar__reset"
              type="button"
              onClick={() => {
                const today = toDateInputValue(new Date());
                setCustomFrom(today);
                setCustomTo(today);
              }}
            >
              Today only
            </button>
          </div>
        ) : (
          <div className="date-search-bar__hint">
            Choose <strong>Custom dates</strong> to build the report for a specific day or date range.
          </div>
        )}

        <div className="date-search-bar__actions">
          <button
            className="report-print-button"
            type="button"
            disabled={!fromIso || exporting != null}
            onClick={() => handleExport("daily")}
          >
            {exporting === "daily" ? "Saving..." : "Save daily summary (CSV)"}
          </button>
          <button
            className="report-print-button report-print-button--ghost"
            type="button"
            disabled={!fromIso || exporting != null}
            onClick={() => handleExport("detail")}
          >
            {exporting === "detail" ? "Saving..." : "Save full log (CSV)"}
          </button>
        </div>
      </div>

      {rangeError && <div className="error">{rangeError}</div>}
      {error && <div className="error">{error}</div>}

      {history && (
        <article className="report-sheet">
          <section className="report-hero">
            <div>
              <div className="report-hero__eyebrow">Community Air Monitoring System</div>
              <h1 className="report-hero__title">Administrative Monitoring Report</h1>
              <p className="report-hero__summary">
                Operational summary for {selectedDevice ? selectedDevice.name ?? selectedDevice.externalId : "the Balayan, Batangas sensor network"} covering{" "}
                {range === "custom" ? windowLabel : windowLabel.toLowerCase()}.
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
                <span>Date scope</span>
                <strong>{windowLabel}</strong>
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
                <h2 className="dashboard-section__title">Daily Summary</h2>
                <span className="dashboard-section__hint">
                  Summarised results per calendar day in the reporting window: transmission volume, telemetry states, and the
                  average and peak concentration of each pollutant.
                </span>
              </div>
            </div>

            {history.daily.length === 0 ? (
              <div className="chart__empty" style={{ height: 180 }}>
                No days fall inside the current reporting window.
              </div>
            ) : (
              <div className="aqi-table-wrapper report-table-wrapper">
                <table className="aqi-table report-table daily-summary-table">
                  <thead>
                    <tr>
                      <th>Day</th>
                      <th>Transmissions</th>
                      <th>Telemetry states</th>
                      <th>Cadence</th>
                      <th>Average readings</th>
                      <th>Peak readings</th>
                    </tr>
                  </thead>
                  <tbody>
                    {history.daily.map((day) => (
                      <tr key={day.day}>
                        <td>
                          <div className="report-cell-stack">
                            <strong>{formatDayLabel(day.day)}</strong>
                            <span>
                              {formatDateTime(day.firstTs)} to {formatDateTime(day.lastTs)}
                            </span>
                          </div>
                        </td>
                        <td>
                          <div className="report-cell-stack">
                            <strong>{formatCount(day.totalRows)}</strong>
                            <span>
                              {formatCount(day.deviceCount)} {day.deviceCount === 1 ? "device" : "devices"}
                            </span>
                          </div>
                        </td>
                        <td>
                          <div className="report-metric-list">
                            <span>Ready: {formatCount(day.statusCounts.ready)}</span>
                            <span>Warming: {formatCount(day.statusCounts.warming)}</span>
                            <span>Calibrating: {formatCount(day.statusCounts.calibrating)}</span>
                            <span>Unknown: {formatCount(day.statusCounts.unknown)}</span>
                          </div>
                        </td>
                        <td>
                          <div className="report-cell-stack">
                            <strong>
                              {day.averageGapSec == null ? "Single sample" : formatDurationCompact(day.averageGapSec)}
                            </strong>
                            <span>Average interval</span>
                          </div>
                        </td>
                        <td>
                          <div className="report-metric-list">
                            <span>PM2.5: {formatRollup(day.averages.pm25, 1)} ug/m3</span>
                            <span>PM10: {formatRollup(day.averages.pm10, 1)} ug/m3</span>
                            <span>SO2: {formatRollup(day.averages.so2, 1)} ppb</span>
                            <span>CO: {formatRollup(day.averages.co, 1)} ppm</span>
                            <span>NO2: {formatRollup(day.averages.no2, 1)} ppb</span>
                            <span>CO2: {formatRollup(day.averages.co2, 0)} ppm</span>
                            <span>VOC: {formatRollup(day.averages.voc, 0)} index</span>
                          </div>
                        </td>
                        <td>
                          <div className="report-metric-list">
                            <span>PM2.5: {formatRollup(day.peaks.pm25, 1)} ug/m3</span>
                            <span>PM10: {formatRollup(day.peaks.pm10, 1)} ug/m3</span>
                            <span>SO2: {formatRollup(day.peaks.so2, 1)} ppb</span>
                            <span>CO: {formatRollup(day.peaks.co, 1)} ppm</span>
                            <span>NO2: {formatRollup(day.peaks.no2, 1)} ppb</span>
                            <span>CO2: {formatRollup(day.peaks.co2, 0)} ppm</span>
                            <span>VOC: {formatRollup(day.peaks.voc, 0)} index</span>
                          </div>
                        </td>
                      </tr>
                    ))}
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
