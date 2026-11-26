import { useCallback, useEffect, useMemo, useState, type ReactNode } from "react";
import { endOfDay, format, formatDistanceToNowStrict, parseISO, startOfDay, subDays } from "date-fns";
import {
  CartesianGrid,
  Line,
  LineChart,
  ReferenceArea,
  ResponsiveContainer,
  Tooltip,
  XAxis,
  YAxis
} from "recharts";
import {
  deleteRecords,
  getAnalyticsOverview,
  getRetentionStatus,
  listDevices,
  previewRecordDeletion,
  type AnalyticsEvent,
  type AnalyticsOverview,
  type AnalyticsPeriodCell,
  type AnalyticsPollutantRow,
  type Device,
  type IndexBasis,
  type PollutantKey,
  type RecordDeleteRequest,
  type RetentionStatus
} from "../api";
import { AQI_CATEGORIES, categoryByKey, categoryForIndex } from "../aqiScale";
import { toDateInputValue } from "../reportRange";

type RangeKey = "1d" | "3d" | "7d" | "30d" | "custom";

const RANGE_OPTIONS: Array<{ key: RangeKey; label: string; days: number }> = [
  { key: "1d", label: "Today", days: 1 },
  { key: "3d", label: "3 Days", days: 3 },
  { key: "7d", label: "7 Days", days: 7 },
  { key: "30d", label: "30 Days", days: 30 },
  { key: "custom", label: "Custom", days: 0 }
];

const PERIODS = [
  { key: "1h", label: "1-Hour" },
  { key: "8h", label: "8-Hour" },
  { key: "24h", label: "24-Hour" }
] as const;

const SERIES_COLORS: Record<PollutantKey, string> = {
  pm25: "#2563eb",
  pm10: "#0891b2",
  so2: "#d97706",
  co: "#64748b",
  no2: "#a21caf",
  co2: "#15803d",
  voc: "#be123c",
  nh3: "#7c3aed"
};

const BASIS_LABEL: Record<IndexBasis, { label: string; hint: string }> = {
  denr: { label: "DENR AQI", hint: "Official DENR-EMB AQI breakpoints" },
  "denr-estimated": {
    label: "Estimated",
    hint: "DENR breakpoints, but the reading comes from the uncalibrated MiCS-6814. It does not set the overall AQI."
  },
  guideline: {
    label: "% of guideline",
    hint: "No DENR AQI breakpoints. The index is the percentage of the 24-hour guideline value (80 ppb). Estimated sensor."
  },
  indicator: { label: "Indicator", hint: "Not a criteria pollutant. Guidance-based bands for ventilation and comfort." }
};

// ---- Formatting -----------------------------------------------------------------------

function fmt(value: number | null | undefined, unit?: string) {
  if (value == null) return "—";
  const abs = Math.abs(value);
  const digits = abs >= 100 ? 0 : abs >= 10 ? 1 : abs >= 1 ? 2 : 3;
  const text = value.toLocaleString("en-US", { maximumFractionDigits: digits, minimumFractionDigits: 0 });
  return unit ? `${text} ${unit}` : text;
}

function fmtDay(day: string) {
  return format(parseISO(day), "MMM d, yyyy");
}

function fmtDateTime(iso: string | null) {
  return iso ? format(new Date(iso), "MMM d, yyyy h:mm a") : "—";
}

function resolveRange(range: RangeKey, customFrom: string, customTo: string) {
  const now = new Date();
  if (range === "custom") {
    const from = customFrom ? startOfDay(parseISO(customFrom)) : startOfDay(subDays(now, 6));
    const to = customTo ? endOfDay(parseISO(customTo)) : now;
    return { from, to: to > now ? now : to };
  }
  const days = RANGE_OPTIONS.find((o) => o.key === range)!.days;
  return { from: startOfDay(subDays(now, days - 1)), to: now };
}

// ---- Small components -----------------------------------------------------------------

function CategoryBadge(props: { index?: number | null; categoryKey?: string | null; small?: boolean }) {
  const category =
    props.categoryKey != null ? categoryByKey(props.categoryKey) : props.index != null ? categoryForIndex(props.index) : null;
  if (!category) return <span className="an-badge an-badge--empty">No data</span>;
  return (
    <span
      className={`an-badge${props.small ? " an-badge--small" : ""}`}
      style={{ background: category.color, color: category.ink }}
    >
      {category.label}
    </span>
  );
}

function BasisBadge({ basis }: { basis: IndexBasis }) {
  const info = BASIS_LABEL[basis];
  return (
    <span className={`an-basis an-basis--${basis}`} title={info.hint}>
      {info.label}
    </span>
  );
}

function Section(props: { title: string; subtitle?: string; actions?: ReactNode; children: ReactNode; id?: string }) {
  return (
    <section className="an-section" id={props.id}>
      <header className="an-section__header">
        <div>
          <h2 className="an-section__title">{props.title}</h2>
          {props.subtitle && <p className="an-section__subtitle">{props.subtitle}</p>}
        </div>
        {props.actions && <div className="an-section__actions">{props.actions}</div>}
      </header>
      <div className="an-section__body">{props.children}</div>
    </section>
  );
}

// ---- Alerts ---------------------------------------------------------------------------

function AlertBanner({ alerts, onOpen }: { alerts: AnalyticsEvent[]; onOpen: (id: number) => void }) {
  if (alerts.length === 0) return null;
  return (
    <div className="an-alerts" role="alert">
      <div className="an-alerts__heading">
        <span className="an-alerts__pulse" aria-hidden="true" />
        {alerts.length} active air quality alert{alerts.length === 1 ? "" : "s"}
      </div>
      <div className="an-alerts__list">
        {alerts.map((alert) => (
          <button
            key={alert.id}
            type="button"
            className={`an-alert${alert.persistent ? " an-alert--persistent" : ""}`}
            style={{ borderColor: alert.color }}
            onClick={() => onOpen(alert.id)}
          >
            <span className="an-alert__swatch" style={{ background: alert.color }} />
            <span className="an-alert__text">
              <strong>{alert.title}</strong>
              <span>
                {alert.persistent ? `Persistent for ${alert.consecutiveDays} days · ` : ""}
                Peak {fmt(alert.peakValue, alert.unit ?? undefined)}
                {alert.basis !== "denr" ? " · verify (estimated sensor)" : ""}
              </span>
            </span>
            <span className="an-alert__more">Details →</span>
          </button>
        ))}
      </div>
    </div>
  );
}

