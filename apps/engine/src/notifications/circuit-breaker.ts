import { eq } from "drizzle-orm";
import type { Db } from "../db/client.ts";
import { type NotificationChannelRow, notificationChannels } from "../db/schema/notifications.ts";

export const FAILURE_THRESHOLD = 10;
export const OPEN_DURATION_MS = 5 * 60_000;

type CircuitPhase = "closed" | "open" | "half_open";

const phaseByChannel: Map<string, CircuitPhase> = new Map();

function setPhase(channelId: string, phase: CircuitPhase): void {
  if (phase === "closed") {
    phaseByChannel.delete(channelId);
  } else {
    phaseByChannel.set(channelId, phase);
  }
}

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
    setPhase(channel.id, "half_open");
    return { allowed: true, phase: "half_open" };
  }

  return { allowed: true, phase: "closed" };
}

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

export function __resetBreakers(): void {
  phaseByChannel.clear();
}
