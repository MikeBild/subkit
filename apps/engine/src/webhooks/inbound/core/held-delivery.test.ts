import { describe, expect, test } from "bun:test";
import { EXECUTION_STATUSES, type ExecutionStatus } from "../../../execution/core/status.ts";
import {
  decideHeldArrival,
  decideRecordedExecution,
  HELD_DELIVERY_LIMITS,
  HELD_DELIVERY_STATES,
  type HeldArrivalDecision,
  type HeldDeliveryEvent,
  type HeldDeliveryState,
  isHoldableRefusal,
  nextHeldDeliveryState,
  OPEN_HELD_DELIVERY_STATES,
} from "./held-delivery.ts";

describe("held delivery state machine", () => {
  const transitions: Array<[HeldDeliveryState, HeldDeliveryEvent, HeldDeliveryState | null]> = [
    ["held", { kind: "claimed" }, "replaying"],
    ["held", { kind: "enqueued" }, null],
    ["held", { kind: "enqueue_failed" }, null],
    ["held", { kind: "lease_elapsed" }, null],
    ["replaying", { kind: "enqueued" }, "replayed"],
    ["replaying", { kind: "enqueue_failed" }, "held"],
    ["replaying", { kind: "lease_elapsed" }, "held"],
    ["replaying", { kind: "claimed" }, null],
    ["replaying", { kind: "ttl_elapsed", execution_recorded: false }, null],
    ["replaying", { kind: "refused", code: "input_schema_violation" }, null],
    ["held", { kind: "ttl_elapsed", execution_recorded: false }, "expired"],
    ["held", { kind: "ttl_elapsed", execution_recorded: true }, null],
    ["held", { kind: "refused", code: "execution_authority_required" }, null],
    ["held", { kind: "refused", code: "execution_authority_revoked" }, null],
    ["held", { kind: "refused", code: "execution_authority_expired" }, null],
    ["held", { kind: "refused", code: "input_schema_violation" }, "replay_failed"],
    ["held", { kind: "refused", code: "execution_boundary_mismatch" }, "replay_failed"],
    ["held", { kind: "refused", code: "workflow_inactive" }, "replay_failed"],
  ];
  test.each(transitions)("%s + %o -> %s", (state, event, next) => {
    expect(nextHeldDeliveryState(state, event)).toBe(next);
  });

  const settled = HELD_DELIVERY_STATES.filter(
    (state) => !(OPEN_HELD_DELIVERY_STATES as readonly string[]).includes(state),
  );
  const events: HeldDeliveryEvent[] = [
    { kind: "claimed" },
    { kind: "enqueued" },
    { kind: "enqueue_failed" },
    { kind: "lease_elapsed" },
    { kind: "ttl_elapsed", execution_recorded: false },
    { kind: "refused", code: "input_schema_violation" },
  ];
  test("only held and replaying deliveries are open", () => {
    expect(settled).toEqual(["replayed", "expired", "replay_failed"]);
  });
  test.each(settled)("a settled %s delivery never moves again", (state) => {
    for (const event of events) expect(nextHeldDeliveryState(state, event)).toBeNull();
  });
});