// ---- Overview cards -------------------------------------------------------------------

function OverviewCards({ data }: { data: AnalyticsOverview }) {
  const { current, summary } = data;
  const category = categoryByKey(current.category);
  return (
    <div className="an-cards">
      <div
        className="an-card an-card--hero"
        style={category ? { background: `${category.color}22`, borderColor: category.color } : undefined}
      >
        <div className="an-card__label">Overall air quality</div>
        <div className="an-card__hero-value" style={{ color: category && category.key !== "fair" ? category.color : undefined }}>
          {current.categoryLabel ?? "No current data"}
        </div>
        <div className="an-card__meta">{current.basis ?? "No representative average yet"}</div>
      </div>
      <div className="an-card">
        <div className="an-card__label">Current AQI</div>
        <div className="an-card__value" style={{ color: category?.color }}>
          {current.aqi ?? "—"}
        </div>
        <div className="an-card__meta">{current.official ? "Official (≥75% data capture)" : "Provisional / indicative"}</div>
      </div>
      <div className="an-card">
        <div className="an-card__label">Main pollutant</div>
        <div className="an-card__value an-card__value--text">{current.dominantLabel ?? "—"}</div>
        <div className="an-card__meta">{fmt(current.dominantValue, current.dominantUnit ?? undefined)}</div>
      </div>
      <div className="an-card">
        <div className="an-card__label">Peak daily AQI (range)</div>
        <div className="an-card__value" style={{ color: summary.peakAqi != null ? categoryForIndex(summary.peakAqi).color : undefined }}>
          {summary.peakAqi ?? "—"}
        </div>
        <div className="an-card__meta">{summary.peakDay ? fmtDay(summary.peakDay) : "No daily data"}</div>
      </div>
      <div className="an-card">
        <div className="an-card__label">Data samples (range)</div>
        <div className="an-card__value an-card__value--accent">{data.samplesInRange.toLocaleString("en-US")}</div>
        <div className="an-card__meta">
          Last sample {current.lastSampleAt ? formatDistanceToNowStrict(new Date(current.lastSampleAt), { addSuffix: true }) : "—"}
        </div>
      </div>
    </div>
  );
}

// ---- Pollutant table --------------------------------------------------------------------

function PeriodCellView({ cell, unit }: { cell: AnalyticsPeriodCell; unit: string }) {
  const category = cell.index != null ? categoryForIndex(cell.index) : null;
  return (
    <td className={`an-cell${cell.regulatory ? " an-cell--regulatory" : ""}`}>
      <div className="an-cell__value">{fmt(cell.avg)}</div>
      {cell.avg != null && (
        <div className="an-cell__meta">
          {category && <span className="an-dot" style={{ background: category.color }} title={category.label} />}
          <span title={`${cell.capture.have} of ${cell.capture.of} ${cell.capture.unit} with data; ${cell.capture.need} needed`}>
            {cell.capture.have}/{cell.capture.of} {cell.capture.unit === "minutes" ? "min" : "h"}
          </span>
          {!cell.valid && <span className="an-cell__flag">provisional</span>}
        </div>
      )}
      <span className="an-sr">{unit}</span>
    </td>
  );
}

function PollutantTable({ rows }: { rows: AnalyticsPollutantRow[] }) {
  return (
    <div className="an-table-wrap">
      <table className="an-table">
        <thead>
          <tr>
            <th rowSpan={2}>Pollutant</th>
            <th rowSpan={2}>Unit</th>
            <th colSpan={4} className="an-table__group">
              Average concentration
            </th>
            <th rowSpan={2}>AQI (sub-index)</th>
            <th rowSpan={2}>Category</th>
            <th rowSpan={2}>Basis</th>
          </tr>
          <tr>
            {PERIODS.map((p) => (
              <th key={p.key}>{p.label}</th>
            ))}
            <th>Annual</th>
          </tr>
        </thead>
        <tbody>
          {rows.map((row) => {
            const regulatory = row.aqiPeriod === "8h" ? row.periods["8h"] : row.periods["24h"];
            return (
              <tr key={row.key}>
                <th scope="row" className="an-table__pollutant">
                  {row.label}
                </th>
                <td className="an-table__unit">{row.unit}</td>
                {PERIODS.map((p) => (
                  <PeriodCellView key={p.key} cell={row.periods[p.key]} unit={row.unit} />
                ))}
                <td className="an-cell">
                  <div className="an-cell__value">{fmt(row.annual.avg)}</div>
                  {row.annual.avg != null && (
                    <div className="an-cell__meta">
                      <span title={`${row.annual.method} mean of quarterly means; ${row.annual.validDays} representative days`}>
                        {row.annual.representativeQuarters}/4 quarters
                      </span>
                      {row.annual.exceedsGuideline && <span className="an-cell__flag an-cell__flag--bad">above guideline</span>}
                    </div>
                  )}
                </td>
                <td className="an-table__index">
                  {regulatory.index ?? "—"}
                  {regulatory.index != null && !regulatory.valid && <span className="an-table__asterisk">*</span>}
                </td>
                <td>
                  {regulatory.index != null ? <CategoryBadge index={regulatory.index} small /> : <span className="an-muted">—</span>}
                </td>
                <td>
                  <BasisBadge basis={row.basis} />
                </td>
              </tr>
            );
          })}
        </tbody>
      </table>
      <p className="an-note">
        Highlighted columns are the averaging period DENR uses for each pollutant's AQI (24-hour for PM2.5, PM10, SO2 and
        NO2; 8-hour for CO). <strong>*</strong> or "provisional" means the window has less than the required 75% data
        capture. The overall AQI uses PM2.5, PM10 and SO2 only; CO and NO2 are estimated by an uncalibrated sensor, and
        CO2, VOC and NH3 are indicators.
      </p>
    </div>
  );
}

