import { useCallback, useEffect, useLayoutEffect, useRef, useState } from "react";

const categoryColors: Record<string, string> = {
  Good: "#00e400",
  Moderate: "#ffff00",
  "Unhealthy for Sensitive Groups": "#ff7e00",
  Unhealthy: "#ff0000",
  "Very Unhealthy": "#8f3f97",
  Hazardous: "#7e0023",
};

function getCategory(subIndex: number): string {
  if (subIndex <= 50) return "Good";
  if (subIndex <= 100) return "Moderate";
  if (subIndex <= 150) return "Unhealthy for Sensitive Groups";
  if (subIndex <= 200) return "Unhealthy";
  if (subIndex <= 300) return "Very Unhealthy";
  return "Hazardous";
}

type PollutantInfo = {
  thresholds: string;
  healthNotes: string;
  recommendation: string;
  /** Who feels the effects first when this pollutant climbs. */
  sensitiveGroups: string;
  /** Illnesses and health effects linked to elevated exposure, surfaced on hover. */
  illnesses: string[];
  /** What tends to happen once this pollutant reaches an unhealthy band. */
  whenElevated: string;
};

/** Bands at or beyond "Unhealthy for Sensitive Groups", where the health warning is raised. */
const concerningCategories = new Set([
  "Unhealthy for Sensitive Groups",
  "Unhealthy",
  "Very Unhealthy",
  "Hazardous",
]);

type IndicatorKind = "co2" | "nh3" | "voc";

type PollutantIndicator = {
  label: string;
  color: string;
  summary: string;
  gaugeValue: number;
  gaugeMax: number;
};

type SupplementalBand = {
  lower: number;
  upper: number | null;
  label: string;
  indexLow: number;
  indexHigh: number;
};

