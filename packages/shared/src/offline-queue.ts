export const OFFLINE_QUEUE_MAX_ITEMS = 20;
export const OFFLINE_QUEUE_MAX_AGE_MS = 14 * 24 * 60 * 60_000;
export const OFFLINE_RETRY_BASE_MS = 30_000;
export const OFFLINE_RETRY_MAX_MS = 30 * 60_000;

export type OfflineItemState = "waiting" | "held_auth" | "failed";

export type OfflineFailure = "refused" | "conflict" | "too_large" | "expired";

export interface OfflineIdentity {
  readonly server: string;
  readonly user_id: string;
}

export interface OfflineItem<P> extends OfflineIdentity {
  readonly id: string;
  readonly kind: "feedback";
  readonly created_on_device_at: string;
  readonly payload: P;
  readonly attempts: number;
  readonly next_attempt_at: number;
  readonly state: OfflineItemState;
  readonly failure: OfflineFailure | null;
}

export type OfflineOutcome =
  | { readonly kind: "delivered" }
  | { readonly kind: "retry" }
  | { readonly kind: "wait"; readonly seconds: number }
  | { readonly kind: "sign_in" }
  | { readonly kind: "failed"; readonly failure: OfflineFailure };

export type EnqueueResult<P> =
  | { readonly ok: true; readonly queue: readonly OfflineItem<P>[] }
  | { readonly ok: false; readonly reason: "queue_full" };

export function enqueue<P>(
  queue: readonly OfflineItem<P>[],
  item: { id: string; kind: "feedback"; payload: P } & OfflineIdentity,
  now: number,
): EnqueueResult<P> {
  if (queue.some((queued) => queued.id === item.id)) return { ok: true, queue };
  if (queue.filter((queued) => queued.state !== "failed").length >= OFFLINE_QUEUE_MAX_ITEMS)
    return { ok: false, reason: "queue_full" };
  return {
    ok: true,
    queue: [
      ...queue,
      {
        ...item,
        created_on_device_at: new Date(now).toISOString(),
        attempts: 0,
        next_attempt_at: now,
        state: "waiting",
        failure: null,
      },
    ],
  };
}

function sameIdentity(item: OfflineIdentity, identity: OfflineIdentity): boolean {
  return item.server === identity.server && item.user_id === identity.user_id;
}

export function expireOld<P>(queue: readonly OfflineItem<P>[], now: number): OfflineItem<P>[] {
  return queue.map((item) =>
    item.state !== "failed" &&
    now - Date.parse(item.created_on_device_at) > OFFLINE_QUEUE_MAX_AGE_MS
      ? { ...item, state: "failed", failure: "expired" }
      : item,
  );
}

export function due<P>(
  queue: readonly OfflineItem<P>[],
  at: OfflineIdentity & { readonly now: number },
): OfflineItem<P> | null {
  const ready = queue
    .filter(
      (item) =>
        item.state === "waiting" &&
        sameIdentity(item, at) &&
        item.next_attempt_at <= at.now &&
        at.now - Date.parse(item.created_on_device_at) <= OFFLINE_QUEUE_MAX_AGE_MS,
    )
    .sort(
      (a, b) =>
        a.next_attempt_at - b.next_attempt_at ||
        a.created_on_device_at.localeCompare(b.created_on_device_at),
    );
  return ready[0] ?? null;
}

export function classifyOutcome(
  response: { readonly status: number; readonly retry_after_seconds?: number | undefined } | null,
): OfflineOutcome {
  if (response === null) return { kind: "retry" };
  const { status } = response;
  if (status >= 200 && status < 300) return { kind: "delivered" };
  if (status === 429)
    return { kind: "wait", seconds: Math.max(1, response.retry_after_seconds ?? 60) };
  if (status === 401 || status === 403) return { kind: "sign_in" };
  if (status === 408 || status >= 500) return { kind: "retry" };
  if (status === 409) return { kind: "failed", failure: "conflict" };
  if (status === 413) return { kind: "failed", failure: "too_large" };
  return { kind: "failed", failure: "refused" };
}

export function retryDelayMs(attempts: number, jitter: number): number {
  const exponent = Math.max(0, attempts - 1);
  const base = Math.min(OFFLINE_RETRY_BASE_MS * 2 ** exponent, OFFLINE_RETRY_MAX_MS);
  const factor = 0.5 + 0.5 * Math.min(1, Math.max(0, jitter));
  return Math.round(base * factor);
}

export function applyOutcome<P>(
  queue: readonly OfflineItem<P>[],
  id: string,
  outcome: OfflineOutcome,
  now: number,
  jitter: number,
): OfflineItem<P>[] {
  if (outcome.kind === "delivered") return queue.filter((item) => item.id !== id);
  return queue.map((item) => {
    if (item.id !== id) return item;
    const attempts = item.attempts + 1;
    if (outcome.kind === "retry")
      return { ...item, attempts, next_attempt_at: now + retryDelayMs(attempts, jitter) };
    if (outcome.kind === "wait")
      return { ...item, attempts, next_attempt_at: now + outcome.seconds * 1000 };
    if (outcome.kind === "sign_in") return { ...item, attempts, state: "held_auth" };
    return { ...item, attempts, state: "failed", failure: outcome.failure };
  });
}

export function releaseAuthHeld<P>(
  queue: readonly OfflineItem<P>[],
  identity: OfflineIdentity,
  now: number,
): OfflineItem<P>[] {
  return queue.map((item) =>
    item.state === "held_auth" && sameIdentity(item, identity)
      ? { ...item, state: "waiting", next_attempt_at: now }
      : item,
  );
}

export function retryFailed<P>(
  queue: readonly OfflineItem<P>[],
  id: string,
  now: number,
): OfflineItem<P>[] {
  return queue.map((item) =>
    item.id === id && item.state === "failed" && item.failure !== "expired"
      ? { ...item, state: "waiting", failure: null, next_attempt_at: now }
      : item,
  );
}

export function discard<P>(queue: readonly OfflineItem<P>[], id: string): OfflineItem<P>[] {
  return queue.filter((item) => item.id !== id);
}

export interface OfflineQueueSummary {
  readonly waiting: number;
  readonly held_auth: number;
  readonly failed: number;
  readonly next_attempt_at: number | null;
}

export function summarize<P>(
  queue: readonly OfflineItem<P>[],
  identity: OfflineIdentity,
): OfflineQueueSummary {
  const mine = queue.filter((item) => sameIdentity(item, identity));
  const waiting = mine.filter((item) => item.state === "waiting");
  return {
    waiting: waiting.length,
    held_auth: mine.filter((item) => item.state === "held_auth").length,
    failed: mine.filter((item) => item.state === "failed").length,
    next_attempt_at: waiting.length
      ? Math.min(...waiting.map((item) => item.next_attempt_at))
      : null,
  };
}