// ---- Computation explainer ------------------------------------------------------------

function Computation({ data }: { data: AnalyticsOverview }) {
  const c = data.current.computation;
  return (
    <div className="an-grid an-grid--compute">
      <div>
        <p>
          Each pollutant's AQI is found by linear interpolation between the DENR-EMB breakpoints that bracket its average
          concentration. The overall AQI is the highest sub-index.
        </p>
        <div className="an-formula" aria-label="Ip equals (I high minus I low) over (BP high minus BP low) times (Cp minus BP low) plus I low">
          <span>I<sub>p</sub> =</span>
          <span className="an-formula__frac">
            <span>I<sub>Hi</sub> − I<sub>Lo</sub></span>
            <span>BP<sub>Hi</sub> − BP<sub>Lo</sub></span>
          </span>
          <span>× (C<sub>p</sub> − BP<sub>Lo</sub>) + I<sub>Lo</sub></span>
        </div>
        <ul className="an-defs">
          <li><strong>I<sub>p</sub></strong> AQI sub-index for the pollutant</li>
          <li><strong>C<sub>p</sub></strong> average concentration, truncated (PM2.5 to 0.1, PM10 to 1, SO2 to 0.001 ppm, CO to 0.1 ppm)</li>
          <li><strong>BP<sub>Lo</sub>, BP<sub>Hi</sub></strong> breakpoints that bracket C<sub>p</sub></li>
          <li><strong>I<sub>Lo</sub>, I<sub>Hi</sub></strong> AQI values at those breakpoints</li>
        </ul>
      </div>
      <div className="an-example">
        {c ? (
          <>
            <div className="an-example__title">
              Live example: {c.label} ({c.averaging} average)
            </div>
            <ul>
              <li>
                Measured average: {fmt(c.sensorValue, c.sensorUnit)}
                {c.unit !== c.sensorUnit ? ` → Cp = ${c.cp} ${c.unit}` : ` → Cp = ${c.cp} ${c.unit}`}
              </li>
              <li>
                Breakpoints: {c.bpLo} – {c.bpHi} {c.unit} → AQI {c.iLo} – {c.iHi} ({categoryForIndex(c.subIndex).label})
              </li>
            </ul>
            <div className="an-example__math">
              I<sub>p</sub> = ({c.iHi} − {c.iLo}) / ({c.bpHi} − {c.bpLo}) × ({c.cp} − {c.bpLo}) + {c.iLo} = {c.exact} ≈{" "}
              <strong>{c.subIndex}</strong>
            </div>
            <div className="an-muted">{data.current.basis}</div>
          </>
        ) : (
          <div className="an-muted">No current average is available to show a worked example.</div>
        )}
      </div>
    </div>
  );
}

function AveragingRules() {
  return (
    <div className="an-grid an-grid--two">
      <table className="an-table an-table--compact">
        <thead>
          <tr>
            <th>Averaging period</th>
            <th>Applies to</th>
            <th>Purpose</th>
          </tr>
        </thead>
        <tbody>
          <tr>
            <td>1-Hour</td>
            <td>CO (guideline 30 ppm)</td>
            <td>Short-term (acute) exposure; real-time indication for the others</td>
          </tr>
          <tr>
            <td>8-Hour</td>
            <td>CO (AQI and 9 ppm guideline)</td>
            <td>Prolonged short-term exposure</td>
          </tr>
          <tr>
            <td>24-Hour</td>
            <td>PM2.5, PM10, SO2 (AQI); NO2 (guideline)</td>
            <td>Daily air quality and public health advisories</td>
          </tr>
          <tr>
            <td>Annual</td>
            <td>PM2.5, PM10 (geometric mean); SO2 (arithmetic mean)</td>
            <td>Long-term exposure and attainment of guideline values</td>
          </tr>
        </tbody>
      </table>
      <div>
        <div className="an-subtitle">Data capture rules (75%)</div>
        <ul className="an-list">
          <li>An hour counts when it has at least 45 minutes of readings.</li>
          <li>An 8-hour average needs at least 6 representative hours.</li>
          <li>
            A day needs 18 representative hours, at least 6 in each 8-hour period (12–8 AM, 8 AM–4 PM, 4 PM–12 AM), and no more
            than 2 missing hours in a row.
          </li>
          <li>A month needs 75% representative days; a quarter needs 3 representative months; a year needs 4 quarters.</li>
        </ul>
        <div className="an-muted">Source: DENR-EMB Procedural Manual on Data Handling Conventions (2021), Ch. 2 and 5.</div>
      </div>
    </div>
  );
}

// ---- Trend chart ------------------------------------------------------------------------

