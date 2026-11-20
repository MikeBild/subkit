import { normalizeForQuote } from "./normalize.ts";

export interface SpokenFacts {
  readonly text: string;
  readonly emails: ReadonlySet<string>;
  readonly urls: ReadonlySet<string>;
  readonly handles: ReadonlySet<string>;
  readonly numbers: ReadonlySet<string>;
  readonly dates: ReadonlySet<string>;
  readonly times: ReadonlySet<string>;
  readonly durations: ReadonlySet<number>;
}

const EMAIL = /[\p{L}\p{N}._%+-]+@[\p{L}\p{N}-]+(?:\.[\p{L}\p{N}-]+)+/gu;
const URL_RE = /https?:\/\/[^\s<>"'„“”‚‘’»«]+/gu;
const HANDLE = /(?<![\p{L}\p{N}])[@#][\p{L}\p{N}_][\p{L}\p{N}_.-]*/gu;
const TRAILING = /[.,;:!?)\]}]+$/u;

const NUMBER_WORDS: Readonly<Record<string, number>> = {
  ein: 1,
  eine: 1,
  einen: 1,
  eins: 1,
  zwei: 2,
  drei: 3,
  vier: 4,
  funf: 5,
  sechs: 6,
  sieben: 7,
  acht: 8,
  neun: 9,
  zehn: 10,
  elf: 11,
  zwolf: 12,
  one: 1,
  two: 2,
  three: 3,
  four: 4,
  five: 5,
  six: 6,
  seven: 7,
  eight: 8,
  nine: 9,
  ten: 10,
  eleven: 11,
  twelve: 12,
};

const MONTHS: Readonly<Record<string, number>> = {
  januar: 1,
  january: 1,
  jan: 1,
  februar: 2,
  february: 2,
  feb: 2,
  marz: 3,
  march: 3,
  mar: 3,
  april: 4,
  apr: 4,
  mai: 5,
  may: 5,
  juni: 6,
  june: 6,
  jun: 6,
  juli: 7,
  july: 7,
  jul: 7,
  august: 8,
  aug: 8,
  september: 9,
  sep: 9,
  sept: 9,
  oktober: 10,
  october: 10,
  okt: 10,
  oct: 10,
  november: 11,
  nov: 11,
  dezember: 12,
  december: 12,
  dez: 12,
  dec: 12,
};

const WEEKDAYS: Readonly<Record<string, number>> = {
  sonntag: 0,
  sunday: 0,
  montag: 1,
  monday: 1,
  dienstag: 2,
  tuesday: 2,
  mittwoch: 3,
  wednesday: 3,
  donnerstag: 4,
  thursday: 4,
  freitag: 5,
  friday: 5,
  samstag: 6,
  sonnabend: 6,
  saturday: 6,
};

const RELATIVE_DAYS: ReadonlyArray<readonly [RegExp, number]> = [
  [/\b(?:ubermorgen|day after tomorrow)\b/u, 2],
  [/\b(?:morgen|tomorrow)\b/u, 1],
  [/\b(?:heute|today|tonight)\b/u, 0],
];

function trimmed(token: string): string {
  return token.replace(TRAILING, "");
}

function pad(value: number): string {
  return String(value).padStart(2, "0");
}

export function canonicalNumber(value: number): string {
  return Number.isFinite(value) ? String(Number(value.toFixed(6))) : "";
}

export function numberCandidates(token: string): string[] {
  const out = new Set<string>();
  const add = (raw: string) => {
    const value = Number(raw);
    if (Number.isFinite(value)) out.add(canonicalNumber(value));
  };
  if (/^\d+$/.test(token)) add(token);
  if (/^\d{1,3}(?:\.\d{3})+(?:,\d+)?$/.test(token)) add(token.replace(/\./g, "").replace(",", "."));
  if (/^\d{1,3}(?:,\d{3})+(?:\.\d+)?$/.test(token)) add(token.replace(/,/g, ""));
  if (/^\d+,\d+$/.test(token)) add(token.replace(",", "."));
  if (/^\d+\.\d+$/.test(token)) add(token);
  return [...out];
}

