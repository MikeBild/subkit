import { isAuthorityRefusalCode } from "@shared/authority-refusal.ts";

export const HELD_DELIVERY_STATES = [
  "held",
  "replaying",
  "replayed",
  "expired",
  "replay_failed",
] as const;

export type HeldDeliveryState = (typeof HELD_DELIVERY_STATES)[number];

export const OPEN_HELD_DELIVERY_STATES = [
  "held",
  "replaying",
] as const satisfies readonly HeldDeliveryState[];

export type HeldDeliveryEvent =
  | { kind: "claimed" }
  | { kind: "enqueued" }
  | { kind: "enqueue_failed" }
  | { kind: "lease_elapsed" }
  | { kind: "refused"; code: string }
  | { kind: "ttl_elapsed"; execution_recorded: boolean };

export const HELD_DELIVERY_LIMITS = {
  per_hook: 100,
  max_body_bytes: 1_048_576,
  max_delivery_id_length: 512,
  ttl_hours: 168,
  replay_batch: 25,
  claim_lease_seconds: 300,
} as const;

export const HOLDABLE_REFUSAL = "execution_authority_required";

export type HeldArrivalDecision =
  | "store"
  | "duplicate"
  | "mismatch"
  | "settled"
  | "too_large"
  | "over_capacity";

export function isHoldableRefusal(code: string, signed: boolean): boolean {
  return signed && code === HOLDABLE_REFUSAL;
}

export function decideHeldArrival(
  facts: {
    existing_state: HeldDeliveryState | null;
    same_event: boolean;
    body_bytes: number;
    held_count: number;
    delivery_id_length: number;
  },
  limits: {
    per_hook: number;
    max_body_bytes: number;
    max_delivery_id_length: number;
  } = HELD_DELIVERY_LIMITS,
): HeldArrivalDecision {
  if (facts.existing_state) {
    if (!(OPEN_HELD_DELIVERY_STATES as readonly string[]).includes(facts.existing_state))
      return "settled";
    return facts.same_event ? "duplicate" : "mismatch";
  }
  if (
    facts.body_bytes > limits.max_body_bytes ||
    facts.delivery_id_length > limits.max_delivery_id_length
  )
    return "too_large";
  if (facts.held_count >= limits.per_hook) return "over_capacity";
  return "store";
}

export function nextHeldDeliveryState(
  state: HeldDeliveryState,
  event: HeldDeliveryEvent,
): HeldDeliveryState | null {
  if (state === "replaying") {
    if (event.kind === "enqueued") return "replayed";
    return event.kind === "enqueue_failed" || event.kind === "lease_elapsed" ? "held" : null;
  }
  if (state !== "held") return null;
  if (event.kind === "claimed") return "replaying";
  if (event.kind === "ttl_elapsed") return event.execution_recorded ? null : "expired";
  if (event.kind !== "refused") return null;
  return isAuthorityRefusalCode(event.code) ? null : "replay_failed";
}

export type RecordedExecutionDecision =
  | { action: "enqueue" }
  | { action: "settle" }
  | { action: "fail"; code: "execution_missing" | "execution_aborted" };

export function decideRecordedExecution(status: string | null): RecordedExecutionDecision {
  if (status === null) return { action: "fail", code: "execution_missing" };
  if (status === "queued") return { action: "enqueue" };
  if (status === "aborted") return { action: "fail", code: "execution_aborted" };
  return { action: "settle" };
}
