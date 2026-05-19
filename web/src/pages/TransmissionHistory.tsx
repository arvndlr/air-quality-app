import { useEffect, useMemo, useRef, useState } from "react";
import { format, formatDistanceToNowStrict, formatISO, subDays, subMonths, subWeeks } from "date-fns";
import {
  getTransmissionHistory,
  listDevices,
  type Device,
  type TransmissionHistoryResponse,
  type TransmissionRow,
  type TransmissionStatus
} from "../api";
import { formatDurationCompact, formatResetReason } from "../deviceStatus";

type RangeKey = "day" | "week" | "month";
type StatusFilter = TransmissionStatus | "all";

const PAGE_SIZE = 20;

const ranges: Array<{ key: RangeKey; label: string }> = [
  { key: "day", label: "24 Hours" },
  { key: "week", label: "7 Days" },
  { key: "month", label: "30 Days" }
];

const statusOptions: Array<{ value: StatusFilter; label: string }> = [
  { value: "all", label: "All states" },
  { value: "ready", label: "Ready" },
  { value: "warming", label: "Warming" },
  { value: "calibrating", label: "Calibrating" },
  { value: "unknown", label: "Unknown" }
];

const statusLabels: Record<TransmissionStatus, string> = {
  ready: "Ready",
  warming: "Warming",
  calibrating: "Calibrating",
  unknown: "Unknown"
};

const numberFormatter = new Intl.NumberFormat("en-US");

function computeWindow(range: RangeKey) {
  const now = new Date();

  if (range === "day") {
    return { from: subDays(now, 1), to: now };
  }

  if (range === "week") {
    return { from: subWeeks(now, 1), to: now };
  }

  return { from: subMonths(now, 1), to: now };
}

function formatDateTime(value: string | null) {
  if (!value) return "—";
  return format(new Date(value), "MMM d, yyyy HH:mm:ss");
}

function formatRelativeTime(value: string | null) {
  if (!value) return "No transmissions yet";
  return formatDistanceToNowStrict(new Date(value), { addSuffix: true });
}

function formatCount(value: number) {
  return numberFormatter.format(value);
}

function formatGap(value: number | null) {
  if (value == null) return "First sample";
  return formatDurationCompact(value);
}

function formatDurationValue(value: number | null | undefined) {
  return formatDurationCompact(value);
}

function formatMetric(value: number | null, digits: number, suffix: string) {
  if (value == null) return "—";
  return `${value.toFixed(digits)} ${suffix}`;
}

function formatWholeMetric(value: number | null, suffix: string) {
  if (value == null) return "—";
  return `${Math.round(value)} ${suffix}`;
}

function formatPowerState(row: TransmissionRow) {
  if (row.chargerOn === true) return "Charging";
  if (row.chargerOn === false) return "Battery powered";
  return "Power state unknown";
}

function formatSo2Detail(row: TransmissionRow) {
  if (row.so2Status === "warming") return "SO2 sensor warming";
  if (row.so2Status === "calibrating") return "SO2 baseline calibrating";
  if (row.so2Ppb != null || row.so2Status === "ok") return "SO2 estimate available";
  return "SO2 state unavailable";
}

function formatPageRange(history: TransmissionHistoryResponse) {
  if (history.pagination.totalRows === 0) return "No transmissions in the selected window.";

  const start = (history.pagination.page - 1) * history.pagination.pageSize + 1;
  const end = start + history.rows.length - 1;
  return `Showing ${formatCount(start)}-${formatCount(end)} of ${formatCount(history.pagination.totalRows)} transmissions`;
}