function collectNumbers(folded: string, into: Set<string>): void {
  for (const match of folded.matchAll(/\d+(?:[.,]\d+)*/g)) {
    const token = match[0];
    for (const candidate of numberCandidates(token)) into.add(candidate);
    for (const part of token.split(/[.,]/)) {
      if (part.length > 0) into.add(canonicalNumber(Number(part)));
    }
  }
  for (const word of folded.split(/[^\p{L}]+/u)) {
    const value = NUMBER_WORDS[word];
    if (value !== undefined) into.add(String(value));
  }
}

function dayKey(month: number, day: number, year?: number): string[] {
  if (month < 1 || month > 12 || day < 1 || day > 31) return [];
  const short = `${pad(month)}-${pad(day)}`;
  return year === undefined ? [short] : [short, `${year}-${short}`];
}

function fullYear(raw: string | undefined): number | undefined {
  if (!raw) return undefined;
  const value = Number(raw);
  return raw.length === 2 ? 2000 + value : value;
}

export function localParts(
  instant: Date,
  timezone: string,
): { year: number; month: number; day: number; hour: number; minute: number; weekday: number } {
  const parts = new Intl.DateTimeFormat("en-US", {
    timeZone: timezone,
    year: "numeric",
    month: "2-digit",
    day: "2-digit",
    hour: "2-digit",
    minute: "2-digit",
    hourCycle: "h23",
    weekday: "short",
  }).formatToParts(instant);
  const read = (type: string) => parts.find((part) => part.type === type)?.value ?? "";
  const weekday = ["Sun", "Mon", "Tue", "Wed", "Thu", "Fri", "Sat"].indexOf(read("weekday"));
  return {
    year: Number(read("year")),
    month: Number(read("month")),
    day: Number(read("day")),
    hour: Number(read("hour")),
    minute: Number(read("minute")),
    weekday,
  };
}

function shifted(now: Date, timezone: string, days: number): string[] {
  const base = localParts(now, timezone);
  const moved = new Date(Date.UTC(base.year, base.month - 1, base.day + days));
  return dayKey(moved.getUTCMonth() + 1, moved.getUTCDate(), moved.getUTCFullYear());
}

function collectDates(folded: string, now: Date, timezone: string, into: Set<string>): void {
  const add = (keys: string[]) => {
    for (const key of keys) into.add(key);
  };
  for (const m of folded.matchAll(/\b(\d{4})-(\d{2})-(\d{2})\b/g)) {
    add(dayKey(Number(m[2]), Number(m[3]), Number(m[1])));
  }
  for (const m of folded.matchAll(/\b(\d{1,2})\.(\d{1,2})\.(\d{4}|\d{2})?(?!\d)/g)) {
    add(dayKey(Number(m[2]), Number(m[1]), fullYear(m[3])));
  }
  for (const m of folded.matchAll(/\b(\d{1,2})\/(\d{1,2})(?:\/(\d{4}|\d{2}))?\b/g)) {
    add(dayKey(Number(m[1]), Number(m[2]), fullYear(m[3])));
    add(dayKey(Number(m[2]), Number(m[1]), fullYear(m[3])));
  }
  for (const m of folded.matchAll(/\b(\d{1,2})\.?\s+(?:of\s+)?(\p{L}+)\.?(?:\s+(\d{4}))?/gu)) {
    const month = MONTHS[m[2] ?? ""];
    if (month !== undefined) add(dayKey(month, Number(m[1]), fullYear(m[3])));
  }
  for (const m of folded.matchAll(/\b(\p{L}+)\.?\s+(\d{1,2})(?:st|nd|rd|th)?(?:,?\s+(\d{4}))?/gu)) {
    const month = MONTHS[m[1] ?? ""];
    if (month !== undefined) add(dayKey(month, Number(m[2]), fullYear(m[3])));
  }
  for (const [pattern, days] of RELATIVE_DAYS) {
    if (pattern.test(folded)) add(shifted(now, timezone, days));
  }
  const today = localParts(now, timezone).weekday;
  for (const word of folded.split(/[^\p{L}]+/u)) {
    const weekday = WEEKDAYS[word];
    if (weekday === undefined || today < 0) continue;
    const ahead = (weekday - today + 7) % 7;
    add(shifted(now, timezone, ahead === 0 ? 7 : ahead));
    if (ahead === 0) add(shifted(now, timezone, 0));
  }
}

function timeKey(hour: number, minute: number): string | null {
  return hour >= 0 && hour <= 23 && minute >= 0 && minute <= 59
    ? `${pad(hour)}:${pad(minute)}`
    : null;
}

