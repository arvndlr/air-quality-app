import type { AqiResult } from "../api";
import { AQI_SCALE_TEXT, categoryColor } from "../aqiScale";

const pollutantLabels: Record<string, string> = {
  pm25: "PM\u2082.\u2085",
  pm10: "PM\u2081\u2080",
  co: "CO",
  no2: "NO\u2082",
  so2: "SO\u2082",
};

// DENR-EMB cautionary statements (DAO 2000-81) for each category.
const healthMessages: Record<string, string> = {
  Good: "Air quality is satisfactory. Enjoy outdoor activities.",
  Fair: "Air quality is acceptable. Unusually sensitive people may limit prolonged outdoor exertion.",
  "Unhealthy for Sensitive Groups": "People with respiratory disease, such as asthma, should limit outdoor exertion.",
  "Very Unhealthy":
    "Avoid heavy traffic areas. People with heart or respiratory disease should stay indoors and rest. Postpone unnecessary trips.",
  "Acutely Unhealthy":
    "Limit outdoor exertion. People with heart or respiratory disease should stay indoors. Vehicle use and industrial activity may be restricted.",
  Emergency: "Everyone should remain indoors with windows and doors closed. Vehicle use should be limited to emergencies.",
};

export function AqiCard(props: {
  aqi: AqiResult | null;
  prevAqi?: number | null;
  loading?: boolean;
  location?: string;
}) {
  const { aqi, loading, prevAqi, location } = props;

  const valueText = aqi ? String(aqi.aqi) : "\u2014";
  const category = aqi?.category ?? "No data";
  const color = aqi?.color ?? "transparent";
  const dominant = aqi ? pollutantLabels[aqi.dominantPollutant] ?? aqi.dominantPollutant : null;
  const badgeColor = categoryColor(category);
  const healthMsg = healthMessages[category] ?? "";

  return (
    <section className="aqi-hero">
      <div className="aqi-hero__top">
        <div>
          <div className="aqi-hero__label">Current Air Quality Index</div>
          {location && <div className="aqi-hero__location">Location: {location}</div>}
        </div>
        <span className="aqi-hero__badge" style={{ background: badgeColor, color: "#000" }}>
          {category}
        </span>
      </div>

      <div className="aqi-hero__body">
        <div className="aqi-hero__value" style={{ color: color !== "transparent" ? color : undefined }}>
          {loading ? "…" : valueText}
        </div>
        <div className="aqi-hero__meta">
          {prevAqi != null && (
            <div className="aqi-hero__prev">
              Previous Hour AQI<br />
              <strong>{prevAqi}</strong>
            </div>
          )}
          {dominant && (
            <div className="aqi-hero__dominant">
              Dominant pollutant: <strong>{dominant}</strong>
            </div>
          )}
        </div>
      </div>

      <div className="aqi-hero__scale">
        DENR AQI scale: {AQI_SCALE_TEXT}
      </div>

      {healthMsg && (
        <div className="aqi-hero__advisory">
          <span className="aqi-hero__advisory-icon" style={{ color: badgeColor }}>✓</span>
          {healthMsg}
        </div>
      )}

      {aqi && (
        <div className="aqi-breakdown">
          <div className="aqi-breakdown__title">AQI sub-indexes</div>
          {[
            { key: "pm25", label: "PM\u2082.\u2085", value: aqi.pm25SubIndex },
            { key: "pm10", label: "PM\u2081\u2080", value: aqi.pm10SubIndex },
            { key: "so2", label: "SO\u2082", value: aqi.so2SubIndex },
            { key: "co", label: "CO (estimated)", value: aqi.coSubIndex },
          ]
            .filter((s) => s.value != null && s.value > 0)
            .map((s) => (
              <div key={s.key} className="aqi-breakdown__row">
                <span className="aqi-breakdown__label">{s.label}</span>
                <span className="aqi-breakdown__value">{s.value}</span>
              </div>
            ))}
        </div>
      )}
    </section>
  );
}