const pollutantDetails: Record<string, PollutantInfo> = {
  "PM<sub>2.5</sub>": {
    thresholds: "Good: 0-12 \u00b7 Moderate: 12.1-35.4 \u00b7 USG: 35.5-55.4 \u00b7 Unhealthy: 55.5-150.4 \u00b7 Very Unhealthy: 150.5-250.4 \u00b7 Hazardous: 250.5+ (\u00b5g/m\u00b3)",
    healthNotes: "Fine particles penetrate deep into the lungs and bloodstream, causing respiratory and cardiovascular problems. Long-term exposure increases risk of heart disease and lung cancer.",
    recommendation: "Use air purifiers indoors when levels are high. Wear N95 masks outdoors during unhealthy conditions. Avoid exercising near busy roads.",
    sensitiveGroups:
      "Children, older adults, pregnant people, and anyone with asthma, COPD, or heart disease.",
    illnesses: [
      "Asthma attacks and wheezing",
      "Bronchitis and aggravated COPD",
      "Reduced lung function and lung growth in children",
      "Heart attack, irregular heartbeat, and stroke",
      "Lung cancer after long-term exposure",
      "Low birth weight and pre-term birth",
    ],
    whenElevated:
      "Fine particles bypass the airway defences and reach the deep lung and bloodstream, so symptoms can appear within hours of a spike.",
  },
  "PM<sub>10</sub>": {
    thresholds: "Good: 0-54 \u00b7 Moderate: 55-154 \u00b7 USG: 155-254 \u00b7 Unhealthy: 255-354 \u00b7 Very Unhealthy: 355-424 \u00b7 Hazardous: 425+ (\u00b5g/m\u00b3)",
    healthNotes: "Coarse particles irritate the eyes, nose, and throat. People with asthma or chronic lung disease are especially sensitive.",
    recommendation: "Keep windows closed on dusty days. Use wet mopping instead of sweeping. Limit outdoor activities when levels are elevated.",
    sensitiveGroups:
      "People with asthma, chronic bronchitis, or sinus and allergy conditions.",
    illnesses: [
      "Coughing, sneezing, and throat irritation",
      "Eye and nasal irritation, sinus congestion",
      "Asthma attacks",
      "Acute bronchitis and worsened chronic bronchitis",
      "Aggravated COPD and shortness of breath",
    ],
    whenElevated:
      "Coarse dust lodges in the nose, throat, and upper airways, which is why irritation and coughing come first.",
  },
  "SO<sub>2</sub>": {
    thresholds: "Good: 0-35 \u00b7 Moderate: 36-75 \u00b7 USG: 76-185 \u00b7 Unhealthy: 186-304 \u00b7 Very Unhealthy: 305-604 \u00b7 Hazardous: 605+ (ppb)",
    healthNotes: "Short-term exposure can harm the respiratory system, particularly in people with asthma. Can cause difficulty breathing and chest tightness.",
    recommendation: "People with asthma should carry inhalers. Avoid outdoor exercise near industrial areas when levels are elevated.",
    sensitiveGroups:
      "People with asthma are affected at far lower levels than the general population.",
    illnesses: [
      "Bronchoconstriction within minutes for people with asthma",
      "Wheezing, chest tightness, shortness of breath",
      "Asthma attacks needing medication",
      "Airway inflammation and worsened bronchitis",
      "More frequent respiratory infections with repeated exposure",
      "Eye, nose, and throat irritation",
    ],
    whenElevated:
      "Short exposures of only 5-10 minutes can trigger breathing difficulty in people with asthma, so act on spikes immediately.",
  },
  CO: {
    thresholds: "Good: 0-4.4 \u00b7 Moderate: 4.5-9.4 \u00b7 USG: 9.5-12.4 \u00b7 Unhealthy: 12.5-15.4 \u00b7 Very Unhealthy: 15.5-30.4 \u00b7 Hazardous: 30.5+ (ppm)",
    healthNotes: "Reduces the blood's ability to carry oxygen. At high levels causes dizziness, confusion, and can be fatal. People with heart disease are most at risk.",
    recommendation: "Ensure proper ventilation when using gas appliances. Install CO detectors. Avoid idling vehicles in enclosed spaces.",
    sensitiveGroups:
      "People with heart disease, anaemia, or lung disease, pregnant people, infants, and older adults.",
    illnesses: [
      "Headache, dizziness, and weakness",
      "Nausea, vomiting, and confusion",
      "Chest pain (angina) in people with heart disease",
      "Loss of consciousness",
      "Carbon monoxide poisoning, which can be fatal",
      "Harm to a developing foetus",
    ],
    whenElevated:
      "Carbon monoxide binds to haemoglobin in place of oxygen, so organs are starved of oxygen well before there is any smell or visible sign.",
  },
  "NO<sub>2</sub>": {
    thresholds: "Good: 0-53 \u00b7 Moderate: 54-100 \u00b7 USG: 101-360 \u00b7 Unhealthy: 361-649 \u00b7 Very Unhealthy: 650-1249 \u00b7 Hazardous: 1250+ (ppb)",
    healthNotes: "A reddish-brown gas from vehicle exhaust and power plants. It irritates airways and can aggravate asthma and other respiratory conditions.",
    recommendation: "Avoid prolonged exposure near heavy traffic. Keep windows closed during rush hours in urban areas. Use air purifiers with activated carbon filters.",
    sensitiveGroups:
      "Children, older adults, and people with asthma or other chronic lung conditions.",
    illnesses: [
      "Airway inflammation and coughing",
      "Asthma attacks, and asthma development in children",
      "Bronchitis in children with asthma",
      "Higher risk of respiratory infections such as influenza and pneumonia",
      "Reduced lung growth in children with long-term exposure",
    ],
    whenElevated:
      "Sustained elevation near traffic or combustion sources drives repeat emergency visits for asthma and respiratory infection.",
  },
  "NH<sub>3</sub>": {
    thresholds: "Good: <5 ppm \u00b7 Moderate: 5-24.9 ppm \u00b7 USG: 25-49.9 ppm \u00b7 Unhealthy: 50-99.9 ppm \u00b7 Very Unhealthy: 100-199.9 ppm \u00b7 Hazardous: 200+ ppm (guidance-based AQI-style bands, not EPA AQI)",
    healthNotes: "Ammonia is a pungent gas. Rising levels can signal nearby agricultural activity, waste processing, or chemical leaks. Higher concentrations irritate eyes, nose, throat, and lungs.",
    recommendation: "Investigate sources if levels rise unexpectedly. Ensure adequate ventilation in enclosed spaces. Levels above 25 ppm warrant caution for prolonged exposure.",
    sensitiveGroups:
      "Anyone working near livestock, fertiliser, waste processing, or refrigeration equipment.",
    illnesses: [
      "Burning eyes, nose, and throat",
      "Persistent coughing and hoarseness",
      "Chemical bronchitis and airway swelling",
      "Chest tightness and breathing difficulty",
      "Pulmonary oedema (fluid in the lungs) at high concentrations",
      "Chemical burns to skin and eyes on direct contact",
    ],
    whenElevated:
      "Ammonia is highly water-soluble, so it attacks the moist tissue of the eyes and upper airway first; a sharp rise usually means a nearby leak or source.",
  },
  "CO<sub>2</sub>": {
    thresholds: "Good: <600 ppm \u00b7 Moderate: 600-999 ppm \u00b7 USG: 1000-1499 ppm \u00b7 Unhealthy: 1500-1999 ppm \u00b7 Very Unhealthy: 2000-4999 ppm \u00b7 Hazardous: 5000+ ppm (guidance-based AQI-style bands, not EPA AQI)",
    healthNotes: "Not directly toxic at typical levels but an excellent proxy for ventilation quality. Levels above 1000 ppm can cause drowsiness and reduced cognitive function.",
    recommendation: "Open windows or increase mechanical ventilation when levels exceed 1000 ppm. Consider CO2 monitors in classrooms and offices.",
    sensitiveGroups:
      "Anyone in a crowded or poorly ventilated room, especially students and office workers.",
    illnesses: [
      "Headaches and drowsiness",
      "Poor concentration and slower decision-making",
      "Dizziness, restlessness, and tingling",
      "Raised heart rate and breathing rate",
      "Higher risk of catching airborne infections, because stale air is shared air",
    ],
    whenElevated:
      "Carbon dioxide is not toxic at these levels, but a high reading means the room is recycling exhaled air along with whatever else is in it.",
  },
  VOC: {
    thresholds: "Good: 0-50 \u00b7 Moderate: 51-100 \u00b7 USG: 101-150 \u00b7 Unhealthy: 151-200 \u00b7 Very Unhealthy: 201-300 \u00b7 Hazardous: 301+ (guidance-based BME680 VOC index, not an EPA AQI pollutant)",
    healthNotes: "This index is derived from BME680 gas resistance. Higher values suggest more volatile organic compounds from sources such as solvents, fuel vapours, smoke, cooking emissions, and poorly ventilated indoor spaces.",
    recommendation: "Investigate rising values alongside CO2 and local activities. Improve ventilation, isolate solvent or combustion sources, and treat sudden spikes as a signal to inspect the environment rather than as a direct concentration reading.",
    sensitiveGroups:
      "People with asthma or chemical sensitivity, children, and pregnant people.",
    illnesses: [
      "Headaches, dizziness, and fatigue",
      "Eye, nose, and throat irritation",
      "Nausea and loss of coordination",
      "Triggered asthma and worsened allergy symptoms",
      "Liver, kidney, and nervous system damage from chronic exposure to some compounds",
      "Cancer risk from specific VOCs such as benzene and formaldehyde",
    ],
    whenElevated:
      "The index does not identify which compound is present, so a sustained rise is a cue to find and remove the source rather than to wait it out.",
  },
};

