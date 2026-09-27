import { endOfDay, format, isValid, parseISO, startOfDay, subDays, subMonths, subWeeks } from "date-fns";

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

/** Human-readable description of the active window, used in headers and report metadata. */
export function describeRange(range: RangeKey, from: Date, to: Date) {
  if (range !== "custom") return rangeLabel.get(range) ?? "Custom";

  const fromLabel = format(from, "MMM d, yyyy");
  const toLabel = format(to, "MMM d, yyyy");
  return fromLabel === toLabel ? fromLabel : `${fromLabel} - ${toLabel}`;
}
