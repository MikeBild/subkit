// P-GC5: per-channel circuit breaker for notification delivery.
//
// State machine (closed → open → half_open → closed):
//
//   closed    — deliveries pass. Each failure increments
//               `consecutive_failures`. When it reaches 10 the breaker
//               transitions to `open` with `circuit_open_until =
//               now + 5 min`.
//   open      — deliveries are skipped with `reason: breaker_open` until
//               `circuit_open_until`. After that the next call returns
//               `canPass=true` and puts the breaker in `half_open`
//               (tracked in memory only — DB still shows `open` until
//               the next success/failure).
//   half_open — one probe is in flight. A success closes the breaker
//               and clears counters. A failure re-opens for another
//               5 min and bumps `consecutive_failures`.
//
// State is persisted to the `notification_channels` row so a restart
// preserves cool-down timing. An in-memory `phase` map tracks the
// ephemeral `half_open` transition.

import { eq } from "drizzle-orm";

import type { Db } from "../db/client.ts";
import { type NotificationChannelRow, notificationChannels } from "../db/schema/notifications.ts";

export const FAILURE_THRESHOLD = 10;
export const OPEN_DURATION_MS = 5 * 60_000;

export type CircuitPhase = "closed" | "open" | "half_open";

const phaseByChannel: Map<string, CircuitPhase> = new Map();

export function getPhase(channelId: string): CircuitPhase {
  return phaseByChannel.get(channelId) ?? "closed";
}

function setPhase(channelId: string, phase: CircuitPhase): void {
  if (phase === "closed") {
    phaseByChannel.delete(channelId);
  } else {
    phaseByChannel.set(channelId, phase);
  }
}

/**
 * Decide whether a delivery attempt may proceed. Pure-read except for
 * the in-memory phase flip `open → half_open`. DB state is not
 * mutated here; callers invoke `onSuccess` / `onFailure` after the
 * actual delivery completes.
 */
export function canPass(
  channel: Pick<
    NotificationChannelRow,
    "id" | "circuit_state" | "circuit_open_until" | "consecutive_failures"
  >,
  now: number = Date.now(),
): { allowed: boolean; phase: CircuitPhase } {
  const openUntil = channel.circuit_open_until?.getTime?.() ?? 0;
  const stored = (channel.circuit_state ?? "closed") as CircuitPhase;
  const ephemeral = phaseByChannel.get(channel.id);

  if (ephemeral === "half_open") {
    return { allowed: true, phase: "half_open" };
  }

  if (stored === "open" || openUntil > now) {
    if (openUntil > now) {
      return { allowed: false, phase: "open" };
    }
    // Cool-down expired → flip to half_open and let one probe through.
    setPhase(channel.id, "half_open");
    return { allowed: true, phase: "half_open" };
  }

  return { allowed: true, phase: "closed" };
}

/**
 * Record a successful delivery. Closes the breaker, resets the
 * counters, and persists the cleared state to the DB row.
 */
export async function onSuccess(db: Db, channelId: string): Promise<void> {
  setPhase(channelId, "closed");
  await db
    .update(notificationChannels)
    .set({
      circuit_state: "closed",
      circuit_open_until: null,
      consecutive_failures: 0,
      updated_at: new Date(),
    })
    .where(eq(notificationChannels.id, channelId));
}

/**
 * Record a failed delivery. Increments the counter, opens the breaker
 * once the threshold is reached (or if this was a half-open probe),
 * and persists the updated state to the DB row.
 */
export async function onFailure(
  db: Db,
  channel: Pick<NotificationChannelRow, "id" | "consecutive_failures">,
  now: number = Date.now(),
): Promise<{ phase: CircuitPhase; consecutive_failures: number }> {
  const ephemeral = phaseByChannel.get(channel.id);
  const wasHalfOpen = ephemeral === "half_open";
  const nextFailures = (channel.consecutive_failures ?? 0) + 1;
  const shouldOpen = wasHalfOpen || nextFailures >= FAILURE_THRESHOLD;
  const nextState: CircuitPhase = shouldOpen ? "open" : "closed";
  const openUntil = shouldOpen ? new Date(now + OPEN_DURATION_MS) : null;

  setPhase(channel.id, shouldOpen ? "open" : "closed");

  await db
    .update(notificationChannels)
    .set({
      circuit_state: nextState,
      circuit_open_until: openUntil,
      consecutive_failures: nextFailures,
      updated_at: new Date(),
    })
    .where(eq(notificationChannels.id, channel.id));

  return { phase: nextState, consecutive_failures: nextFailures };
}

/** Test-only helper. */
export function __resetBreakers(): void {
  phaseByChannel.clear();
}