function buildSupplementalIndicator(
  value: number | null,
  interpolationMax: number,
  bands: SupplementalBand[],
): PollutantIndicator | null {
  if (value == null) return null;

  for (const band of bands) {
    if (band.upper != null && value >= band.upper) continue;

    const bandUpper = band.upper ?? (interpolationMax > band.lower ? interpolationMax : band.lower);
    const normalized =
      bandUpper > band.lower
        ? (Math.min(value, bandUpper) - band.lower) / (bandUpper - band.lower)
        : 1;
    const subIndex = Math.round(
      band.indexLow + Math.max(0, Math.min(1, normalized)) * (band.indexHigh - band.indexLow),
    );

    return {
      label: band.label,
      color: categoryColors[band.label] ?? "#888",
      summary: `Sub-index = ${subIndex} (${band.label})`,
      gaugeValue: subIndex,
      gaugeMax: 500,
    };
  }

  return null;
}

function getCo2Indicator(value: number | null): PollutantIndicator | null {
  return buildSupplementalIndicator(value, 10000, [
    { lower: 0, upper: 600, label: "Good", indexLow: 0, indexHigh: 50 },
    { lower: 600, upper: 1000, label: "Moderate", indexLow: 51, indexHigh: 100 },
    { lower: 1000, upper: 1500, label: "Unhealthy for Sensitive Groups", indexLow: 101, indexHigh: 150 },
    { lower: 1500, upper: 2000, label: "Unhealthy", indexLow: 151, indexHigh: 200 },
    { lower: 2000, upper: 5000, label: "Very Unhealthy", indexLow: 201, indexHigh: 300 },
    { lower: 5000, upper: null, label: "Hazardous", indexLow: 301, indexHigh: 500 },
  ]);
}