export function TransmissionHistory() {
  const [devices, setDevices] = useState<Device[]>([]);
  const [deviceId, setDeviceId] = useState<string>("");
  const [range, setRange] = useState<RangeKey>("week");
  const [status, setStatus] = useState<StatusFilter>("all");
  const [page, setPage] = useState(1);
  const [history, setHistory] = useState<TransmissionHistoryResponse | null>(null);
  const [loading, setLoading] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const tableScrollRef = useRef<HTMLDivElement | null>(null);

  const timeWindow = useMemo(() => computeWindow(range), [range]);
  const selectedDevice = devices.find((device) => device.externalId === deviceId) ?? null;

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
    setPage(1);
  }, [deviceId, range, status]);

  useEffect(() => {
    let active = true;
    setLoading(true);
    setError(null);

    getTransmissionHistory({
      deviceId: deviceId || null,
      from: formatISO(timeWindow.from),
      to: formatISO(timeWindow.to),
      status,
      page,
      pageSize: PAGE_SIZE
    })
      .then((result) => {
        if (!active) return;
        setHistory(result);
      })
      .catch((cause) => {
        if (!active) return;
        setError(cause instanceof Error ? cause.message : "Failed to load transmission history");
      })
      .finally(() => {
        if (!active) return;
        setLoading(false);
      });

    return () => {
      active = false;
    };
  }, [deviceId, page, status, timeWindow.from, timeWindow.to]);

  useEffect(() => {
    if (!tableScrollRef.current) return;
    tableScrollRef.current.scrollTop = 0;
  }, [deviceId, page, range, status]);

  return (
    <div className="page page--history">
      <div className="history-overview">
        <header className="topbar history-topbar">
          <div className="topbar__left">
            <div className="topbar__title">Transmission History</div>
            <div className="topbar__status">
              {selectedDevice ? `Device: ${selectedDevice.name ?? selectedDevice.externalId}` : "Device: all registered nodes"}
              {" | "}Window: {ranges.find((item) => item.key === range)?.label ?? "Custom"}
              {history?.summary.latestTs ? ` | Latest ${formatRelativeTime(history.summary.latestTs)}` : ""}
              {loading ? " | Refreshing" : ""}
            </div>
          </div>
          <div className="topbar__controls">
            <select aria-label="Device" value={deviceId} onChange={(event) => setDeviceId(event.target.value)}>
              <option value="">All devices</option>
              {devices.map((device) => (
                <option key={device.externalId} value={device.externalId}>
                  {device.name ? `${device.name} (${device.externalId})` : device.externalId}
                </option>
              ))}
            </select>

            <div className="segmented" role="group" aria-label="History range">
              {ranges.map((item) => (
                <button key={item.key} type="button" data-active={range === item.key} onClick={() => setRange(item.key)}>
                  {item.label}
                </button>
              ))}
            </div>

            <select aria-label="Transmission status" value={status} onChange={(event) => setStatus(event.target.value as StatusFilter)}>
              {statusOptions.map((option) => (
                <option key={option.value} value={option.value}>
                  {option.label}
                </option>
              ))}
            </select>
          </div>
        </header>

        {error && <div className="error history-error">{error}</div>}

        {history && (
          <>
            <div className="history-summary-grid">
              <div className="history-summary-card">
                <div className="history-summary-card__label">Total transmissions</div>
                <div className="history-summary-card__value">{formatCount(history.summary.totalRows)}</div>
                <div className="history-summary-card__meta">
                  {formatDateTime(history.filters.from)} to {formatDateTime(history.filters.to)}
                </div>
              </div>

              <div className="history-summary-card">
                <div className="history-summary-card__label">Devices represented</div>
                <div className="history-summary-card__value">{formatCount(history.summary.deviceCount)}</div>
                <div className="history-summary-card__meta">
                  {selectedDevice ? "Single-node filter applied" : "All devices in current window"}
                </div>
              </div>

              <div className="history-summary-card">
                <div className="history-summary-card__label">Latest transmission</div>
                <div className="history-summary-card__value">{formatRelativeTime(history.summary.latestTs)}</div>
                <div className="history-summary-card__meta">{formatDateTime(history.summary.latestTs)}</div>
              </div>

              <div className="history-summary-card">
                <div className="history-summary-card__label">Average device interval</div>
                <div className="history-summary-card__value">
                  {history.summary.averageGapSec == null ? "No cadence yet" : formatDurationValue(history.summary.averageGapSec)}
                </div>
                <div className="history-summary-card__meta">
                  Earliest in window: {formatDateTime(history.summary.earliestTs)}
                </div>
              </div>
            </div>

            <div className="history-status-strip">
              {(Object.keys(statusLabels) as TransmissionStatus[]).map((statusKey) => (
                <div key={statusKey} className={`history-status-pill history-status-pill--${statusKey}`}>
                  <span>{statusLabels[statusKey]}</span>
                  <strong>{formatCount(history.summary.statusCounts[statusKey])}</strong>
                </div>
              ))}
            </div>
          </>
        )}
      </div>

      {history && (
        <section className="history-table-panel">
          <div className="dashboard-section__header">
            <div>
              <h2 className="dashboard-section__title">Received telemetry</h2>
              <span className="dashboard-section__hint">
                Each row is a stored device transmission with its most relevant air, power, and runtime values.
              </span>
            </div>
          </div>

          {history.rows.length === 0 ? (
            <div className="chart__empty" style={{ height: 220 }}>
              No transmissions match the current filters.
            </div>
          ) : (
            <div ref={tableScrollRef} className="aqi-table-wrapper history-table-wrapper history-table-scroll">
              <div className="history-table-shadow" />
              <div className="history-table-inner">
                <table className="aqi-table history-table">
                  <thead>
                    <tr>
                      <th>Timestamp</th>
                      <th>Device</th>
                      <th>State</th>
                      <th>Gap</th>
                      <th>Pollutants</th>
                      <th>Environment</th>
                      <th>Runtime</th>
                    </tr>
                  </thead>
                  <tbody>
                    {history.rows.map((row) => (
                      <tr key={row.id}>
                        <td>
                          <div className="history-cell-stack">
                            <strong>{formatDateTime(row.ts)}</strong>
                            <span>{formatRelativeTime(row.ts)}</span>
                          </div>
                        </td>
                        <td>
                          <div className="history-cell-stack">
                            <strong>{row.deviceName ?? row.deviceExternalId}</strong>
                            <span>{row.deviceExternalId}</span>
                          </div>
                        </td>
                        <td>
                          <div className="history-cell-stack">
                            <span className={`history-badge history-badge--${row.transmissionStatus}`}>
                              {statusLabels[row.transmissionStatus]}
                            </span>
                            <span>{formatSo2Detail(row)}</span>
                          </div>
                        </td>
                        <td>
                          <div className="history-cell-stack">
                            <strong>{formatGap(row.gapSec)}</strong>
                            <span>{formatPowerState(row)}</span>
                          </div>
                        </td>
                        <td>
                          <div className="history-metric-list">
                            <span>PM2.5: {formatMetric(row.pm25ugm3, 1, "ug/m3")}</span>
                            <span>PM10: {formatMetric(row.pm10ugm3, 1, "ug/m3")}</span>
                            <span>SO2: {formatMetric(row.so2Ppb, 1, "ppb")}</span>
                            <span>CO: {formatMetric(row.micsCoPpm, 1, "ppm")}</span>
                            <span>NO2: {formatMetric(row.micsNo2Ppb, 1, "ppb")}</span>
                            <span>VOC: {formatWholeMetric(row.vocIndex, "index")}</span>
                          </div>
                        </td>
                        <td>
                          <div className="history-metric-list">
                            <span>CO2: {formatWholeMetric(row.co2ppm, "ppm")}</span>
                            <span>Temp: {formatMetric(row.tempC, 1, "C")}</span>
                            <span>Humidity: {formatMetric(row.rh, 1, "%")}</span>
                            <span>Battery: {formatMetric(row.batteryVoltage, 2, "V")}</span>
                          </div>
                        </td>
                        <td>
                          <div className="history-metric-list">
                            <span>Uptime: {formatDurationValue(row.uptimeSec)}</span>
                            <span>Boot: {row.bootCount != null ? `#${row.bootCount}` : "—"}</span>
                            <span>Reset: {formatResetReason(row.resetReason)}</span>
                            <span>NH3: {formatMetric(row.micsNh3Ppm, 2, "ppm")}</span>
                          </div>
                        </td>
                      </tr>
                    ))}
                  </tbody>
                </table>
              </div>
            </div>
          )}

          <div className="history-pagination">
            <div className="history-pagination__summary">{formatPageRange(history)}</div>
            <div className="history-pagination__controls">
              <button
                className="history-pagination__button"
                disabled={!history.pagination.hasPreviousPage || loading}
                onClick={() => setPage((current) => Math.max(1, current - 1))}
                type="button"
              >
                Previous
              </button>
              <span className="history-pagination__page">
                Page {history.pagination.page} of {history.pagination.totalPages}
              </span>
              <button
                className="history-pagination__button"
                disabled={!history.pagination.hasNextPage || loading}
                onClick={() => setPage((current) => current + 1)}
                type="button"
              >
                Next
              </button>
            </div>
          </div>
        </section>
      )}
    </div>
  );
}
