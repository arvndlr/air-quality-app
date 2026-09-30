import {
  endOfDay,
  endOfMonth,
  format,
  isValid,
  parse,
  parseISO,
  startOfDay,
  startOfMonth,
  subDays,
  subMonths,
  subWeeks,
  subYears
} from "date-fns";

export type RangeKey = "day" | "week" | "month" | "custom";

export const rangeOptions: Array<{ key: RangeKey; label: string }> = [
  { key: "day", label: "24 Hours" },
  { key: "week", label: "7 Days" },
  { key: "month", label: "30 Days" },
  { key: "custom", label: "Custom dates" }
];

export const rangeLabel = new Map(rangeOptions.map((option) => [option.key, option.label] as const));

/** Value for an `<input type="date">`, which always speaks local `yyyy-MM-dd`. */
export function toDateInputValue(date: Date) {
  return format(date, "yyyy-MM-dd");
}

export function defaultCustomStart() {
  return toDateInputValue(subDays(new Date(), 6));
}

export function defaultCustomEnd() {
  return toDateInputValue(new Date());
}

export type ResolvedRange = { from: Date; to: Date; error: string | null };

/**
 * Turns the selected preset (or the two custom date inputs) into an absolute window.
 * Custom dates cover whole local days so picking a single date returns that entire day.
 */
export function resolveRange(range: RangeKey, customFrom: string, customTo: string): ResolvedRange {
  const now = new Date();

  if (range === "day") return { from: subDays(now, 1), to: now, error: null };
  if (range === "week") return { from: subWeeks(now, 1), to: now, error: null };
  if (range === "month") return { from: subMonths(now, 1), to: now, error: null };

  const parsedFrom = customFrom ? parseISO(customFrom) : null;
  const parsedTo = customTo ? parseISO(customTo) : null;

  if (!parsedFrom || !isValid(parsedFrom) || !parsedTo || !isValid(parsedTo)) {
    return {
      from: startOfDay(subDays(now, 6)),
      to: endOfDay(now),
      error: "Pick both a start and an end date to search a specific period."
    };
  }

  const from = startOfDay(parsedFrom);
  const to = endOfDay(parsedTo);

  if (from > to) {
    return { from, to: endOfDay(parsedFrom), error: "The start date must be on or before the end date." };
  }

  return { from, to, error: null };
}

export type DateSearchResult = { from: string; to: string } | { error: string };

// Tried in order. Formats without a year fall back to the most recent matching date.
const daySearchFormats = [
  "yyyy-MM-dd",
  "yyyy/MM/dd",
  "M/d/yyyy",
  "M-d-yyyy",
  "MMM d yyyy",
  "MMMM d yyyy",
  "d MMM yyyy",
  "d MMMM yyyy",
  "MMM d",
  "MMMM d",
  "d MMM",
  "d MMMM",
  "M/d"
];
const monthSearchFormats = ["yyyy-MM", "yyyy/MM", "MMM yyyy", "MMMM yyyy", "M/yyyy"];

function normalizeSearchText(text: string) {
  return text
    .trim()
    .replace(/,/g, " ")
    .replace(/(\d+)(st|nd|rd|th)\b/gi, "$1")
    .replace(/\bsept\b/gi, "Sep")
    .replace(/\s+/g, " ");
}

function hasYear(pattern: string) {
  return pattern.includes("yyyy");
}

/** Parses one side of a search, returning the whole local day (or month) it names. */
function parseSearchTerm(term: string): { from: Date; to: Date } | null {
  const now = new Date();
  const text = normalizeSearchText(term);
  const lower = text.toLowerCase();

  if (lower === "today") return { from: startOfDay(now), to: endOfDay(now) };
  if (lower === "yesterday") {
    const day = subDays(now, 1);
    return { from: startOfDay(day), to: endOfDay(day) };
  }

  for (const pattern of daySearchFormats) {
    let parsed = parse(text, pattern, now);
    if (!isValid(parsed)) continue;
    if (!hasYear(pattern) && parsed > now) parsed = subYears(parsed, 1);
    return { from: startOfDay(parsed), to: endOfDay(parsed) };
  }

  for (const pattern of monthSearchFormats) {
    const parsed = parse(text, pattern, now);
    if (!isValid(parsed)) continue;
    return { from: startOfMonth(parsed), to: endOfMonth(parsed) };
  }

  return null;
}

/**
 * Turns free text from the history search bar into custom `yyyy-MM-dd` bounds.
 * Accepts a single day ("2026-09-15", "Sep 15", "9/15/2026", "yesterday"), a month
 * ("Sep 2026", "2026-09"), or a range of either joined by "to" or " - ".
 */
export function parseDateSearch(query: string): DateSearchResult {
  const text = query.trim();
  if (!text) return { error: "Type a date to search, for example 2026-09-15 or Sep 15." };

  const parts = text.split(/\s+(?:to|until|through|-|–|—)\s+/i);
  if (parts.length > 2) return { error: "Search one date or a single range like \"Sep 1 to Sep 5\"." };

  const start = parseSearchTerm(parts[0]);
  const end = parts.length === 2 ? parseSearchTerm(parts[1]) : start;

  if (!start || !end) {
    return { error: `Couldn't read "${text}" as a date. Try 2026-09-15, Sep 15 2026, or 9/15/2026.` };
  }

  if (start.from > end.to) return { error: "The start date must be on or before the end date." };

  return { from: toDateInputValue(start.from), to: toDateInputValue(end.to) };
}

/** Human-readable description of the active window, used in headers and report metadata. */
export function describeRange(range: RangeKey, from: Date, to: Date) {
  if (range !== "custom") return rangeLabel.get(range) ?? "Custom";

  const fromLabel = format(from, "MMM d, yyyy");
  const toLabel = format(to, "MMM d, yyyy");
  return fromLabel === toLabel ? fromLabel : `${fromLabel} - ${toLabel}`;
}