function getNh3Indicator(value: number | null): PollutantIndicator | null {
  return buildSupplementalIndicator(value, 300, [
    { lower: 0, upper: 5, label: "Good", indexLow: 0, indexHigh: 50 },
    { lower: 5, upper: 25, label: "Moderate", indexLow: 51, indexHigh: 100 },
    { lower: 25, upper: 50, label: "Unhealthy for Sensitive Groups", indexLow: 101, indexHigh: 150 },
    { lower: 50, upper: 100, label: "Unhealthy", indexLow: 151, indexHigh: 200 },
    { lower: 100, upper: 200, label: "Very Unhealthy", indexLow: 201, indexHigh: 300 },
    { lower: 200, upper: null, label: "Hazardous", indexLow: 301, indexHigh: 500 },
  ]);
}

function getVocIndicator(value: number | null): PollutantIndicator | null {
  if (value == null) return null;

  const rounded = Math.max(0, Math.min(500, Math.round(value)));
  const label = getCategory(rounded);
  return {
    label,
    color: categoryColors[label] ?? "#888",
    summary: `Index = ${rounded} (${label})`,
    gaugeValue: rounded,
    gaugeMax: 500,
  };
}

function getIndicator(subIndex: number | null, value: number | null, indicatorKind?: IndicatorKind): PollutantIndicator | null {
  if (indicatorKind === "co2") return getCo2Indicator(value);
  if (indicatorKind === "nh3") return getNh3Indicator(value);
  if (indicatorKind === "voc") return getVocIndicator(value);
  if (subIndex == null) return null;

  const label = getCategory(subIndex);
  return {
    label,
    color: categoryColors[label] ?? "#888",
    summary: `Sub-index = ${subIndex} (${label})`,
    gaugeValue: subIndex,
    gaugeMax: 500,
  };
}

function GaugeMeter(props: { value: number; max: number; color: string }) {
  const { value, max, color } = props;
  const pct = Math.min(Math.max(value / max, 0), 1);
  const angle = -90 + pct * 180;
  const trackColor = "rgba(15, 23, 42, 0.12)";

  return (
    <svg viewBox="0 0 120 70" className="gauge">
      <path d="M 10 65 A 50 50 0 0 1 110 65" fill="none" stroke={trackColor} strokeWidth="8" strokeLinecap="round" />
      <path d="M 10 65 A 50 50 0 0 1 110 65" fill="none" stroke={color} strokeWidth="8" strokeLinecap="round" strokeDasharray={`${pct * 157} 157`} />
      <line x1="60" y1="65" x2={60 + 38 * Math.cos((angle * Math.PI) / 180)} y2={65 + 38 * Math.sin((angle * Math.PI) / 180)} stroke={color} strokeWidth="2.5" strokeLinecap="round" />
      <circle cx="60" cy="65" r="4" fill={color} />
    </svg>
  );
}

/** The hovered card's position, which the tooltip measures itself against. */
type AnchorRect = { top: number; bottom: number; left: number; width: number };

const TOOLTIP_WIDTH = 300;
const TOOLTIP_MARGIN = 12;

function toAnchorRect(rect: DOMRect): AnchorRect {
  return { top: rect.top, bottom: rect.bottom, left: rect.left, width: rect.width };
}

