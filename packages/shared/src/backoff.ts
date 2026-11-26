export type BackoffJitter = "equal" | "none" | "full" | { readonly symmetric: number };

export interface BackoffOptions {
  readonly baseMs?: number;
  readonly maxMs?: number;
  readonly factor?: number;
  readonly jitter?: BackoffJitter;
  readonly round?: boolean;
}

export const BACKOFF_BASE_MS = 1_000;
export const BACKOFF_MAX_MS = 60_000;
export const BACKOFF_FACTOR = 2;
const MAX_EXPONENT = 16;

export function applyJitter(ms: number, random: number, jitter: BackoffJitter): number {
  const share = Math.min(Math.max(random, 0), 1);
  if (jitter === "none") return ms;
  if (jitter === "full") return ms * share;
  if (jitter === "equal") return ms / 2 + (ms / 2) * share;
  return Math.max(0, ms + (share * 2 - 1) * ms * jitter.symmetric);
}

export function backoffDelay(
  attempt: number,
  random: number,
  options: BackoffOptions = {},
): number {
  const base = options.baseMs ?? BACKOFF_BASE_MS;
  const max = options.maxMs ?? BACKOFF_MAX_MS;
  const factor = options.factor ?? BACKOFF_FACTOR;
  const exponent = Math.min(Math.max(attempt, 0), MAX_EXPONENT);
  const ceiling = Math.min(max, base * factor ** exponent);
  const delay = applyJitter(ceiling, random, options.jitter ?? "equal");
  return options.round === false ? delay : Math.round(delay);
}

export function retryAfterHeaderMs(
  header: string | null | undefined,
  nowMs: number,
): number | null {
  if (!header) return null;
  const trimmed = header.trim();
  const seconds = Number.parseFloat(trimmed);
  if (Number.isFinite(seconds)) return Math.max(0, seconds * 1000);
  const date = Date.parse(trimmed);
  return Number.isNaN(date) ? null : Math.max(0, date - nowMs);
}

export function retryAfterDeltaSeconds(value: string | null | undefined): number | null {
  return value && /^\d{1,6}$/.test(value) ? Number(value) : null;
}

function nonNegativeSeconds(raw: unknown): number | undefined {
  const seconds =
    typeof raw === "number" ? raw : typeof raw === "string" ? Number(raw) : Number.NaN;
  return Number.isFinite(seconds) && seconds >= 0 ? Math.ceil(seconds) : undefined;
}

export function retryAfterSecondsFromDetails(details: unknown): number | undefined {
  if (!details || typeof details !== "object") return undefined;
  const fields = details as Record<string, unknown>;
  return nonNegativeSeconds(fields.retry_after ?? fields.retryAfter ?? fields.retry_after_seconds);
}

export function retryAfterSecondsUntil(resetsAt: unknown, nowMs: number): number | undefined {
  const resetAt = typeof resetsAt === "string" ? Date.parse(resetsAt) : Number.NaN;
  return Number.isNaN(resetAt) ? undefined : Math.max(1, Math.ceil((resetAt - nowMs) / 1000));
}
