// DENR-EMB Air Quality Index categories (Procedural Manual on Data Handling Conventions, 2021).
// Mirrors CATEGORIES in api/src/aqi.ts.

export type AqiCategoryKey = "good" | "fair" | "usg" | "very-unhealthy" | "acutely-unhealthy" | "emergency";

export type AqiCategoryInfo = {
  key: AqiCategoryKey;
  label: string;
  short: string;
  min: number;
  max: number;
  color: string;
  /** Text colour that stays readable on `color`. */
  ink: string;
};

export const AQI_CATEGORIES: AqiCategoryInfo[] = [
  { key: "good", label: "Good", short: "Good", min: 0, max: 50, color: "#00e400", ink: "#0b2b0b" },
  { key: "fair", label: "Fair", short: "Fair", min: 51, max: 100, color: "#ffff00", ink: "#3a3a00" },
  { key: "usg", label: "Unhealthy for Sensitive Groups", short: "USG", min: 101, max: 150, color: "#ff7e00", ink: "#2b1600" },
  { key: "very-unhealthy", label: "Very Unhealthy", short: "Very Unhealthy", min: 151, max: 200, color: "#ff0000", ink: "#ffffff" },
  { key: "acutely-unhealthy", label: "Acutely Unhealthy", short: "Acutely Unhealthy", min: 201, max: 300, color: "#8f3f97", ink: "#ffffff" },
  { key: "emergency", label: "Emergency", short: "Emergency", min: 301, max: 500, color: "#7e0023", ink: "#ffffff" }
];

export function categoryForIndex(index: number): AqiCategoryInfo {
  return AQI_CATEGORIES.find((c) => index <= c.max) ?? AQI_CATEGORIES[AQI_CATEGORIES.length - 1]!;
}

export function categoryByKey(key: string | null | undefined): AqiCategoryInfo | null {
  return AQI_CATEGORIES.find((c) => c.key === key) ?? null;
}

export function categoryByLabel(label: string | null | undefined): AqiCategoryInfo | null {
  if (!label) return null;
  const lower = label.toLowerCase();
  return AQI_CATEGORIES.find((c) => c.label.toLowerCase() === lower) ?? null;
}

export function categoryColor(label: string | null | undefined): string {
  return categoryByLabel(label)?.color ?? "#888888";
}

export const AQI_SCALE_TEXT = AQI_CATEGORIES.map((c) => `${c.min}–${c.max} ${c.label}`).join(" · ");
