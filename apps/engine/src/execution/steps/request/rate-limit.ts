import { AsyncLocalStorage } from "node:async_hooks";
import { backoffDelay, retryAfterHeaderMs } from "@shared/backoff.ts";
import { backoffMs } from "./retry.ts";

const RATE_LIMIT_MAX_WAIT_MS = 60 * 60_000;
const SECONDARY_MIN_WAIT_MS = 60_000;
const SECONDARY_MAX_WAIT_MS = Number.POSITIVE_INFINITY;
const RESET_MARGIN_MS = 1000;

type RateLimitReason = "retry_after" | "primary_reset" | "secondary_backoff" | "backoff";

type RateLimitVerdict =
  | { kind: "none" }
  | { kind: "wait"; delay_ms: number; reason: RateLimitReason }
  | { kind: "fail"; delay_ms: number; reason: RateLimitReason };

interface RateLimitInput {
  status: number;
  headers: Record<string, string>;
  body: unknown;
  attempt: number;
  now_ms: number;
  backoff_base_ms: number;
  deadline_ms: number;
  limited?: boolean;
}

const RATE_LIMIT_MESSAGE = /secondary rate limit|rate limit exceeded|abuse detection/i;

function bodyMessages(body: unknown): string[] {
  if (!body || typeof body !== "object") return [];
  const record = body as { message?: unknown; errors?: unknown };
  const messages = typeof record.message === "string" ? [record.message] : [];
  if (Array.isArray(record.errors))
    for (const entry of record.errors)
      if (entry && typeof entry === "object") {
        const { message, type } = entry as { message?: unknown; type?: unknown };
        if (typeof message === "string") messages.push(message);
        if (type === "RATE_LIMITED") messages.push("rate limit exceeded");
      }
  return messages;
}

export function rateLimitDelayMs(input: RateLimitInput): RateLimitVerdict {
  const retryAfter = retryAfterHeaderMs(input.headers["retry-after"], input.now_ms);
  const exhausted = input.headers["x-ratelimit-remaining"]?.trim() === "0";
  const messageSignal = bodyMessages(input.body).some((message) =>
    RATE_LIMIT_MESSAGE.test(message),
  );
  const limited =
    input.limited ??
    (input.status === 429 ||
      (input.status === 403 && (retryAfter !== null || exhausted || messageSignal)));
  if (!limited) return { kind: "none" };
  const resetSeconds = Number.parseInt(input.headers["x-ratelimit-reset"] ?? "", 10);
  const [delay_ms, reason]: [number, RateLimitReason] =
    retryAfter !== null
      ? [retryAfter, "retry_after"]
      : exhausted && Number.isFinite(resetSeconds)
        ? [Math.max(0, resetSeconds * 1000 - input.now_ms) + RESET_MARGIN_MS, "primary_reset"]
        : messageSignal || input.status === 403
          ? [
              backoffDelay(input.attempt - 1, 0, {
                baseMs: SECONDARY_MIN_WAIT_MS,
                maxMs: SECONDARY_MAX_WAIT_MS,
                jitter: "none",
              }),
              "secondary_backoff",
            ]
          : [backoffMs(input.attempt, input.backoff_base_ms), "backoff"];
  const tooLong = delay_ms > RATE_LIMIT_MAX_WAIT_MS || input.now_ms + delay_ms >= input.deadline_ms;
  return { kind: tooLong ? "fail" : "wait", delay_ms, reason };
}

export type RateLimitDeadlineScope = "step" | "workflow";

interface RateLimitDeadline {
  deadline_ms: number;
  deadline_scope: RateLimitDeadlineScope;
}

export function rateLimitDeadline(
  stepTimeoutMs: number,
  workflowDeadlineMs: number | undefined,
): RateLimitDeadline {
  const stepDeadlineMs = rateLimitNow() + stepTimeoutMs;
  return workflowDeadlineMs !== undefined && workflowDeadlineMs < stepDeadlineMs
    ? { deadline_ms: workflowDeadlineMs, deadline_scope: "workflow" }
    : { deadline_ms: stepDeadlineMs, deadline_scope: "step" };
}

interface RateLimitClock {
  now: () => number;
  sleep: (ms: number, signal: AbortSignal) => Promise<void>;
}

const clockStore = new AsyncLocalStorage<RateLimitClock>();

export function rateLimitNow(): number {
  return clockStore.getStore()?.now() ?? Date.now();
}

export function rateLimitSleepOverride(): RateLimitClock["sleep"] | null {
  return clockStore.getStore()?.sleep ?? null;
}

export function withRateLimitClockForTests<T>(
  clock: RateLimitClock,
  body: () => Promise<T>,
): Promise<T> {
  return clockStore.run(clock, body);
}
