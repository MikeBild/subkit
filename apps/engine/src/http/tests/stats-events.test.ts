// Integration tests for GET /v1/stats/events — verifies each `?class=`
// aggregates exactly the correct `audit_log.action` set as defined in
// event-classes.ts. Actions are seeded explicitly; the query must
// return exactly the seeded count for each class and zero for all others.

import { afterAll, beforeAll, describe, expect, test } from "bun:test";
import { AuditAction } from "../../audit/types.ts";
import { auditLog } from "../../db/schema/index.ts";
import { createDeterministicUuidFactory } from "../../test-helpers/determinism/ids.ts";
import { EVENT_CLASS_ACTIONS, type EventClass } from "../routes/stats/event-classes.ts";
import { createHttpTestServer, type HttpTestServer } from "./setup.ts";

const uuid = createDeterministicUuidFactory(0x03);

let srv: HttpTestServer;

const FROM = "2026-01-15T00:00:00.000Z";
const TO = "2026-01-15T23:59:59.999Z";
const WIN = `bucket=hour&from=${encodeURIComponent(FROM)}&to=${encodeURIComponent(TO)}`;

// We seed exactly 1 row per action in each event class. Since some classes
// share actions across different event types (they don't — each action appears
// in exactly one class), counts will be deterministic.
//
// Map: class → count of seeded rows.
const SEEDED_COUNTS: Record<EventClass, number> = {
  webhook_outbound: 3, // delivered + failed + replayed (one each)
  webhook_inbound: 2, // received + denied
  chat: 3, // received + sent + denied
  notification: 1, // tested
  schedule: 3, // fired + bound + unbound
  self_healing: 4, // proposed + approved + rejected + auto_applied
  discovery: 4, // proposed + approved + rejected + superseded
  execution_lifecycle: 2, // auto_retried + crash_recovered
  policy: 5, // denied + changed + tool_policy_confirmation_required + tool_policy_changed + connector_draft_credential_rejected
  external_write: 1,
};

beforeAll(async () => {
  srv = await createHttpTestServer("stats-events");
  const db = srv.db;

  const baseTs = new Date("2026-01-15T08:00:00.000Z");
  let offset = 0;

  // Helper to build an audit row.
  function row(action: string): typeof auditLog.$inferInsert {
    const r = {
      id: uuid(),
      ts: new Date(baseTs.getTime() + offset * 1000),
      tenant_id: srv.tenantId,
      actor_type: "system" as const,
      action,
      resource_type: "test",
      result: "success" as const,
      metadata: {},
    };
    offset += 1;
    return r;
  }

  const rows: (typeof auditLog.$inferInsert)[] = [];

  // webhook_outbound
  rows.push(row(AuditAction.WEBHOOK_OUTBOUND_DELIVERED));
  rows.push(row(AuditAction.WEBHOOK_OUTBOUND_FAILED));
  rows.push(row(AuditAction.WEBHOOK_OUTBOUND_REPLAYED));

  // webhook_inbound
  rows.push(row(AuditAction.WEBHOOK_INBOUND_RECEIVED));
  rows.push(row(AuditAction.WEBHOOK_INBOUND_DENIED));

  // chat
  rows.push(row(AuditAction.CHAT_MESSAGE_RECEIVED));
  rows.push(row(AuditAction.CHAT_MESSAGE_SENT));
  rows.push(row(AuditAction.CHAT_MESSAGE_DENIED));

  // notification
  rows.push(row(AuditAction.NOTIFICATION_RULE_TESTED));

  // schedule
  rows.push(row(AuditAction.SCHEDULE_TRIGGER_FIRED));
  rows.push(row(AuditAction.SCHEDULE_TRIGGER_BOUND));
  rows.push(row(AuditAction.SCHEDULE_TRIGGER_UNBOUND));

  // self_healing
  rows.push(row(AuditAction.PATCH_CANDIDATE_PROPOSED));
  rows.push(row(AuditAction.PATCH_CANDIDATE_APPROVED));
  rows.push(row(AuditAction.PATCH_CANDIDATE_REJECTED));
  rows.push(row(AuditAction.PATCH_CANDIDATE_AUTO_APPLIED));

  // discovery
  rows.push(row(AuditAction.SKILL_CANDIDATE_PROPOSED));
  rows.push(row(AuditAction.SKILL_CANDIDATE_APPROVED));
  rows.push(row(AuditAction.SKILL_CANDIDATE_REJECTED));
  rows.push(row(AuditAction.SKILL_CANDIDATE_SUPERSEDED));

  // execution_lifecycle
  rows.push(row(AuditAction.EXECUTION_AUTO_RETRIED));
  rows.push(row(AuditAction.EXECUTION_CRASH_RECOVERED));

  // policy
  rows.push(row(AuditAction.POLICY_DENIED));
  rows.push(row(AuditAction.POLICY_CHANGED));
  rows.push(row(AuditAction.TOOL_POLICY_CONFIRMATION_REQUIRED));
  rows.push(row(AuditAction.TOOL_POLICY_CHANGED));
  rows.push(row(AuditAction.CONNECTOR_DRAFT_CREDENTIAL_REJECTED));

  // external_write
  rows.push(row(AuditAction.EXTERNAL_WRITE));

  await db.insert(auditLog).values(rows);
});

