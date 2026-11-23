import { expect, test } from "bun:test";
import { interactionLog, type PatchAuditFact } from "./interaction-log.ts";

const USER = "10000000-0000-4000-8000-000000000001";

function fact(minute: number, patch: Partial<PatchAuditFact>): PatchAuditFact {
  return {
    ts: new Date(Date.UTC(2026, 10, 23, 9, minute)),
    action: "patch_candidate.dry_run_requested",
    result: "success",
    actor_type: "user",
    actor_id: USER,
    reason: null,
    metadata: {},
    ...patch,
  };
}

test("tested, accepted partly and declined come back in time order with their indices", () => {
  const log = interactionLog([
    fact(3, { action: "patch_candidate.rejected", reason: "wrong field" }),
    fact(2, {
      action: "patch_candidate.approved",
      metadata: { accepted_operations: [0], declined_operations: [1], operation_count: 2 },
    }),
    fact(1, { metadata: { ok: true, accepted_operations: [0], operation_count: 2 } }),
    fact(0, { metadata: { ok: false, accepted_operations: null, operation_count: 2 } }),
  ]);
  expect(log).toEqual([
    {
      at: "2026-11-23T09:00:00.000Z",
      event: "tested",
      actor_type: "user",
      actor_id: USER,
      ok: false,
      accepted_operations: null,
      declined_operations: null,
      reason: null,
    },
    {
      at: "2026-11-23T09:01:00.000Z",
      event: "tested",
      actor_type: "user",
      actor_id: USER,
      ok: true,
      accepted_operations: [0],
      declined_operations: null,
      reason: null,
    },
    {
      at: "2026-11-23T09:02:00.000Z",
      event: "accepted_partly",
      actor_type: "user",
      actor_id: USER,
      ok: null,
      accepted_operations: [0],
      declined_operations: [1],
      reason: null,
    },
    {
      at: "2026-11-23T09:03:00.000Z",
      event: "declined",
      actor_type: "user",
      actor_id: USER,
      ok: null,
      accepted_operations: null,
      declined_operations: null,
      reason: "wrong field",
    },
  ]);
});

test("a whole approval is accepted; refused attempts and other actions are left out", () => {
  const log = interactionLog([
    fact(0, { action: "patch_candidate.approved", metadata: { accepted_operations: null } }),
    fact(1, { action: "patch_candidate.approved", result: "error", reason: "review_changed" }),
    fact(2, { action: "patch_candidate.prepared" }),
    fact(3, { action: "patch_candidate.approved", metadata: { accepted_operations: ["0"] } }),
    fact(4, { action: "patch_candidate.approved", metadata: null }),
  ]);
  expect(log.map((entry) => [entry.event, entry.accepted_operations])).toEqual([
    ["accepted", null],
    ["accepted", null],
    ["accepted", null],
  ]);
});
