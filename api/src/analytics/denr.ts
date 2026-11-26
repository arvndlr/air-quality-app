// Philippine Air Quality Index (DENR-EMB), used by the analytics module only.
// The live dashboard (ingest/latest) keeps the US EPA scale in ../aqi.ts.
// Reference: DENR-EMB "Procedural Manual on Data Handling Conventions for Criteria Air
// Pollutants" (May 2021), Chapter 5, Table 5.2-2.
//
// Ip = (IHi - ILo) / (BPHi - BPLo) * (Cp - BPLo) + ILo
//
// The manual defines breakpoints for PM2.5, PM10 and SO2 (24-hour averages) and CO
// (8-hour average). It has none for NO2, CO2, VOC or NH3.

export type AqiCategoryKey =
  | "good"
  | "fair"
  | "usg"
  | "very-unhealthy"
  | "acutely-unhealthy"
  | "emergency";

export type AqiCategory =
  | "Good"
  | "Fair"
  | "Unhealthy for Sensitive Groups"
  | "Very Unhealthy"
  | "Acutely Unhealthy"
  | "Emergency";

export type CategoryInfo = {
  key: AqiCategoryKey;
  label: AqiCategory;
  min: number;
  max: number;
  color: string;
  /** DAO 2000-81 cautionary statement for the category. */
  cautionary: string;
};

export const CATEGORIES: CategoryInfo[] = [
  { key: "good", label: "Good", min: 0, max: 50, color: "#00e400", cautionary: "None." },
  { key: "fair", label: "Fair", min: 51, max: 100, color: "#ffff00", cautionary: "None." },
  {
    key: "usg",
    label: "Unhealthy for Sensitive Groups",
    min: 101,
    max: 150,
    color: "#ff7e00",
    cautionary: "People with respiratory disease, such as asthma, should limit outdoor exertion."
  },
  {
    key: "very-unhealthy",
    label: "Very Unhealthy",
    min: 151,
    max: 200,
    color: "#ff0000",
    cautionary:
      "Pedestrians should avoid heavy traffic areas. People with heart or respiratory disease such as asthma should stay indoors and rest as much as possible. Unnecessary trips should be postponed. People should voluntarily restrict the use of vehicles."
  },
  {
    key: "acutely-unhealthy",
    label: "Acutely Unhealthy",
    min: 201,
    max: 300,
    color: "#8f3f97",
    cautionary:
      "People should limit outdoor exertion. People with heart or respiratory disease such as asthma should stay indoors and rest as much as possible. Unnecessary trips should be postponed. Motor vehicle use may be restricted. Industrial activities may be curtailed."
  },
  {
    key: "emergency",
    label: "Emergency",
    min: 301,
    max: 500,
    color: "#7e0023",
    cautionary:
      "Everyone should remain indoors (keeping windows and doors closed unless heat stress is possible). Motor vehicle use should be prohibited except for emergency situations. Industrial activities, except those vital for public safety and health, should be curtailed."
  }
];

export function categoryFor(index: number): CategoryInfo {
  for (const category of CATEGORIES) {
    if (index <= category.max) return category;
  }
  return CATEGORIES[CATEGORIES.length - 1]!;
}

export type Breakpoint = { cLow: number; cHigh: number; iLow: number; iHigh: number };

export type AqiPollutant = "pm25" | "pm10" | "so2" | "co";

type BreakpointTable = {
  /** Unit the breakpoints are written in. */
  unit: string;
  /** Averaging period the breakpoints apply to. */
  averaging: "24-hour" | "8-hour";
  /** Decimal places the concentration is truncated to before lookup. */
  decimals: number;
  breakpoints: Breakpoint[];
};