afterAll(async () => {
  await srv.cleanup();
});

function authedFetch(path: string): Promise<Response> {
  return fetch(`${srv.baseUrl}${path}`, {
    headers: { authorization: `Bearer ${srv.apiKey}` },
  });
}

// Test each event class in a parameterised loop.
const classes = Object.keys(SEEDED_COUNTS) as EventClass[];

for (const cls of classes) {
  describe(`events class=${cls}`, () => {
    test(`?class=${cls} returns ${SEEDED_COUNTS[cls]} calls`, async () => {
      const res = await authedFetch(`/v1/stats/events?${WIN}&class=${cls}`);
      expect(res.status).toBe(200);
      const body = (await res.json()) as {
        totals: { calls: { total: number } };
      };
      expect(body.totals.calls.total).toBe(SEEDED_COUNTS[cls]);
    });

    test(`?class=${cls} groups default to action axis`, async () => {
      const res = await authedFetch(`/v1/stats/events?${WIN}&class=${cls}`);
      const body = (await res.json()) as {
        groups: Array<{ key: Record<string, string> }>;
      };
      // Default group_by=action: each group key should contain the 'action' dim.
      const expectedActions = EVENT_CLASS_ACTIONS[cls];
      for (const g of body.groups) {
        const action = g.key.action ?? "";
        expect(typeof action).toBe("string");
        expect(expectedActions).toContain(action);
      }
    });

    test(`?class=${cls} group count = number of distinct actions seeded for class`, async () => {
      const res = await authedFetch(`/v1/stats/events?${WIN}&class=${cls}`);
      const body = (await res.json()) as {
        groups: Array<{ totals: { calls: { total: number } } }>;
      };
      // Each action has exactly 1 row; number of groups = number of actions
      // (assuming no two seeded rows share both class and action in different positions).
      expect(body.groups.length).toBe(SEEDED_COUNTS[cls]);
    });
  });
}

// Cross-class contamination: querying 'schedule' must NOT return policy rows.
test("schedule class does not include policy.denied rows", async () => {
  const res = await authedFetch(`/v1/stats/events?${WIN}&class=schedule`);
  const body = (await res.json()) as {
    groups: Array<{ key: Record<string, string> }>;
  };
  const actions = body.groups.map((g) => g.key.action);
  expect(actions).not.toContain("policy.denied");
  expect(actions).not.toContain("policy.changed");
});

// Outcome filter: seed an error row for the policy class and verify outcome=error filter works.
test("outcome=error filter narrows results within a class", async () => {
  // Seed a policy row with result='error' at a later timestamp.
  await srv.db.insert(auditLog).values({
    id: uuid(),
    ts: new Date("2026-01-15T20:00:00.000Z"),
    tenant_id: srv.tenantId,
    actor_type: "system",
    action: AuditAction.POLICY_DENIED,
    resource_type: "test",
    result: "error",
    metadata: {},
  });

  const allRes = await authedFetch(`/v1/stats/events?${WIN}&class=policy`);
  const filteredRes = await authedFetch(`/v1/stats/events?${WIN}&class=policy&outcome=error`);

  const allBody = (await allRes.json()) as { totals: { calls: { total: number } } };
  const filteredBody = (await filteredRes.json()) as { totals: { calls: { total: number } } };

  // The filtered count must be less than or equal to the total (strictly
  // less because we have success rows too).
  expect(filteredBody.totals.calls.total).toBeLessThan(allBody.totals.calls.total);
  expect(filteredBody.totals.calls.total).toBe(1);
});
