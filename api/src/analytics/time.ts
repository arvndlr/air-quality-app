export const HOUR_MS = 60 * 60 * 1000;
export const DAY_MS = 24 * HOUR_MS;

type ZonedParts = { year: number; month: number; day: number; hour: number; minute: number; second: number };

const formatters = new Map<string, Intl.DateTimeFormat>();

function formatter(timeZone: string) {
  let f = formatters.get(timeZone);
  if (!f) {
    f = new Intl.DateTimeFormat("en-US", {
      timeZone,
      hourCycle: "h23",
      year: "numeric",
      month: "2-digit",
      day: "2-digit",
      hour: "2-digit",
      minute: "2-digit",
      second: "2-digit"
    });
    formatters.set(timeZone, f);
  }
  return f;
}

export function zonedParts(date: Date, timeZone: string): ZonedParts {
  const parts: Record<string, number> = {};
  for (const part of formatter(timeZone).formatToParts(date)) {
    if (part.type !== "literal") parts[part.type] = Number(part.value);
  }
  return {
    year: parts.year!,
    month: parts.month!,
    day: parts.day!,
    hour: parts.hour! % 24,
    minute: parts.minute!,
    second: parts.second!
  };
}

function offsetMs(date: Date, timeZone: string): number {
  const p = zonedParts(date, timeZone);
  const asUtc = Date.UTC(p.year, p.month - 1, p.day, p.hour, p.minute, p.second);
  return asUtc - Math.floor(date.getTime() / 1000) * 1000;
}

/** The instant local midnight starts on the zoned calendar day containing `date`. */
export function startOfZonedDay(date: Date, timeZone: string): Date {
  const p = zonedParts(date, timeZone);
  const utcMidnight = Date.UTC(p.year, p.month - 1, p.day);
  return new Date(utcMidnight - offsetMs(new Date(utcMidnight), timeZone));
}

export function addZonedDays(dayStart: Date, days: number, timeZone: string): Date {
  // Step by 36 h past the target and snap back, so DST zones also land on midnight.
  return startOfZonedDay(new Date(dayStart.getTime() + days * DAY_MS + 12 * HOUR_MS), timeZone);
}

export function zonedDateKey(date: Date, timeZone: string): string {
  const p = zonedParts(date, timeZone);
  return `${p.year}-${String(p.month).padStart(2, "0")}-${String(p.day).padStart(2, "0")}`;
}

export function zonedHour(date: Date, timeZone: string): number {
  return zonedParts(date, timeZone).hour;
}

export function startOfHour(date: Date): Date {
  return new Date(Math.floor(date.getTime() / HOUR_MS) * HOUR_MS);
}

export function startOfZonedYear(date: Date, timeZone: string): Date {
  const p = zonedParts(date, timeZone);
  const utc = Date.UTC(p.year, 0, 1);
  return new Date(utc - offsetMs(new Date(utc), timeZone));
}

export function formatHourLabel(hour: number): string {
  const suffix = hour < 12 ? "AM" : "PM";
  const h = hour % 12 === 0 ? 12 : hour % 12;
  return `${h} ${suffix}`;
}