function TrendChart({ data }: { data: AnalyticsOverview }) {
  const [series, setSeries] = useState<PollutantKey[]>([]);
  const points = data.trend.map((t) => ({ ...t, label: format(parseISO(t.day), "MMM d"), ...t.indices }));
  const peak = Math.max(
    0,
    ...points.map((p) => p.aqi ?? 0),
    ...series.flatMap((k) => points.map((p) => p.indices[k] ?? 0))
  );
  const yMax = Math.min(500, Math.max(150, Math.ceil((peak + 20) / 50) * 50));

  if (points.length === 0) {
    return <div className="an-empty">No daily averages in this range yet.</div>;
  }

  const toggle = (key: PollutantKey) =>
    setSeries((current) => (current.includes(key) ? current.filter((k) => k !== key) : [...current, key]));

  return (
    <div>
      <div className="an-chips">
        <span className="an-muted">Compare sub-indices:</span>
        {data.pollutants.map((p) => (
          <button
            key={p.key}
            type="button"
            className={`an-chip${series.includes(p.key) ? " an-chip--on" : ""}`}
            style={series.includes(p.key) ? { borderColor: SERIES_COLORS[p.key], color: SERIES_COLORS[p.key] } : undefined}
            onClick={() => toggle(p.key)}
          >
            {p.label}
          </button>
        ))}
      </div>
      <div className="an-chart">
        <ResponsiveContainer width="100%" height={300}>
          <LineChart data={points} margin={{ top: 10, right: 16, bottom: 0, left: -10 }}>
            {AQI_CATEGORIES.map((c) => (
              <ReferenceArea key={c.key} y1={c.min} y2={Math.min(c.max + 1, yMax)} fill={c.color} fillOpacity={0.09} ifOverflow="hidden" />
            ))}
            <CartesianGrid strokeDasharray="3 3" stroke="rgba(15,23,42,0.08)" />
            <XAxis dataKey="label" tick={{ fontSize: 12 }} />
            <YAxis
              domain={[0, yMax]}
              ticks={[0, 50, 100, 150, 200, 300, 500].filter((v) => v <= yMax)}
              tick={{ fontSize: 12 }}
            />
            <Tooltip
              content={({ active, payload }) => {
                if (!active || !payload?.length) return null;
                const p = payload[0]!.payload as (typeof points)[number];
                return (
                  <div className="an-tooltip">
                    <strong>{fmtDay(p.day)}</strong>
                    <div>
                      AQI {p.aqi ?? "—"} {p.aqi != null && `(${categoryForIndex(p.aqi).label})`}
                    </div>
                    <div className="an-muted">
                      {p.provisional ? "Day in progress" : p.valid ? "Representative day" : "Under 75% data capture"} ·{" "}
                      {p.samples.toLocaleString("en-US")} samples
                    </div>
                    {series.map((k) => (
                      <div key={k} style={{ color: SERIES_COLORS[k] }}>
                        {data.pollutants.find((x) => x.key === k)?.label}: {p.indices[k] ?? "—"}
                      </div>
                    ))}
                  </div>
                );
              }}
            />
            <Line
              type="monotone"
              dataKey="aqi"
              name="Daily AQI"
              stroke="#334155"
              strokeWidth={2}
              connectNulls
              isAnimationActive={false}
              dot={(props: { cx?: number; cy?: number; payload?: (typeof points)[number]; index?: number }) => {
                const { cx, cy, payload } = props;
                if (cx == null || cy == null || payload?.aqi == null) return <g key={props.index} />;
                const color = categoryForIndex(payload.aqi).color;
                return (
                  <circle
                    key={props.index}
                    cx={cx}
                    cy={cy}
                    r={5}
                    fill={payload.valid ? color : "#fff"}
                    stroke={color}
                    strokeWidth={2}
                  />
                );
              }}
            />
            {series.map((k) => (
              <Line
                key={k}
                type="monotone"
                dataKey={k}
                stroke={SERIES_COLORS[k]}
                strokeWidth={1.5}
                strokeDasharray="5 3"
                dot={false}
                connectNulls
                isAnimationActive={false}
              />
            ))}
          </LineChart>
        </ResponsiveContainer>
      </div>
      <p className="an-note">
        Filled dots are representative days (≥18 valid hours); hollow dots have less data and are provisional. Background
        bands show the DENR categories.
      </p>
    </div>
  );
}

// ---- Top pollutants -------------------------------------------------------------------

function TopPollutants({ data }: { data: AnalyticsOverview }) {
  if (data.topPollutants.length === 0) return <div className="an-empty">No pollutant data in this range.</div>;
  return (
    <table className="an-table an-table--compact">
      <thead>
        <tr>
          <th>Rank</th>
          <th>Pollutant</th>
          <th>Peak daily value</th>
          <th>Index</th>
          <th>Category</th>
          <th>Days elevated</th>
        </tr>
      </thead>
      <tbody>
        {data.topPollutants.map((p) => (
          <tr key={p.key}>
            <td>
              <span className="an-rank" style={{ background: p.color, color: categoryByKey(p.category)?.ink }}>
                {p.rank}
              </span>
            </td>
            <td>
              <strong>{p.label}</strong> <BasisBadge basis={p.basis} />
            </td>
            <td>
              {fmt(p.peakValue, p.unit)}
              <div className="an-muted">{fmtDay(p.peakDay)}</div>
            </td>
            <td className="an-table__index">{p.peakIndex}</td>
            <td>
              <CategoryBadge categoryKey={p.category} small />
            </td>
            <td>{p.elevatedDays}</td>
          </tr>
        ))}
      </tbody>
    </table>
  );
}

// ---- Events ---------------------------------------------------------------------------

type EventFilter = "all" | "active" | "persistent" | "spike";

