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
