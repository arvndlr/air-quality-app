// US EPA AQI calculation from PM2.5, PM10, CO, NO2, and SO2.
// Reference: https://www.airnow.gov/sites/default/files/2020-05/aqi-technical-assistance-document-sept2018.pdf

export type AqiCategory =
  | "Good"
  | "Moderate"
  | "Unhealthy for Sensitive Groups"
  | "Unhealthy"
  | "Very Unhealthy"
  | "Hazardous";

export type DominantPollutant = "pm25" | "pm10" | "co" | "no2" | "so2";

export type AqiResult = {
  aqi: number;
  category: AqiCategory;
  color: string;
  dominantPollutant: DominantPollutant;
  pm25SubIndex: number;
  pm10SubIndex: number;
  coSubIndex: number;
  no2SubIndex: number;
  so2SubIndex: number;
};

export type AqiInput = {
  pm25?: number | null;   // ug/m3
  pm10?: number | null;   // ug/m3
  co?: number | null;     // ppm
  no2?: number | null;    // ppb
  so2?: number | null;    // ppb
};

type Breakpoint = { cLow: number; cHigh: number; iLow: number; iHigh: number };

// PM2.5 24-hour breakpoints (ug/m3). Instantaneous values used as real-time proxy.
const PM25_BP: Breakpoint[] = [
  { cLow: 0.0, cHigh: 12.0, iLow: 0, iHigh: 50 },
  { cLow: 12.1, cHigh: 35.4, iLow: 51, iHigh: 100 },
  { cLow: 35.5, cHigh: 55.4, iLow: 101, iHigh: 150 },
  { cLow: 55.5, cHigh: 150.4, iLow: 151, iHigh: 200 },
  { cLow: 150.5, cHigh: 250.4, iLow: 201, iHigh: 300 },
  { cLow: 250.5, cHigh: 350.4, iLow: 301, iHigh: 400 },
  { cLow: 350.5, cHigh: 500.4, iLow: 401, iHigh: 500 },
];

// PM10 24-hour breakpoints (ug/m3)
const PM10_BP: Breakpoint[] = [
  { cLow: 0, cHigh: 54, iLow: 0, iHigh: 50 },
  { cLow: 55, cHigh: 154, iLow: 51, iHigh: 100 },
  { cLow: 155, cHigh: 254, iLow: 101, iHigh: 150 },
  { cLow: 255, cHigh: 354, iLow: 151, iHigh: 200 },
  { cLow: 355, cHigh: 424, iLow: 201, iHigh: 300 },
  { cLow: 425, cHigh: 504, iLow: 301, iHigh: 400 },
  { cLow: 505, cHigh: 604, iLow: 401, iHigh: 500 },
];

// CO 8-hour breakpoints (ppm)
const CO_BP: Breakpoint[] = [
  { cLow: 0.0, cHigh: 4.4, iLow: 0, iHigh: 50 },
  { cLow: 4.5, cHigh: 9.4, iLow: 51, iHigh: 100 },
  { cLow: 9.5, cHigh: 12.4, iLow: 101, iHigh: 150 },
  { cLow: 12.5, cHigh: 15.4, iLow: 151, iHigh: 200 },
  { cLow: 15.5, cHigh: 30.4, iLow: 201, iHigh: 300 },
  { cLow: 30.5, cHigh: 50.4, iLow: 301, iHigh: 500 },
];

// NO2 1-hour breakpoints (ppb)
const NO2_BP: Breakpoint[] = [
  { cLow: 0, cHigh: 53, iLow: 0, iHigh: 50 },
  { cLow: 54, cHigh: 100, iLow: 51, iHigh: 100 },
  { cLow: 101, cHigh: 360, iLow: 101, iHigh: 150 },
  { cLow: 361, cHigh: 649, iLow: 151, iHigh: 200 },
  { cLow: 650, cHigh: 1249, iLow: 201, iHigh: 300 },
  { cLow: 1250, cHigh: 2049, iLow: 301, iHigh: 500 },
];

// SO2 1-hour breakpoints (ppb). EPA defines 1-hour values up to AQI 300 only.
const SO2_BP: Breakpoint[] = [
  { cLow: 0, cHigh: 35, iLow: 0, iHigh: 50 },
  { cLow: 36, cHigh: 75, iLow: 51, iHigh: 100 },
  { cLow: 76, cHigh: 185, iLow: 101, iHigh: 150 },
  { cLow: 186, cHigh: 304, iLow: 151, iHigh: 200 },
  { cLow: 305, cHigh: 604, iLow: 201, iHigh: 300 },
];

const CATEGORIES: Array<{ max: number; category: AqiCategory; color: string }> = [
  { max: 50, category: "Good", color: "#00e400" },
  { max: 100, category: "Moderate", color: "#ffff00" },
  { max: 150, category: "Unhealthy for Sensitive Groups", color: "#ff7e00" },
  { max: 200, category: "Unhealthy", color: "#ff0000" },
  { max: 300, category: "Very Unhealthy", color: "#8f3f97" },
  { max: 500, category: "Hazardous", color: "#7e0023" },
];

function truncate(value: number, decimals: number): number {
  const factor = 10 ** decimals;
  return Math.floor(value * factor) / factor;
}

function calcSubIndex(concentration: number, breakpoints: Breakpoint[], decimals: number): number {
  const c = Math.max(0, truncate(concentration, decimals));
  const last = breakpoints[breakpoints.length - 1]!;
  if (c > last.cHigh) return last.iHigh;

  for (const bp of breakpoints) {
    if (c >= bp.cLow && c <= bp.cHigh) {
      return Math.round(((bp.iHigh - bp.iLow) / (bp.cHigh - bp.cLow)) * (c - bp.cLow) + bp.iLow);
    }
  }
  return 0;
}

function getCategory(aqi: number): { category: AqiCategory; color: string } {
  for (const cat of CATEGORIES) {
    if (aqi <= cat.max) return cat;
  }
  return CATEGORIES[CATEGORIES.length - 1]!;
}

export function computeAqi(input: AqiInput): AqiResult | null {
  const { pm25, pm10, co, no2, so2 } = input;

  if (pm25 == null && pm10 == null && co == null && no2 == null && so2 == null) {
    return null;
  }

  const pm25Sub = pm25 != null ? calcSubIndex(pm25, PM25_BP, 1) : 0;
  const pm10Sub = pm10 != null ? calcSubIndex(pm10, PM10_BP, 0) : 0;
  const coSub = co != null && co >= 0 ? calcSubIndex(co, CO_BP, 1) : 0;
  const no2Sub = no2 != null && no2 >= 0 ? calcSubIndex(no2, NO2_BP, 0) : 0;
  const so2Sub = so2 != null && so2 >= 0 ? calcSubIndex(so2, SO2_BP, 0) : 0;

  const entries: Array<{ key: DominantPollutant; value: number }> = [
    { key: "pm25", value: pm25Sub },
    { key: "pm10", value: pm10Sub },
    { key: "co", value: coSub },
    { key: "no2", value: no2Sub },
    { key: "so2", value: so2Sub },
  ];

  const dominant = entries.reduce((a, b) => (b.value > a.value ? b : a));
  const aqi = dominant.value;
  const { category, color } = getCategory(aqi);

  return {
    aqi,
    category,
    color,
    dominantPollutant: dominant.key,
    pm25SubIndex: pm25Sub,
    pm10SubIndex: pm10Sub,
    coSubIndex: coSub,
    no2SubIndex: no2Sub,
    so2SubIndex: so2Sub,
  };
}
