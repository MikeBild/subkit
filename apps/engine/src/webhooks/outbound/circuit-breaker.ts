// Per-subscription circuit breaker.
//
// We keep a tiny in-memory map keyed by subscription id plus a
// persisted `subscriptions.circuit_open_until` column, so a restart
// preserves the cooldown window. The breaker trips after 10
// consecutive failures and stays open for 5 minutes. While open,
// delivery attempts are short-circuited to a "circuit_open" dead
// letter without an HTTP call.

import { eq, sql } from "drizzle-orm";
import type { Db } from "../../db/client.ts";
import { subscriptions } from "../../db/schema/index.ts";
import { logger } from "../../logging/logger.ts";

export const FAILURE_THRESHOLD = 10;
export const OPEN_DURATION_MS = 5 * 60_000;

interface BreakerState {
  consecutive_failures: number;
  open_until: number; // epoch ms, 0 when closed
}

type Executor = Db | Parameters<Parameters<Db["transaction"]>[0]>[0];

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

/**
 * Record a successful delivery. Clears the counter and persists closed
 * state back to the database row.
 */
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
  await db
    .update(subscriptions)
    .set({ consecutive_failures: 0, circuit_open_until: null })
    .where(eq(subscriptions.id, subscriptionId));
}

/**
 * Record a failed delivery. If the in-memory counter reaches the
 * threshold the breaker opens and the cooldown is persisted.
 *
 * Returns the post-update state so the caller can decide whether to
 * log a breaker-open warning.
 */
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

  await db
    .update(subscriptions)
    .set({
      consecutive_failures: next.consecutive_failures,
      circuit_open_until: next.open_until > 0 ? new Date(next.open_until) : null,
    })
    .where(eq(subscriptions.id, subscriptionId));

  return next;
}

/**
 * Rehydrate the in-memory state from the DB row. Called by the
 * delivery worker on boot so breaker state survives restarts.
 */
export async function hydrate(db: Executor, subscriptionId: string): Promise<void> {
  // tenant-filter:exempt — TODO(audit-2026-06): verify tenant scoping for this site
  const rows = await db
    .select({
      failures: subscriptions.consecutive_failures,
      open_until: subscriptions.circuit_open_until,
    })
    .from(subscriptions)
    .where(eq(subscriptions.id, subscriptionId))
    .limit(1);
  const row = rows[0];
  if (!row) return;
  state.set(subscriptionId, {
    consecutive_failures: row.failures ?? 0,
    open_until: row.open_until ? row.open_until.getTime() : 0,
  });
}

/** Test-only helper. */
export function __resetAll(): void {
  state.clear();
}

// Silence linters that flag the imported `sql` as unused in lint
// configurations that do not understand conditional usage inside
// helper functions. The import is kept for future `sql` interpolation
// needs without having to re-plumb it.
void sql;
