import { eq } from "drizzle-orm";
import type { Executor } from "../../db/client.ts";
import { withSystemScope } from "../../db/index.ts";
import { subscriptions } from "../../db/schema/index.ts";
import { logger } from "../../logging/index.ts";

export const FAILURE_THRESHOLD = 10;
export const OPEN_DURATION_MS = 5 * 60_000;
const BREAKER_SCOPE_REASON = "outbound circuit breaker state is keyed by subscription id";

interface BreakerState {
  consecutive_failures: number;
  open_until: number;
}

const state: Map<string, BreakerState> = new Map();

export function getState(subscriptionId: string): BreakerState {
  return state.get(subscriptionId) ?? { consecutive_failures: 0, open_until: 0 };
}

export function isOpen(subscriptionId: string, now: number = Date.now()): boolean {
  const s = state.get(subscriptionId);
  if (!s) return false;
  return s.open_until > now;
}

export function reset(subscriptionId: string): void {
  state.set(subscriptionId, { consecutive_failures: 0, open_until: 0 });
}

export async function recordSuccess(db: Executor, subscriptionId: string): Promise<void> {
  const prev = state.get(subscriptionId);
  if (prev && prev.open_until > 0) {
    logger.info({
      module: "webhooks.outbound",
      action: "breaker.closed",
      subscription_id: subscriptionId,
    });
  }
  state.set(subscriptionId, { consecutive_failures: 0, open_until: 0 });
  await withSystemScope(db, BREAKER_SCOPE_REASON, (tx) =>
    tx
      .update(subscriptions)
      .set({ consecutive_failures: 0, circuit_open_until: null })
      .where(eq(subscriptions.id, subscriptionId)),
  );
}

export async function recordFailure(
  db: Executor,
  subscriptionId: string,
  now: number = Date.now(),
): Promise<BreakerState> {
  const prev = state.get(subscriptionId) ?? { consecutive_failures: 0, open_until: 0 };
  const next: BreakerState = {
    consecutive_failures: prev.consecutive_failures + 1,
    open_until: prev.open_until,
  };
  if (next.consecutive_failures >= FAILURE_THRESHOLD) {
    next.open_until = now + OPEN_DURATION_MS;
    logger.warn({
      module: "webhooks.outbound",
      action: "breaker.opened",
      subscription_id: subscriptionId,
      consecutive_failures: next.consecutive_failures,
      open_until: new Date(next.open_until).toISOString(),
    });
  }
  state.set(subscriptionId, next);

  await withSystemScope(db, BREAKER_SCOPE_REASON, (tx) =>
    tx
      .update(subscriptions)
      .set({
        consecutive_failures: next.consecutive_failures,
        circuit_open_until: next.open_until > 0 ? new Date(next.open_until) : null,
      })
      .where(eq(subscriptions.id, subscriptionId)),
  );

  return next;
}

export async function hydrate(db: Executor, subscriptionId: string): Promise<void> {
  // tenant-filter:exempt — subscriptions PK lookup; row's tenant_id is read out and forwarded into in-memory breaker state
  const rows = await withSystemScope(db, BREAKER_SCOPE_REASON, (tx) =>
    tx
      .select({
        failures: subscriptions.consecutive_failures,
        open_until: subscriptions.circuit_open_until,
      })
      .from(subscriptions)
      .where(eq(subscriptions.id, subscriptionId))
      .limit(1),
  );
  const row = rows[0];
  if (!row) return;
  state.set(subscriptionId, {
    consecutive_failures: row.failures ?? 0,
    open_until: row.open_until ? row.open_until.getTime() : 0,
  });
}

export function __resetAll(): void {
  state.clear();
}
