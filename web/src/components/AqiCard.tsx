import type { AqiResult } from "../api";

const pollutantLabels: Record<string, string> = {
  pm25: "PM\u2082.\u2085",
  pm10: "PM\u2081\u2080",
  co: "CO",
  no2: "NO\u2082",
  so2: "SO\u2082",
};

const categoryColors: Record<string, string> = {
  Good: "#00e400",
  Moderate: "#ffff00",
  "Unhealthy for Sensitive Groups": "#ff7e00",
  Unhealthy: "#ff0000",
  "Very Unhealthy": "#8f3f97",
  Hazardous: "#7e0023",
};

const healthMessages: Record<string, string> = {
  Good: "Air quality is satisfactory. Enjoy outdoor activities.",
  Moderate: "Sensitive individuals may consider limiting prolonged outdoor exertion.",
  "Unhealthy for Sensitive Groups": "People with respiratory conditions should reduce outdoor activity.",
  Unhealthy: "Everyone may begin to experience health effects. Limit outdoor exertion.",
  "Very Unhealthy": "Health alert: everyone may experience serious health effects.",
  Hazardous: "Health warning of emergency conditions. Avoid all outdoor activity.",
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
  const badgeColor = categoryColors[category] ?? "#888";
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
        AQI scale: 0–50 Good · 51–100 Moderate · 101–150
        Unhealthy for Sensitive Groups · 151–200 Unhealthy ·
        201–300 Very Unhealthy · 301+ Hazardous
      </div>

      {healthMsg && (
        <div className="aqi-hero__advisory">
          <span className="aqi-hero__advisory-icon" style={{ color: badgeColor }}>✓</span>
          {healthMsg}
        </div>
      )}

      {aqi && (
        <div className="aqi-breakdown">
          {[
            { key: "pm25", label: "PM\u2082.\u2085", value: aqi.pm25SubIndex },
            { key: "pm10", label: "PM\u2081\u2080", value: aqi.pm10SubIndex },
            { key: "co", label: "CO", value: aqi.coSubIndex },
            { key: "no2", label: "NO\u2082", value: aqi.no2SubIndex },
            { key: "so2", label: "SO\u2082", value: aqi.so2SubIndex },
          ]
            .filter((s) => s.value > 0)
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