export const BREAKPOINTS: Record<AqiPollutant, BreakpointTable> = {
  pm25: {
    unit: "µg/Ncm",
    averaging: "24-hour",
    decimals: 1,
    breakpoints: [
      { cLow: 0, cHigh: 25.0, iLow: 0, iHigh: 50 },
      { cLow: 25.1, cHigh: 35.0, iLow: 51, iHigh: 100 },
      { cLow: 35.1, cHigh: 45.0, iLow: 101, iHigh: 150 },
      { cLow: 45.1, cHigh: 55.0, iLow: 151, iHigh: 200 },
      { cLow: 55.1, cHigh: 90.0, iLow: 201, iHigh: 300 },
      // The manual lists Emergency as "91 and above" with no upper limit; 250 is assumed
      // here so the index reaches 500 at the same point as the US EPA scale.
      { cLow: 91.0, cHigh: 250.0, iLow: 301, iHigh: 500 }
    ]
  },
  pm10: {
    unit: "µg/Ncm",
    averaging: "24-hour",
    decimals: 0,
    breakpoints: [
      { cLow: 0, cHigh: 54, iLow: 0, iHigh: 50 },
      { cLow: 55, cHigh: 154, iLow: 51, iHigh: 100 },
      { cLow: 155, cHigh: 254, iLow: 101, iHigh: 150 },
      { cLow: 255, cHigh: 354, iLow: 151, iHigh: 200 },
      { cLow: 355, cHigh: 424, iLow: 201, iHigh: 300 },
      { cLow: 425, cHigh: 504, iLow: 301, iHigh: 500 }
    ]
  },
  so2: {
    unit: "ppm",
    averaging: "24-hour",
    decimals: 3,
    breakpoints: [
      { cLow: 0, cHigh: 0.034, iLow: 0, iHigh: 50 },
      { cLow: 0.035, cHigh: 0.144, iLow: 51, iHigh: 100 },
      { cLow: 0.145, cHigh: 0.224, iLow: 101, iHigh: 150 },
      { cLow: 0.225, cHigh: 0.304, iLow: 151, iHigh: 200 },
      { cLow: 0.305, cHigh: 0.604, iLow: 201, iHigh: 300 },
      { cLow: 0.605, cHigh: 0.804, iLow: 301, iHigh: 500 }
    ]
  },
  co: {
    unit: "ppm",
    averaging: "8-hour",
    decimals: 1,
    breakpoints: [
      { cLow: 0, cHigh: 4.4, iLow: 0, iHigh: 50 },
      { cLow: 4.5, cHigh: 9.4, iLow: 51, iHigh: 100 },
      { cLow: 9.5, cHigh: 12.4, iLow: 101, iHigh: 150 },
      { cLow: 12.5, cHigh: 15.4, iLow: 151, iHigh: 200 },
      { cLow: 15.5, cHigh: 30.4, iLow: 201, iHigh: 300 },
      { cLow: 30.5, cHigh: 40.4, iLow: 301, iHigh: 500 }
    ]
  }
};

/** The sensor reports SO2 in ppb; the DENR breakpoints are in ppm. */
export function toBreakpointUnit(pollutant: AqiPollutant, value: number): number {
  return pollutant === "so2" ? value / 1000 : value;
}

function truncate(value: number, decimals: number): number {
  const factor = 10 ** decimals;
  // The small epsilon keeps values like 0.035 (stored as 0.03499999...) from truncating down.
  return Math.floor(value * factor + 1e-9) / factor;
}

export type SubIndexDetail = {
  pollutant: AqiPollutant;
  /** Concentration in the breakpoint unit, truncated as the manual requires. */
  cp: number;
  unit: string;
  averaging: string;
  bpLo: number;
  bpHi: number;
  iLo: number;
  iHi: number;
  /** Unrounded Ip, as shown in the manual's worked examples. */
  exact: number;
  subIndex: number;
  category: CategoryInfo;
};

/**
 * Sub-index for one pollutant. `value` is in the sensor's unit (SO2 in ppb).
 * Returns null for missing or negative values (negative readings are sensor faults).
 */
export function subIndexDetail(pollutant: AqiPollutant, value: number | null | undefined): SubIndexDetail | null {
  if (value == null || !Number.isFinite(value) || value < 0) return null;

  const table = BREAKPOINTS[pollutant];
  const cp = truncate(toBreakpointUnit(pollutant, value), table.decimals);
  const bands = table.breakpoints;
  const last = bands[bands.length - 1]!;

  let band = last;
  for (const candidate of bands) {
    if (cp <= candidate.cHigh) {
      band = candidate;
      break;
    }
  }

  // Values in the gap between two bands (for example PM2.5 90.5) use the higher band's floor.
  const c = Math.min(Math.max(cp, band.cLow), band.cHigh);
  const exact =
    cp > last.cHigh
      ? last.iHigh
      : ((band.iHigh - band.iLow) / (band.cHigh - band.cLow)) * (c - band.cLow) + band.iLow;
  const subIndex = Math.min(500, Math.round(exact));

  return {
    pollutant,
    cp,
    unit: table.unit,
    averaging: table.averaging,
    bpLo: band.cLow,
    bpHi: band.cHigh,
    iLo: band.iLow,
    iHi: band.iHigh,
    exact: Number(exact.toFixed(2)),
    subIndex,
    category: categoryFor(subIndex)
  };
}

export function subIndex(pollutant: AqiPollutant, value: number | null | undefined): number | null {
  return subIndexDetail(pollutant, value)?.subIndex ?? null;
}