function EventCard({ event, open, onToggle }: { event: AnalyticsEvent; open: boolean; onToggle: () => void }) {
  const ev = event.evidence;
  return (
    <article
      id={`event-${event.id}`}
      className={`an-event${event.persistent ? " an-event--persistent" : ""}${event.status === "ACTIVE" ? " an-event--active" : ""}`}
      style={{ borderLeftColor: event.color }}
    >
      <button type="button" className="an-event__head" onClick={onToggle} aria-expanded={open}>
        <span className="an-event__title">
          {event.title}
          {event.status === "ACTIVE" && <span className="an-tag an-tag--active">Active</span>}
          {event.persistent && <span className="an-tag an-tag--persistent">{event.consecutiveDays} days in a row</span>}
          {event.kind === "spike" && <span className="an-tag">Short spike</span>}
          {event.basis !== "denr" && <BasisBadge basis={event.basis} />}
        </span>
        <span className="an-event__when">
          {format(new Date(event.startedAt), "MMM d, yyyy")}
          {event.consecutiveDays > 1 && ` – ${format(new Date(new Date(event.lastSeenAt).getTime() - 1), "MMM d")}`}
        </span>
        <CategoryBadge categoryKey={event.severity} small />
      </button>

      {open && (
        <div className="an-event__body">
          <p>{event.description}</p>

          {ev && ev.days.length > 1 && (
            <div className="an-event__days">
              {ev.days.map((d) => (
                <div key={d.day} className="an-event__day" style={{ borderTopColor: categoryByKey(d.category)?.color }}>
                  <span>{format(parseISO(d.day), "MMM d")}</span>
                  <strong>{fmt(d.indexValue, event.unit ?? undefined)}</strong>
                  <span className="an-muted">index {d.index ?? "—"}</span>
                </div>
              ))}
            </div>
          )}

          <div className="an-grid an-grid--event">
            <div>
              <div className="an-subtitle">Why it rose</div>
              <ul className="an-list">
                {event.possibleCauses?.findings.map((f) => (
                  <li key={f.text} className={f.basis === "caveat" ? "an-list__caveat" : undefined}>
                    {f.text}
                  </li>
                ))}
              </ul>
              {event.possibleCauses && event.possibleCauses.likelySources.length > 0 && (
                <>
                  <div className="an-subtitle">Likely sources</div>
                  <ul className="an-list">
                    {event.possibleCauses.likelySources.map((s) => (
                      <li key={s}>{s}</li>
                    ))}
                  </ul>
                </>
              )}
            </div>
            <div>
              <div className="an-subtitle">Health effects</div>
              <ul className="an-list">
                {event.healthEffects.map((h) => (
                  <li key={h}>{h}</li>
                ))}
              </ul>
              <div className="an-subtitle">Most at risk</div>
              <ul className="an-list">
                {event.affectedGroups.map((g) => (
                  <li key={g}>{g}</li>
                ))}
              </ul>
            </div>
            <div>
              <div className="an-subtitle">What the public should do</div>
              <ul className="an-list an-list--check">
                {event.recommendations?.public.map((r) => (
                  <li key={r}>{r}</li>
                ))}
              </ul>
              <div className="an-subtitle">Recommended MENRO actions</div>
              <ul className="an-list an-list--check">
                {event.recommendations?.menro.map((r) => (
                  <li key={r}>{r}</li>
                ))}
              </ul>
            </div>
          </div>
          {event.recommendations?.cautionary && event.recommendations.cautionary !== "None." && (
            <div className="an-cautionary">
              <strong>DENR cautionary statement ({event.severityLabel}):</strong> {event.recommendations.cautionary}
            </div>
          )}
          <div className="an-muted">
            Threshold for sensitive groups: {fmt(event.thresholdValue, event.unit ?? undefined)} · Peak{" "}
            {fmt(event.peakValue, event.unit ?? undefined)} · Average {fmt(event.averageValue, event.unit ?? undefined)}
            {event.endedAt ? ` · Ended ${fmtDateTime(event.endedAt)}` : ""}
          </div>
        </div>
      )}
    </article>
  );
}

function EventsSection({ events, openId, setOpenId }: { events: AnalyticsEvent[]; openId: number | null; setOpenId: (id: number | null) => void }) {
  const [filter, setFilter] = useState<EventFilter>("all");
  const filtered = events.filter((e) =>
    filter === "all"
      ? true
      : filter === "active"
        ? e.status === "ACTIVE"
        : filter === "persistent"
          ? e.persistent
          : e.kind === "spike"
  );
  const counts = {
    all: events.length,
    active: events.filter((e) => e.status === "ACTIVE").length,
    persistent: events.filter((e) => e.persistent).length,
    spike: events.filter((e) => e.kind === "spike").length
  };
  const labels: Record<EventFilter, string> = {
    all: "All",
    active: "Active",
    persistent: "2+ days in a row",
    spike: "Short spikes"
  };

  return (
    <div>
      <div className="an-chips">
        {(Object.keys(labels) as EventFilter[]).map((key) => (
          <button key={key} type="button" className={`an-chip${filter === key ? " an-chip--on" : ""}`} onClick={() => setFilter(key)}>
            {labels[key]} ({counts[key]})
          </button>
        ))}
      </div>
      {filtered.length === 0 ? (
        <div className="an-empty">No elevated readings were recorded for this filter and range.</div>
      ) : (
        <div className="an-events">
          {filtered.map((event) => (
            <EventCard
              key={event.id}
              event={event}
              open={openId === event.id}
              onToggle={() => setOpenId(openId === event.id ? null : event.id)}
            />
          ))}
        </div>
      )}
    </div>
  );
}

// ---- Summary --------------------------------------------------------------------------

