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

const SEEDED_COUNTS: Record<EventClass, number> = {
  webhook_outbound: 3,
  webhook_inbound: 2,
  chat: 3,
  notification: 1,
  schedule: 3,
  self_healing: 4,
  discovery: 4,
  execution_lifecycle: 1,
  policy: 4,
  external_write: 1,
};

beforeAll(async () => {
  srv = await createHttpTestServer("stats-events");
  const db = srv.db;

  const baseTs = new Date("2026-01-15T08:00:00.000Z");
  let offset = 0;

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

  rows.push(row(AuditAction.WEBHOOK_OUTBOUND_DELIVERED));
  rows.push(row(AuditAction.WEBHOOK_OUTBOUND_FAILED));
  rows.push(row(AuditAction.WEBHOOK_OUTBOUND_REPLAYED));

  rows.push(row(AuditAction.WEBHOOK_INBOUND_RECEIVED));
  rows.push(row(AuditAction.WEBHOOK_INBOUND_DENIED));

  rows.push(row(AuditAction.CHAT_MESSAGE_RECEIVED));
  rows.push(row(AuditAction.CHAT_MESSAGE_SENT));
  rows.push(row(AuditAction.CHAT_MESSAGE_DENIED));

  rows.push(row(AuditAction.NOTIFICATION_RULE_TESTED));

  rows.push(row(AuditAction.SCHEDULE_TRIGGER_FIRED));
  rows.push(row(AuditAction.SCHEDULE_TRIGGER_BOUND));
  rows.push(row(AuditAction.SCHEDULE_TRIGGER_UNBOUND));

  rows.push(row(AuditAction.PATCH_CANDIDATE_PROPOSED));
  rows.push(row(AuditAction.PATCH_CANDIDATE_APPROVED));
  rows.push(row(AuditAction.PATCH_CANDIDATE_REJECTED));
  rows.push(row(AuditAction.PATCH_CANDIDATE_AUTO_APPLIED));

  rows.push(row(AuditAction.SKILL_CANDIDATE_PROPOSED));
  rows.push(row(AuditAction.SKILL_CANDIDATE_APPROVED));
  rows.push(row(AuditAction.SKILL_CANDIDATE_REJECTED));
  rows.push(row(AuditAction.SKILL_CANDIDATE_SUPERSEDED));

  rows.push(row(AuditAction.EXECUTION_CRASH_RECOVERED));

  rows.push(row(AuditAction.POLICY_DENIED));
  rows.push(row(AuditAction.TOOL_POLICY_CONFIRMATION_REQUIRED));
  rows.push(row(AuditAction.TOOL_POLICY_CHANGED));
  rows.push(row(AuditAction.CONNECTOR_DRAFT_CREDENTIAL_REJECTED));

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
      expect(body.groups.length).toBe(SEEDED_COUNTS[cls]);
    });
  });
}

test("schedule class does not include policy.denied rows", async () => {
  const res = await authedFetch(`/v1/stats/events?${WIN}&class=schedule`);
  const body = (await res.json()) as {
    groups: Array<{ key: Record<string, string> }>;
  };
  const actions = body.groups.map((g) => g.key.action);
  expect(actions).not.toContain("policy.denied");
  expect(actions).not.toContain("tool_policy.changed");
});

test("outcome=error filter narrows results within a class", async () => {
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

  expect(filteredBody.totals.calls.total).toBeLessThan(allBody.totals.calls.total);
  expect(filteredBody.totals.calls.total).toBe(1);
});
