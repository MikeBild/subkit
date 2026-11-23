export type StepLimit =
  | { kind: "time"; ms: number; ceiling: boolean }
  | { kind: "pages"; count: number }
  | { kind: "items"; count: number }
  | { kind: "response"; bytes: number }
  | { kind: "memory"; bytes: number };

const TIME_CODES: Readonly<Record<string, RegExp>> = {
  step_timeout: /\brequest exceeded (\d+)ms\b/,
  transform_timeout: /\btransform exceeded (\d+)ms\b/,
};

const RESPONSE_CAP = /\bexceeds max_response_bytes (\d+)\b/;
const MAX_PAGES = /\bmax_pages=(\d+)\b/;
const MAX_ITEMS = /\bmax_items=(\d+)\b/;
const MEMORY_CAP = /\bexceeded the (\d+)MB in-memory byte cap\b/;
const CEILING = /\boperator ceiling sandbox\.max_transform_wall_ms\b/;

function field(value: unknown, key: string): unknown {
  return value !== null && typeof value === "object"
    ? (value as Record<string, unknown>)[key]
    : undefined;
}

function positive(raw: string | undefined): number | null {
  if (raw === undefined) return null;
  const value = Number(raw);
  return Number.isSafeInteger(value) && value > 0 ? value : null;
}

function timeLimit(code: string, message: string, error: unknown): StepLimit | null {
  const pattern = TIME_CODES[code];
  if (!pattern) return null;
  const given = field(error, "limit_ms");
  const ms =
    typeof given === "number" && Number.isSafeInteger(given) && given > 0
      ? given
      : positive(pattern.exec(message)?.[1]);
  return ms === null ? null : { kind: "time", ms, ceiling: CEILING.test(message) };
}

function pagingLimit(message: string): StepLimit | null {
  const pages = positive(MAX_PAGES.exec(message)?.[1]);
  if (pages !== null) return { kind: "pages", count: pages };
  const items = positive(MAX_ITEMS.exec(message)?.[1]);
  if (items !== null) return { kind: "items", count: items };
  const megabytes = positive(MEMORY_CAP.exec(message)?.[1]);
  return megabytes === null ? null : { kind: "memory", bytes: megabytes * 1024 * 1024 };
}

export function stepLimitOf(error: unknown): StepLimit | null {
  const code = field(error, "code");
  const message = field(error, "message");
  if (typeof code !== "string" || typeof message !== "string") return null;
  const time = timeLimit(code, message, error);
  if (time) return time;
  if (code === "pagination_limit_reached") return pagingLimit(message);
  const response = positive(RESPONSE_CAP.exec(message)?.[1]);
  return response === null ? null : { kind: "response", bytes: response };
}

export function formatLimitDuration(ms: number, localeTag: string): string {
  const number = (value: number) =>
    new Intl.NumberFormat(localeTag, { maximumFractionDigits: 1 }).format(value);
  if (ms < 1000) return `${number(ms)} ms`;
  if (ms < 60_000) return `${number(ms / 1000)} s`;
  if (ms < 3_600_000) return `${number(ms / 60_000)} min`;
  return `${number(ms / 3_600_000)} h`;
}