describe("held delivery arrival", () => {
  const limits = { per_hook: 2, max_body_bytes: 10, max_delivery_id_length: 4 } as const;
  const cases: Array<
    [
      {
        existing_state: HeldDeliveryState | null;
        same_event: boolean;
        body_bytes: number;
        held_count: number;
        delivery_id_length: number;
      },
      HeldArrivalDecision,
    ]
  > = [
    [
      {
        existing_state: null,
        same_event: true,
        body_bytes: 10,
        held_count: 1,
        delivery_id_length: 4,
      },
      "store",
    ],
    [
      {
        existing_state: null,
        same_event: true,
        body_bytes: 0,
        held_count: 0,
        delivery_id_length: 1,
      },
      "store",
    ],
    [
      {
        existing_state: null,
        same_event: true,
        body_bytes: 11,
        held_count: 0,
        delivery_id_length: 1,
      },
      "too_large",
    ],
    [
      {
        existing_state: null,
        same_event: true,
        body_bytes: 1,
        held_count: 0,
        delivery_id_length: 5,
      },
      "too_large",
    ],
    [
      {
        existing_state: null,
        same_event: true,
        body_bytes: 11,
        held_count: 2,
        delivery_id_length: 1,
      },
      "too_large",
    ],
    [
      {
        existing_state: null,
        same_event: true,
        body_bytes: 5,
        held_count: 2,
        delivery_id_length: 1,
      },
      "over_capacity",
    ],
    [
      {
        existing_state: null,
        same_event: true,
        body_bytes: 5,
        held_count: 3,
        delivery_id_length: 1,
      },
      "over_capacity",
    ],
    [
      {
        existing_state: "held",
        same_event: true,
        body_bytes: 5,
        held_count: 2,
        delivery_id_length: 1,
      },
      "duplicate",
    ],
    [
      {
        existing_state: "replaying",
        same_event: true,
        body_bytes: 11,
        held_count: 2,
        delivery_id_length: 5,
      },
      "duplicate",
    ],
    [
      {
        existing_state: "replayed",
        same_event: true,
        body_bytes: 5,
        held_count: 2,
        delivery_id_length: 1,
      },
      "settled",
    ],
    [
      {
        existing_state: "expired",
        same_event: true,
        body_bytes: 11,
        held_count: 3,
        delivery_id_length: 1,
      },
      "settled",
    ],
    [
      {
        existing_state: "replay_failed",
        same_event: true,
        body_bytes: 1,
        held_count: 0,
        delivery_id_length: 1,
      },
      "settled",
    ],
    [
      {
        existing_state: "held",
        same_event: false,
        body_bytes: 5,
        held_count: 0,
        delivery_id_length: 1,
      },
      "mismatch",
    ],
    [
      {
        existing_state: "replaying",
        same_event: false,
        body_bytes: 11,
        held_count: 2,
        delivery_id_length: 1,
      },
      "mismatch",
    ],
    [
      {
        existing_state: "replayed",
        same_event: false,
        body_bytes: 5,
        held_count: 0,
        delivery_id_length: 1,
      },
      "settled",
    ],
    [
      {
        existing_state: null,
        same_event: false,
        body_bytes: 5,
        held_count: 0,
        delivery_id_length: 1,
      },
      "store",
    ],
  ];
  test.each(cases)("%o -> %s", (facts, decision) => {
    expect(decideHeldArrival(facts, limits)).toBe(decision);
  });

  test("the default limits bound count and size", () => {
    expect(
      decideHeldArrival({
        existing_state: null,
        same_event: true,
        body_bytes: HELD_DELIVERY_LIMITS.max_body_bytes,
        held_count: 0,
        delivery_id_length: 36,
      }),
    ).toBe("store");
    expect(
      decideHeldArrival({
        existing_state: null,
        same_event: true,
        body_bytes: 1,
        held_count: HELD_DELIVERY_LIMITS.per_hook,
        delivery_id_length: 36,
      }),
    ).toBe("over_capacity");
  });
});

describe("holdable refusal", () => {
  const cases: Array<[string, boolean, boolean]> = [
    ["execution_authority_required", true, true],
    ["execution_authority_required", false, false],
    ["execution_authority_revoked", true, false],
    ["execution_authority_expired", true, false],
    ["input_schema_violation", true, false],
  ];
  test.each(cases)("%s signed=%s -> %s", (code, signed, holdable) => {
    expect(isHoldableRefusal(code, signed)).toBe(holdable);
  });
});

describe("recorded execution on a repeated replay", () => {
  const expected: Record<ExecutionStatus, ReturnType<typeof decideRecordedExecution>> = {
    queued: { action: "enqueue" },
    waiting_for_device: { action: "settle" },
    running: { action: "settle" },
    uncertain: { action: "settle" },
    succeeded: { action: "settle" },
    failed: { action: "settle" },
    timed_out: { action: "settle" },
    aborted: { action: "fail", code: "execution_aborted" },
  };
  test.each([...EXECUTION_STATUSES])("%s", (status) => {
    expect(decideRecordedExecution(status)).toEqual(expected[status]);
  });
  test("a vanished execution fails the delivery", () => {
    expect(decideRecordedExecution(null)).toEqual({ action: "fail", code: "execution_missing" });
  });
});