function collectTimes(folded: string, into: Set<string>): void {
  const add = (key: string | null) => {
    if (key) into.add(key);
  };
  for (const m of folded.matchAll(/\b(\d{1,2}):(\d{2})\b(?!\s*(?:am|pm)\b)/g)) {
    add(timeKey(Number(m[1]), Number(m[2])));
  }
  for (const m of folded.matchAll(/\b(\d{1,2})(?:[.:](\d{2}))?\s*uhr\b/g)) {
    add(timeKey(Number(m[1]), Number(m[2] ?? "0")));
  }
  for (const m of folded.matchAll(/\b(\d{1,2})(?::(\d{2}))?\s*(am|pm)\b/g)) {
    const raw = Number(m[1]) % 12;
    add(timeKey(m[3] === "pm" ? raw + 12 : raw, Number(m[2] ?? "0")));
  }
  for (const m of folded.matchAll(
    /\b(\d{1,2})(?::(\d{2}))?\s*(?:bis|to|-)\s*\d{1,2}(?::\d{2})?\s*(uhr|am|pm)\b/g,
  )) {
    const raw = Number(m[1]);
    const hour = m[3] === "uhr" ? raw : (raw % 12) + (m[3] === "pm" ? 12 : 0);
    add(timeKey(hour, Number(m[2] ?? "0")));
  }
  if (/\b(?:noon|mittags?)\b/u.test(folded)) add("12:00");
}

const DURATION_UNITS: ReadonlyArray<readonly [RegExp, number]> = [
  [/^(?:minuten?|min|minutes?|mins)$/u, 1],
  [/^(?:stunden?|std|h|hours?|hrs?)$/u, 60],
];

const DURATION =
  /(?<![\p{L}\p{N}])(\d+(?:[.,]\d+)?|\p{L}+)\s*(minuten?|minutes?|mins?|stunden?|std|hours?|hrs?|h)(?![\p{L}\p{N}])/gu;

function collectDurations(folded: string, into: Set<number>): void {
  for (const m of folded.matchAll(DURATION)) {
    const unit = DURATION_UNITS.find(([pattern]) => pattern.test(m[2] ?? ""))?.[1];
    const raw = m[1] ?? "";
    const amount = /^\d/u.test(raw) ? Number(raw.replace(",", ".")) : NUMBER_WORDS[raw];
    if (unit === undefined || amount === undefined || !Number.isFinite(amount)) continue;
    const minutes = Math.round(amount * unit);
    if (minutes > 0 && minutes <= 24 * 60) into.add(minutes);
  }
  if (/\b(?:halbe stunde|half an hour|half hour)\b/u.test(folded)) into.add(30);
  if (/\b(?:anderthalb|eineinhalb) stunden?\b|\bone and a half hours?\b/u.test(folded)) {
    into.add(90);
  }
}

export function spokenFacts(texts: readonly string[], now: Date, timezone: string): SpokenFacts {
  const emails = new Set<string>();
  const urls = new Set<string>();
  const handles = new Set<string>();
  const numbers = new Set<string>();
  const dates = new Set<string>();
  const times = new Set<string>();
  const durations = new Set<number>();
  const normalized: string[] = [];
  for (const raw of texts) {
    for (const m of raw.matchAll(URL_RE)) urls.add(trimmed(m[0]));
    const withoutUrls = raw.replace(URL_RE, " ");
    for (const m of withoutUrls.matchAll(EMAIL)) emails.add(trimmed(m[0]));
    for (const m of withoutUrls.replace(EMAIL, " ").matchAll(HANDLE)) handles.add(trimmed(m[0]));
    const folded = normalizeForQuote(raw.replace(URL_RE, " ").replace(EMAIL, " ")).toLowerCase();
    collectNumbers(folded, numbers);
    collectDates(folded, now, timezone, dates);
    collectTimes(folded, times);
    collectDurations(folded, durations);
    normalized.push(normalizeForQuote(raw));
  }
  return { text: normalized.join("\n"), emails, urls, handles, numbers, dates, times, durations };
}

export function namesAddressee(facts: SpokenFacts): boolean {
  return facts.emails.size > 0 || facts.urls.size > 0 || facts.handles.size > 0;
}