function SummarySection({ data }: { data: AnalyticsOverview }) {
  const { summary } = data;
  const [copied, setCopied] = useState(false);

  async function copyAdvisory() {
    try {
      await navigator.clipboard.writeText(summary.advisoryText);
      setCopied(true);
      setTimeout(() => setCopied(false), 2000);
    } catch {
      setCopied(false);
    }
  }

  const avgCategory = summary.averageAqi != null ? categoryForIndex(summary.averageAqi) : null;

  return (
    <>
      <div className="an-grid an-grid--summary">
        <div className="an-panel an-panel--summary" style={avgCategory ? { borderTopColor: avgCategory.color } : undefined}>
          <div className="an-panel__title">Summary</div>
          <p className="an-summary-text">{summary.text}</p>
        </div>
        <div className="an-panel">
          <div className="an-panel__title">Health effects</div>
          {summary.healthEffects.length === 0 ? (
            <p className="an-muted">No health effects are expected at the levels recorded by the calibrated sensors.</p>
          ) : (
            summary.healthEffects.map((h) => (
              <div key={h.pollutant} className="an-health">
                <div className="an-health__label">
                  {h.label} <span className="an-muted">({h.category})</span>
                </div>
                <ul className="an-list">
                  {h.effects.map((e) => (
                    <li key={e}>{e}</li>
                  ))}
                </ul>
              </div>
            ))
          )}
        </div>
        <div className="an-panel">
          <div className="an-panel__title">What to do</div>
          {summary.whatToDo.length === 0 ? (
            <p className="an-muted">Air quality is acceptable. Enjoy normal outdoor activities.</p>
          ) : (
            <ul className="an-list an-list--check">
              {summary.whatToDo.map((w) => (
                <li key={w}>{w}</li>
              ))}
            </ul>
          )}
          {summary.affectedGroups.length > 0 && (
            <>
              <div className="an-subtitle">Most at risk</div>
              <ul className="an-list">
                {summary.affectedGroups.map((g) => (
                  <li key={g}>{g}</li>
                ))}
              </ul>
            </>
          )}
        </div>
      </div>

      <div className="an-grid an-grid--two an-grid--gap">
        <div className="an-panel">
          <div className="an-panel__title">Recommended MENRO / LGU actions</div>
          {summary.menroActions.length === 0 ? (
            <p className="an-muted">Continue routine monitoring.</p>
          ) : (
            <ul className="an-list an-list--check">
              {summary.menroActions.map((a) => (
                <li key={a}>{a}</li>
              ))}
            </ul>
          )}
        </div>
        <div className="an-panel">
          <div className="an-panel__title an-panel__title--row">
            Public advisory draft
            <button type="button" className="an-btn an-btn--small" onClick={copyAdvisory}>
              {copied ? "Copied" : "Copy"}
            </button>
          </div>
          <textarea className="an-advisory" readOnly value={summary.advisoryText} rows={12} />
          <div className="an-muted">Generated from the current readings. Review it before posting.</div>
        </div>
      </div>
    </>
  );
}

// ---- Data management ------------------------------------------------------------------

function DataManagement({ devices }: { devices: Device[] }) {
  const [status, setStatus] = useState<RetentionStatus | null>(null);
  const [error, setError] = useState<string | null>(null);
  const [deviceId, setDeviceId] = useState<string>("");
  const [from, setFrom] = useState(toDateInputValue(subDays(new Date(), 60)));
  const [to, setTo] = useState(toDateInputValue(subDays(new Date(), 31)));
  const [maxCategory, setMaxCategory] = useState<"good" | "fair">("good");
  const [adminKey, setAdminKey] = useState("");
  const [preview, setPreview] = useState<number | null>(null);
  const [busy, setBusy] = useState(false);
  const [message, setMessage] = useState<string | null>(null);

  const load = useCallback(() => {
    getRetentionStatus()
      .then((s) => {
        setStatus(s);
        setError(null);
      })
      .catch((e: Error) => setError(e.message));
  }, []);

  useEffect(load, [load]);

  const request = (): RecordDeleteRequest => ({
    deviceId: deviceId || null,
    from: from ? startOfDay(parseISO(from)).toISOString() : null,
    to: endOfDay(parseISO(to)).toISOString(),
    maxCategory
  });

  async function runPreview() {
    setBusy(true);
    setMessage(null);
    try {
      const result = await previewRecordDeletion(request());
      setPreview(result.count);
    } catch (e) {
      setMessage((e as Error).message);
    } finally {
      setBusy(false);
    }
  }

  async function runDelete() {
    if (preview == null || preview === 0) return;
    const label = maxCategory === "good" ? "Good" : "Good and Fair";
    const ok = window.confirm(
      `Permanently delete up to ${preview.toLocaleString("en-US")} raw ${label} readings from ${from || "the beginning"} to ${to}${
        deviceId ? ` for ${deviceId}` : " for all stations"
      }?\n\nHourly and daily averages, events and elevated readings are kept. This cannot be undone.`
    );
    if (!ok) return;

    setBusy(true);
    setMessage(null);
    try {
      const result = await deleteRecords(request(), adminKey);
      setMessage(`Deleted ${result.deleted.toLocaleString("en-US")} readings.`);
      setPreview(null);
      load();
    } catch (e) {
      setMessage((e as Error).message);
    } finally {
      setBusy(false);
    }
  }

  return (
    <div className="an-grid an-grid--two">
      <div>
        <div className="an-subtitle">Storage and automatic clean-up</div>
        {error && <div className="an-error">{error}</div>}
        {status && (
          <>
            <dl className="an-stats">
              <div>
                <dt>Automatic deletion</dt>
                <dd>
                  {status.autoDeleteEnabled ? `On: Good readings older than ${status.goodRetentionDays} days` : "Off"}
                </dd>
              </div>
              <div>
                <dt>Raw readings stored</dt>
                <dd>{status.rawRows.toLocaleString("en-US")}</dd>
              </div>
              <div>
                <dt>Oldest raw reading</dt>
                <dd>{fmtDateTime(status.oldestRawAt)}</dd>
              </div>
              <div>
                <dt>Due for deletion now</dt>
                <dd>{status.eligibleNow.toLocaleString("en-US")}</dd>
              </div>
              <div>
                <dt>Hourly averages kept</dt>
                <dd>{status.hourlyRows.toLocaleString("en-US")}</dd>
              </div>
              <div>
                <dt>Daily summaries kept</dt>
                <dd>{status.dailyRows.toLocaleString("en-US")}</dd>
              </div>
              <div>
                <dt>Pollution events kept</dt>
                <dd>{status.eventCount.toLocaleString("en-US")}</dd>
              </div>
              <div>
                <dt>Last automatic run</dt>
                <dd>
                  {fmtDateTime(status.lastAutoRun)}
                  {status.lastAutoRun ? ` (${status.lastAutoDeleted.toLocaleString("en-US")} deleted)` : ""}
                </dd>
              </div>
            </dl>
            <p className="an-note">
              Only readings where every pollutant was Good are deleted, and only after they are saved in the permanent hourly
              averages. Readings at Unhealthy for Sensitive Groups or worse are never deleted, so they stay in the
              Transmission History. Daily and annual analytics are computed from the hourly averages, so they don't change.
            </p>
            {status.recentDeletions.length > 0 && (
              <table className="an-table an-table--compact">
                <thead>
                  <tr>
                    <th>When</th>
                    <th>Type</th>
                    <th>Scope</th>
                    <th>Deleted</th>
                  </tr>
                </thead>
                <tbody>
                  {status.recentDeletions.map((d) => (
                    <tr key={d.id}>
                      <td>{fmtDateTime(d.createdAt)}</td>
                      <td>{d.mode === "auto" ? "Automatic" : "Manual"}</td>
                      <td>
                        {d.deviceId ?? "All stations"} · up to {d.maxCategory === "good" ? "Good" : "Fair"} · before{" "}
                        {format(new Date(d.rangeTo), "MMM d, yyyy")}
                      </td>
                      <td>{d.deletedCount.toLocaleString("en-US")}</td>
                    </tr>
                  ))}
                </tbody>
              </table>
            )}
          </>
        )}
      </div>

      <div className="an-panel">
        <div className="an-panel__title">Delete records manually</div>
        <div className="an-form">
          <label>
            Station
            <select value={deviceId} onChange={(e) => { setDeviceId(e.target.value); setPreview(null); }}>
              <option value="">All stations</option>
              {devices.map((d) => (
                <option key={d.externalId} value={d.externalId}>
                  {d.name ?? d.externalId}
                </option>
              ))}
            </select>
          </label>
          <div className="an-form__row">
            <label>
              From
              <input type="date" value={from} onChange={(e) => { setFrom(e.target.value); setPreview(null); }} />
            </label>
            <label>
              To
              <input type="date" value={to} onChange={(e) => { setTo(e.target.value); setPreview(null); }} />
            </label>
          </div>
          <label>
            AQI category
            <select value={maxCategory} onChange={(e) => { setMaxCategory(e.target.value as "good" | "fair"); setPreview(null); }}>
              <option value="good">Good only</option>
              <option value="fair">Good and Fair</option>
            </select>
          </label>
          <label>
            Admin key
            <input
              type="password"
              value={adminKey}
              autoComplete="off"
              placeholder={status?.manualDeleteEnabled === false ? "Disabled: ADMIN_API_KEY is not set on the API" : "Required to delete"}
              disabled={status?.manualDeleteEnabled === false}
              onChange={(e) => setAdminKey(e.target.value)}
            />
          </label>
          <div className="an-form__actions">
            <button type="button" className="an-btn" onClick={runPreview} disabled={busy || !to}>
              Count matching readings
            </button>
            <button
              type="button"
              className="an-btn an-btn--danger"
              onClick={runDelete}
              disabled={busy || !preview || !adminKey || status?.manualDeleteEnabled === false}
            >
              Delete records
            </button>
          </div>
          {preview != null && (
            <div className="an-note">
              {preview.toLocaleString("en-US")} raw reading{preview === 1 ? "" : "s"} match. Readings from the last two hours
              aren't finalized yet and are never deleted.
            </div>
          )}
          {message && <div className="an-note an-note--strong">{message}</div>}
        </div>
      </div>
    </div>
  );
}

