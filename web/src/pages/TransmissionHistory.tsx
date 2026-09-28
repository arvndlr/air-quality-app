import { useEffect, useMemo, useRef, useState, type FormEvent } from "react";
import { format, formatDistanceToNowStrict, formatISO, parseISO } from "date-fns";
import {
  downloadTransmissionCsv,
  getTransmissionHistory,
  listDevices,
  type Device,
  type TransmissionExportMode,
  type TransmissionHistoryResponse,
  type TransmissionRow,
  type TransmissionStatus
} from "../api";
import { formatDurationCompact, formatResetReason } from "../deviceStatus";
import {
  defaultCustomEnd,
  defaultCustomStart,
  describeRange,
  parseDateSearch,
  rangeOptions,
  resolveRange,
  toDateInputValue,
  type RangeKey
} from "../reportRange";

type StatusFilter = TransmissionStatus | "all";

const PAGE_SIZE = 20;

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

function formatDayLabel(day: string) {
  return format(parseISO(day), "EEE, MMM d, yyyy");
}

function formatRollup(value: number | null, digits: number) {
  if (value == null) return "—";
  return value.toFixed(digits);
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
  const [customFrom, setCustomFrom] = useState<string>(defaultCustomStart);
  const [customTo, setCustomTo] = useState<string>(defaultCustomEnd);
  const [status, setStatus] = useState<StatusFilter>("all");
  const [page, setPage] = useState(1);
  const [history, setHistory] = useState<TransmissionHistoryResponse | null>(null);
  const [loading, setLoading] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const [exporting, setExporting] = useState<TransmissionExportMode | null>(null);
  const [searchText, setSearchText] = useState("");
  const [searchError, setSearchError] = useState<string | null>(null);
  const tableScrollRef = useRef<HTMLDivElement | null>(null);

  const resolved = useMemo(() => resolveRange(range, customFrom, customTo), [range, customFrom, customTo]);
  const rangeError = resolved.error;
  const fromIso = rangeError ? null : formatISO(resolved.from);
  const toIso = rangeError ? null : formatISO(resolved.to);
  const windowLabel = describeRange(range, resolved.from, resolved.to);
  const todayValue = toDateInputValue(new Date());
  const selectedDevice = devices.find((device) => device.externalId === deviceId) ?? null;

  function showDates(from: string, to: string) {
    setRange("custom");
    setCustomFrom(from);
    setCustomTo(to);
  }

  function handleSearch(event: FormEvent<HTMLFormElement>) {
    event.preventDefault();
    const result = parseDateSearch(searchText);

    if ("error" in result) {
      setSearchError(result.error);
      return;
    }

    setSearchError(null);
    showDates(result.from, result.to);
  }

  function clearSearch() {
    setSearchText("");
    setSearchError(null);
    setRange("week");
  }

  async function handleExport(mode: TransmissionExportMode) {
    if (!fromIso || !toIso) return;

    setExporting(mode);
    setError(null);

    try {
      await downloadTransmissionCsv({ deviceId: deviceId || null, from: fromIso, to: toIso, status, mode });
    } catch (cause) {
      setError(cause instanceof Error ? cause.message : "Failed to export the transmission log");
    } finally {
      setExporting(null);
    }
  }

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
  }, [deviceId, range, customFrom, customTo, status]);

  useEffect(() => {
    if (!fromIso || !toIso) return;

    let active = true;
    setLoading(true);
    setError(null);

    getTransmissionHistory({
      deviceId: deviceId || null,
      from: fromIso,
      to: toIso,
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
  }, [deviceId, page, status, fromIso, toIso]);

  useEffect(() => {
    if (!tableScrollRef.current) return;
    tableScrollRef.current.scrollTop = 0;
  }, [deviceId, page, range, customFrom, customTo, status]);

  return (
    <div className="page page--history">
      <div className="history-overview">
        <header className="topbar history-topbar">
          <div className="topbar__left">
            <div className="topbar__title">Transmission History</div>
            <div className="topbar__status">
              {selectedDevice ? `Device: ${selectedDevice.name ?? selectedDevice.externalId}` : "Device: all registered nodes"}
              {" | "}Window: {windowLabel}
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
              {rangeOptions.map((item) => (
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

        <form className="history-search" role="search" onSubmit={handleSearch}>
          <label className="history-search__field">
            <span>Search by date</span>
            <input
              type="search"
              value={searchText}
              placeholder="e.g. 2026-09-15, Sep 15, 9/15/2026, Sep 2026, or Sep 1 to Sep 5"
              aria-invalid={searchError != null}
              onChange={(event) => {
                setSearchText(event.target.value);
                if (searchError) setSearchError(null);
              }}
            />
          </label>
          <button className="report-print-button" type="submit">
            Search
          </button>
          {(searchText || range === "custom") && (
            <button className="date-search-bar__reset" type="button" onClick={clearSearch}>
              Clear
            </button>
          )}
          {searchError && <div className="history-search__error">{searchError}</div>}
        </form>

        <div className="date-search-bar">
          {range === "custom" ? (
            <div className="date-search-bar__fields">
              <label className="date-search-field">
                <span>From date</span>
                <input
                  type="date"
                  max={customTo || todayValue}
                  value={customFrom}
                  onChange={(event) => setCustomFrom(event.target.value)}
                />
              </label>
              <label className="date-search-field">
                <span>To date</span>
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
              Use the search above, or choose <strong>Custom dates</strong>, to trace back a specific day or date range.
            </div>
          )}

          <div className="date-search-bar__actions">
            <button
              className="report-print-button"
              type="button"
              disabled={!fromIso || exporting != null}
              onClick={() => handleExport("detail")}
            >
              {exporting === "detail" ? "Saving..." : "Save log (CSV)"}
            </button>
            <button
              className="report-print-button report-print-button--ghost"
              type="button"
              disabled={!fromIso || exporting != null}
              onClick={() => handleExport("daily")}
            >
              {exporting === "daily" ? "Saving..." : "Save daily summary (CSV)"}
            </button>
          </div>
        </div>

        {rangeError && <div className="error history-error">{rangeError}</div>}
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
        <section className="history-table-panel daily-summary-panel">
          <div className="dashboard-section__header">
            <div>
              <h2 className="dashboard-section__title">Daily summary</h2>
              <span className="dashboard-section__hint">
                One row per calendar day in the searched window, with transmission counts and the average and peak reading of
                each pollutant.
              </span>
            </div>
          </div>

          {history.daily.length === 0 ? (
            <div className="chart__empty" style={{ height: 180 }}>
              No days to summarise for the current search.
            </div>
          ) : (
            <div className="aqi-table-wrapper history-table-wrapper">
              <table className="aqi-table history-table daily-summary-table">
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
                        <div className="history-cell-stack">
                          <strong>{formatDayLabel(day.day)}</strong>
                          <span>
                            {formatDateTime(day.firstTs)} to {formatDateTime(day.lastTs)}
                          </span>
                          {history.daily.length > 1 && (
                            <button
                              className="history-day-link"
                              type="button"
                              onClick={() => {
                                setSearchText(day.day);
                                setSearchError(null);
                                showDates(day.day, day.day);
                              }}
                            >
                              View this day's log
                            </button>
                          )}
                        </div>
                      </td>
                      <td>
                        <div className="history-cell-stack">
                          <strong>{formatCount(day.totalRows)}</strong>
                          <span>
                            {formatCount(day.deviceCount)} {day.deviceCount === 1 ? "device" : "devices"}
                          </span>
                        </div>
                      </td>
                      <td>
                        <div className="history-metric-list">
                          <span>Ready: {formatCount(day.statusCounts.ready)}</span>
                          <span>Warming: {formatCount(day.statusCounts.warming)}</span>
                          <span>Calibrating: {formatCount(day.statusCounts.calibrating)}</span>
                          <span>Unknown: {formatCount(day.statusCounts.unknown)}</span>
                        </div>
                      </td>
                      <td>
                        <div className="history-cell-stack">
                          <strong>{day.averageGapSec == null ? "Single sample" : formatDurationValue(day.averageGapSec)}</strong>
                          <span>Average interval</span>
                        </div>
                      </td>
                      <td>
                        <div className="history-metric-list">
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
                        <div className="history-metric-list">
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
      )}

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