function HealthTooltip(props: {
  title: string;
  categoryLabel: string | null;
  color: string;
  concerning: boolean;
  details: PollutantInfo;
  anchor: AnchorRect;
}) {
  const { title, categoryLabel, color, concerning, details, anchor } = props;
  const tooltipRef = useRef<HTMLDivElement | null>(null);
  const [position, setPosition] = useState<{ top: number; left: number } | null>(null);

  // Measure the rendered tooltip before paint: its height depends on how many
  // illnesses the pollutant lists, so an estimate is not good enough to keep it on screen.
  useLayoutEffect(() => {
    const element = tooltipRef.current;
    if (!element) return;

    const { offsetHeight: height, offsetWidth: width } = element;
    const left = Math.min(
      Math.max(TOOLTIP_MARGIN, anchor.left + anchor.width / 2 - width / 2),
      Math.max(TOOLTIP_MARGIN, window.innerWidth - width - TOOLTIP_MARGIN),
    );

    let top = anchor.top - height - 10;

    if (top < TOOLTIP_MARGIN) {
      top = anchor.bottom + 10;
    }

    if (top + height > window.innerHeight - TOOLTIP_MARGIN) {
      top = Math.max(TOOLTIP_MARGIN, window.innerHeight - height - TOOLTIP_MARGIN);
    }

    setPosition({ top, left });
  }, [anchor]);

  return (
    <div
      ref={tooltipRef}
      className={`health-tooltip${concerning ? " health-tooltip--alert" : ""}`}
      role="tooltip"
      style={{
        top: position?.top ?? 0,
        left: position?.left ?? 0,
        width: TOOLTIP_WIDTH,
        visibility: position ? "visible" : "hidden",
      }}
    >
      <div className="health-tooltip__header">
        <span className="health-tooltip__title" dangerouslySetInnerHTML={{ __html: title }} />
        {categoryLabel && (
          <span className="health-tooltip__badge" style={{ background: color, color: "#000" }}>
            {categoryLabel}
          </span>
        )}
      </div>

      <div className="health-tooltip__lead">
        {concerning ? details.whenElevated : "Health effects linked to raised levels of this pollutant:"}
      </div>

      <div className="health-tooltip__section-label">Possible illnesses and health effects</div>
      <ul className="health-tooltip__list">
        {details.illnesses.map((illness) => (
          <li key={illness}>{illness}</li>
        ))}
      </ul>

      <div className="health-tooltip__section-label">Most at risk</div>
      <div className="health-tooltip__text">{details.sensitiveGroups}</div>

      <div className="health-tooltip__footer">Click the card for thresholds and recommendations.</div>
    </div>
  );
}

function PollutantModal(props: {
  title: string;
  unit: string;
  value: string;
  indicatorLabel: string | null;
  indicatorSummary: string | null;
  color: string;
  gaugeValue: number;
  gaugeMax: number;
  details: PollutantInfo;
  onClose: () => void;
}) {
  const { title, unit, value, indicatorLabel, indicatorSummary, color, gaugeValue, gaugeMax, details, onClose } = props;

  useEffect(() => {
    const handleKey = (e: KeyboardEvent) => {
      if (e.key === "Escape") onClose();
    };
    document.addEventListener("keydown", handleKey);
    return () => document.removeEventListener("keydown", handleKey);
  }, [onClose]);

  return (
    <div className="modal-overlay" onClick={onClose}>
      <div className="modal" onClick={(e) => e.stopPropagation()}>
        <button className="modal__close" onClick={onClose} aria-label="Close">
          &times;
        </button>

        <div className="modal__top">
          <div>
            <span className="modal__title" dangerouslySetInnerHTML={{ __html: title }} />
            <span className="modal__unit" dangerouslySetInnerHTML={{ __html: unit }} />
          </div>
          {indicatorLabel && (
            <span className="modal__badge" style={{ background: color, color: "#000" }}>
              {indicatorLabel}
            </span>
          )}
        </div>

        <div className="modal__reading">
          <GaugeMeter value={gaugeValue} max={gaugeMax} color={color} />
          <div className="modal__value">{value}</div>
          {indicatorSummary && <div className="modal__sub" style={{ color }}>{indicatorSummary}</div>}
        </div>

        <div className="modal__sections">
          <div className="modal__section">
            <div className="modal__section-label">Thresholds</div>
            <div className="modal__section-text">{details.thresholds}</div>
          </div>
          <div className="modal__section">
            <div className="modal__section-label">Health Notes</div>
            <div className="modal__section-text">{details.healthNotes}</div>
          </div>
          <div className="modal__section">
            <div className="modal__section-label">Possible Illnesses and Health Effects</div>
            <ul className="modal__section-list">
              {details.illnesses.map((illness) => (
                <li key={illness}>{illness}</li>
              ))}
            </ul>
            <div className="modal__section-text">Most at risk: {details.sensitiveGroups}</div>
          </div>
          <div className="modal__section">
            <div className="modal__section-label">Recommendations</div>
            <div className="modal__section-text">{details.recommendation}</div>
          </div>
        </div>
      </div>
    </div>
  );
}