// ---- CSV export -----------------------------------------------------------------------

function exportCsv(data: AnalyticsOverview) {
  const keys = data.pollutants.map((p) => p.key);
  const header = [
    "day",
    "aqi",
    "category",
    "representative",
    "samples",
    ...keys.flatMap((k) => {
      const p = data.pollutants.find((x) => x.key === k)!;
      return [`${p.label} avg (${p.unit})`, `${p.label} index`];
    })
  ];
  const rows = data.trend.map((t) => [
    t.day,
    t.aqi ?? "",
    t.aqi != null ? categoryForIndex(t.aqi).label : "",
    t.valid ? "yes" : "no",
    t.samples,
    ...keys.flatMap((k) => [t.averages[k] ?? "", t.indices[k] ?? ""])
  ]);
  const events = data.events.map((e) => [
    e.startedAt,
    e.pollutantLabel,
    e.severityLabel,
    e.status,
    e.consecutiveDays,
    e.peakValue ?? "",
    e.unit ?? "",
    e.title
  ]);
  const quote = (v: unknown) => `"${String(v).replace(/"/g, '""')}"`;
  const csv = [
    `# Analytics report: ${data.device.name ?? data.device.externalId}, ${data.range.from} to ${data.range.to}`,
    header.map(quote).join(","),
    ...rows.map((r) => r.map(quote).join(",")),
    "",
    ["started", "pollutant", "severity", "status", "consecutive days", "peak", "unit", "title"].map(quote).join(","),
    ...events.map((r) => r.map(quote).join(","))
  ].join("\n");

  const blob = new Blob([csv], { type: "text/csv;charset=utf-8" });
  const url = URL.createObjectURL(blob);
  const link = document.createElement("a");
  link.href = url;
  link.download = `analytics-${data.device.externalId}-${data.range.from.slice(0, 10)}_to_${data.range.to.slice(0, 10)}.csv`;
  document.body.appendChild(link);
  link.click();
  link.remove();
  URL.revokeObjectURL(url);
}

// ---- Page -----------------------------------------------------------------------------

