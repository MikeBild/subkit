type DatePart = "day" | "month" | "year";

const DATE_OPTIONS = { day: "2-digit", month: "2-digit", year: "numeric" } as const;
const TIME_OPTIONS = { hour: "2-digit", minute: "2-digit", hourCycle: "h23" } as const;

const pad = (n: number) => String(n).padStart(2, "0");

function dateOrder(tag: string): DatePart[] {
  return new Intl.DateTimeFormat(tag, DATE_OPTIONS)
    .formatToParts(new Date(2026, 11, 21))
    .map((part) => part.type)
    .filter((type): type is DatePart => type === "day" || type === "month" || type === "year");
}

function splitValue(value: string, withTime: boolean): Date | null {
  const match = withTime
    ? /^(\d{4})-(\d{2})-(\d{2})T(\d{2}):(\d{2})/.exec(value)
    : /^(\d{4})-(\d{2})-(\d{2})$/.exec(value);
  if (!match) return null;
  const [y, m, d, h = 0, min = 0] = match.slice(1).map(Number);
  return new Date(y ?? 0, (m ?? 1) - 1, d ?? 1, h, min);
}

export function formatLocalValue(value: string, tag: string, withTime = false): string {
  const at = splitValue(value, withTime);
  if (!at) return "";
  return new Intl.DateTimeFormat(
    tag,
    withTime ? { ...DATE_OPTIONS, ...TIME_OPTIONS } : DATE_OPTIONS,
  ).format(at);
}

export function parseLocalValue(text: string, tag: string, withTime = false): string | null {
  const trimmed = text.trim();
  if (!trimmed) return "";
  const numbers = trimmed.match(/\d+/g)?.map(Number) ?? [];
  if (numbers.length !== (withTime ? 5 : 3)) return null;
  const parts: Partial<Record<DatePart, number>> = {};
  dateOrder(tag).forEach((part, index) => {
    parts[part] = numbers[index];
  });
  const day = parts.day ?? 0;
  const month = parts.month ?? 0;
  const rawYear = parts.year ?? 0;
  const year = rawYear < 100 ? 2000 + rawYear : rawYear;
  const hour = withTime ? (numbers[3] ?? 0) : 0;
  const minute = withTime ? (numbers[4] ?? 0) : 0;
  const at = new Date(year, month - 1, day, hour, minute);
  const real =
    year >= 1000 &&
    year <= 9999 &&
    at.getFullYear() === year &&
    at.getMonth() === month - 1 &&
    at.getDate() === day &&
    at.getHours() === hour &&
    at.getMinutes() === minute;
  if (!real) return null;
  const date = `${year}-${pad(month)}-${pad(day)}`;
  return withTime ? `${date}T${pad(hour)}:${pad(minute)}` : date;
}