export function PollutantCard(props: {
  title: string;
  unit: string;
  value: number | null;
  subIndex: number | null;
  indicatorKind?: IndicatorKind;
  loading?: boolean;
  format?: (v: number) => string;
  emptyText?: string;
}) {
  const { title, unit, value, subIndex, indicatorKind, loading } = props;
  const [open, setOpen] = useState(false);
  const [anchor, setAnchor] = useState<AnchorRect | null>(null);
  const cardRef = useRef<HTMLDivElement | null>(null);
  const displayValue = value == null ? props.emptyText ?? "\u2014" : props.format ? props.format(value) : String(value);
  const indicator = getIndicator(subIndex, value, indicatorKind);
  const color = indicator?.color ?? "#888";
  const details = pollutantDetails[title];
  const concerning = indicator != null && concerningCategories.has(indicator.label);

  const showTooltip = useCallback(() => {
    const card = cardRef.current;
    if (!card) return;
    setAnchor(toAnchorRect(card.getBoundingClientRect()));
  }, []);

  const hideTooltip = useCallback(() => setAnchor(null), []);

  const openModal = useCallback(() => {
    setAnchor(null);
    setOpen(true);
  }, []);

  // The tooltip is placed against the viewport, so it has to be dismissed if the page moves under it.
  useEffect(() => {
    if (!anchor) return;

    window.addEventListener("scroll", hideTooltip, true);
    window.addEventListener("resize", hideTooltip);

    return () => {
      window.removeEventListener("scroll", hideTooltip, true);
      window.removeEventListener("resize", hideTooltip);
    };
  }, [anchor, hideTooltip]);

  return (
    <>
      <div
        ref={cardRef}
        className={`pollutant-stat-card${concerning ? " pollutant-stat-card--alert" : ""}`}
        onClick={() => openModal()}
        role="button"
        tabIndex={0}
        onMouseEnter={showTooltip}
        onMouseLeave={hideTooltip}
        onFocus={showTooltip}
        onBlur={hideTooltip}
        onKeyDown={(e) => {
          if (e.key === "Enter" || e.key === " ") {
            e.preventDefault();
            openModal();
          }

          if (e.key === "Escape") {
            hideTooltip();
          }
        }}
      >
        <div className="pollutant-stat-card__header">
          <span className="pollutant-stat-card__title" dangerouslySetInnerHTML={{ __html: title }} />
          <span className="pollutant-stat-card__unit" dangerouslySetInnerHTML={{ __html: unit }} />
        </div>
        <GaugeMeter value={indicator?.gaugeValue ?? 0} max={indicator?.gaugeMax ?? 500} color={color} />
        <div className="pollutant-stat-card__value">{loading ? "\u2026" : displayValue}</div>
        {indicator && (
          <div className="pollutant-stat-card__sub" style={{ color }}>
            {indicator.summary}
          </div>
        )}
        {details && (
          <div className={`pollutant-stat-card__risk${concerning ? " pollutant-stat-card__risk--alert" : ""}`}>
            {concerning ? "Hover: possible illnesses" : "Hover for health effects"}
          </div>
        )}
      </div>

      {details && !open && anchor && (
        <HealthTooltip
          title={title}
          categoryLabel={indicator?.label ?? null}
          color={color}
          concerning={concerning}
          details={details}
          anchor={anchor}
        />
      )}

      {open && details && (
        <PollutantModal
          title={title}
          unit={unit}
          value={displayValue}
          indicatorLabel={indicator?.label ?? null}
          indicatorSummary={indicator?.summary ?? null}
          color={color}
          gaugeValue={indicator?.gaugeValue ?? 0}
          gaugeMax={indicator?.gaugeMax ?? 500}
          details={details}
          onClose={() => setOpen(false)}
        />
      )}
    </>
  );
}