export function Analytics() {
  const [devices, setDevices] = useState<Device[]>([]);
  const [deviceId, setDeviceId] = useState<string>("");
  const [range, setRange] = useState<RangeKey>("7d");
  const [customFrom, setCustomFrom] = useState(toDateInputValue(subDays(new Date(), 6)));
  const [customTo, setCustomTo] = useState(toDateInputValue(new Date()));
  const [data, setData] = useState<AnalyticsOverview | null>(null);
  const [loading, setLoading] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const [openEventId, setOpenEventId] = useState<number | null>(null);
  const [refreshTick, setRefreshTick] = useState(0);

  useEffect(() => {
    listDevices()
      .then((list) => {
        setDevices(list);
        setDeviceId((current) => current || list[0]?.externalId || "");
      })
      .catch((e: Error) => setError(e.message));
  }, []);

  const window_ = useMemo(() => resolveRange(range, customFrom, customTo), [range, customFrom, customTo, refreshTick]);

  useEffect(() => {
    if (!deviceId) return;
    let cancelled = false;
    setLoading(true);
    getAnalyticsOverview({ deviceId, from: window_.from.toISOString(), to: window_.to.toISOString() })
      .then((result) => {
        if (cancelled) return;
        setData(result);
        setError(null);
      })
      .catch((e: Error) => !cancelled && setError(e.message))
      .finally(() => !cancelled && setLoading(false));
    return () => {
      cancelled = true;
    };
  }, [deviceId, window_]);

  // Keep the page current while it's open.
  useEffect(() => {
    const timer = setInterval(() => setRefreshTick((t) => t + 1), 60_000);
    return () => clearInterval(timer);
  }, []);

  function openEvent(id: number) {
    setOpenEventId(id);
    requestAnimationFrame(() => document.getElementById(`event-${id}`)?.scrollIntoView({ behavior: "smooth", block: "start" }));
  }

  // Active alerts may be older than the selected range; include them in the list so they can be opened.
  const events = useMemo(() => {
    if (!data) return [];
    const seen = new Set(data.events.map((e) => e.id));
    return [...data.activeAlerts.filter((a) => !seen.has(a.id)), ...data.events];
  }, [data]);

  return (
    <div className="page an-page">
      <header className="an-header">
        <div>
          <h1 className="an-header__title">Analytics Report</h1>
          <p className="an-header__subtitle">
            Air quality analysis and computation using DENR-EMB AQI breakpoints and data-capture rules
          </p>
        </div>
        <div className="an-header__actions">
          <button type="button" className="an-btn" onClick={() => setRefreshTick((t) => t + 1)} disabled={loading}>
            {loading ? "Updating…" : "Refresh"}
          </button>
          <button type="button" className="an-btn" onClick={() => window.print()} disabled={!data}>
            Print / PDF
          </button>
          <button type="button" className="an-btn an-btn--primary" onClick={() => data && exportCsv(data)} disabled={!data}>
            Export CSV
          </button>
        </div>
      </header>

      <div className="an-toolbar">
        <label className="an-toolbar__field">
          Station
          <select value={deviceId} onChange={(e) => setDeviceId(e.target.value)}>
            {devices.map((d) => (
              <option key={d.externalId} value={d.externalId}>
                {d.name ? `${d.name} (${d.externalId})` : d.externalId}
              </option>
            ))}
          </select>
        </label>
        <div className="an-toolbar__field">
          Date range
          <div className="an-segmented">
            {RANGE_OPTIONS.map((o) => (
              <button
                key={o.key}
                type="button"
                className={range === o.key ? "an-segmented__on" : undefined}
                onClick={() => setRange(o.key)}
              >
                {o.label}
              </button>
            ))}
          </div>
        </div>
        {range === "custom" && (
          <div className="an-toolbar__field an-toolbar__dates">
            <input type="date" value={customFrom} max={customTo} onChange={(e) => setCustomFrom(e.target.value)} />
            <span>to</span>
            <input type="date" value={customTo} min={customFrom} onChange={(e) => setCustomTo(e.target.value)} />
          </div>
        )}
        <div className="an-toolbar__range an-muted">
          {format(window_.from, "MMM d, yyyy")} – {format(window_.to, "MMM d, yyyy")}
          {data && ` · ${data.timeZone}`}
        </div>
      </div>

      {error && <div className="an-error">{error}</div>}
      {!data && !error && <div className="an-empty">Loading analytics…</div>}

      {data && (
        <>
          <AlertBanner alerts={data.activeAlerts} onOpen={openEvent} />
          <OverviewCards data={data} />

          {data.insights.length > 0 && (
            <div className="an-insights">
              {data.insights.map((i) => (
                <div key={i.title} className={`an-insight an-insight--${i.level}`}>
                  <strong>{i.title}</strong>
                  <span>{i.detail}</span>
                </div>
              ))}
            </div>
          )}

          <Section
            title="Pollutant measurements, averages and AQI"
            subtitle="Rolling averages ending now; annual is the current calendar year"
          >
            <PollutantTable rows={data.pollutants} />
          </Section>

          <Section title="How the AQI was calculated">
            <Computation data={data} />
          </Section>

          <Section title="Averaging periods and data capture (DENR-EMB 2021)">
            <AveragingRules />
          </Section>

          <div className="an-grid an-grid--trend">
            <Section title="AQI trend (daily average)">
              <TrendChart data={data} />
            </Section>
            <Section title="Top 3 pollutants" subtitle="Ranked by the highest daily index in the selected range">
              <TopPollutants data={data} />
            </Section>
          </div>

          <Section
            id="events"
            title="Elevated readings and history"
            subtitle="Sustained episodes (daily average at Unhealthy for Sensitive Groups or worse) and short hourly spikes. These records are kept permanently."
          >
            <EventsSection events={events} openId={openEventId} setOpenId={setOpenEventId} />
          </Section>

          <Section title="Summary, health effects and recommendations">
            <SummarySection data={data} />
          </Section>
        </>
      )}

      <Section title="Data management" subtitle="Saved data and storage clean-up">
        <DataManagement devices={devices} />
      </Section>
    </div>
  );
}
