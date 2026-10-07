import { afterAll, beforeAll, describe, expect, test } from "bun:test";
import { createHmac } from "node:crypto";
import { eq } from "drizzle-orm";
import type { PgBoss } from "pg-boss";
import { executions } from "../../../db/schema/index.ts";
import { createTestDb, type TestDb } from "../../../db/tests/setup.ts";
import { createBoss, disposeBoss } from "../../../queue/boss.ts";
import {
  bindFromWorkflow,
  handleInbound,
  inboundSlugCandidate,
  rotateInboundSecret,
  unbindFromWorkflow,
} from "../service.ts";
import { seedTenantWorkflow } from "./setup.ts";

let testDb: TestDb;
let boss: PgBoss;
let tenantA: string;
let tenantB: string;
let workflowA: string;
let workflowB: string;
let inboundA: string;
let inboundB: string;
let tenantC: string;
let tenantD: string;
let workflowC: string;
let workflowD: string;

const SECRET_A = "whsec_tenant_a_isolation_aaaaaaaaaaaaaaaa";
const SECRET_B = "whsec_tenant_b_isolation_bbbbbbbbbbbbbbbb";
const SECRET_C = "whsec_tenant_c_isolation_cccccccccccccccc";
const SECRET_D = "whsec_tenant_d_isolation_dddddddddddddddd";
const SHARED_WORKFLOW_SLUG = "webhook-to-slack";
const stripeTrigger = {
  kind: "webhook" as const,
  source: "stripe",
  events: [],
  verify: "stripe-signature" as const,
};

function signStripe(secret: string, ts: number, body: string): string {
  const v1 = createHmac("sha256", secret).update(`${ts}.${body}`, "utf8").digest("hex");
  return `t=${ts},v1=${v1}`;
}

beforeAll(async () => {
  testDb = await createTestDb("wh-tenant-isolation");
  boss = await createBoss({ connectionString: testDb.url });

  ({ tenantId: tenantA, workflowId: workflowA } = await seedTenantWorkflow(testDb.db, "a", "wf-a"));
  ({ tenantId: tenantB, workflowId: workflowB } = await seedTenantWorkflow(testDb.db, "b", "wf-b"));
  ({ tenantId: tenantC, workflowId: workflowC } = await seedTenantWorkflow(
    testDb.db,
    "c",
    SHARED_WORKFLOW_SLUG,
  ));
  ({ tenantId: tenantD, workflowId: workflowD } = await seedTenantWorkflow(
    testDb.db,
    "d",
    SHARED_WORKFLOW_SLUG,
  ));

  const boundA = await bindFromWorkflow(
    {
      tenant_id: tenantA,
      workflow_id: workflowA,
      workflow_slug: "wf-a",
      trigger: { kind: "webhook", source: "stripe", events: [], verify: "stripe-signature" },
      actor_id: null,
    },
    testDb.db,
  );
  inboundA = boundA.row.id;
  await rotateInboundSecret(tenantA, inboundA, SECRET_A, testDb.db);

  const boundB = await bindFromWorkflow(
    {
      tenant_id: tenantB,
      workflow_id: workflowB,
      workflow_slug: "wf-b",
      trigger: { kind: "webhook", source: "stripe", events: [], verify: "stripe-signature" },
      actor_id: null,
    },
    testDb.db,
  );
  inboundB = boundB.row.id;
  await rotateInboundSecret(tenantB, inboundB, SECRET_B, testDb.db);
});

afterAll(async () => {
  await disposeBoss(boss);
  await testDb.cleanup();
});

describe("inbound tenant isolation", () => {
  test("tenant A signing tenant B's slug with tenant A's secret is rejected", async () => {
    const body = JSON.stringify({
      id: "evt_cross_tenant_attack",
      type: "charge.failed",
      object: "event",
      created: 1709300000,
    });
    // allow-wall-clock: stripe signature window is real-time
    const ts = Math.floor(Date.now() / 1000);
    const badSig = signStripe(SECRET_A, ts, body);
    const outcome = await handleInbound(
      { db: testDb.db, boss },
      {
        slug: "wf-wf-b",
        rawBody: body,
        headers: { "stripe-signature": badSig },
      },
    );
    expect(outcome.status).toBe("denied");
    if (outcome.status !== "denied") throw new Error("expected denied");
    expect(outcome.reason).toBe("bad_signature");
    expect(outcome.inbound_id).toBe(inboundB);

    const execRowsB = await testDb.db
      .select()
      .from(executions)
      .where(eq(executions.tenant_id, tenantB));
    expect(execRowsB.length).toBe(0);
    const execRowsA = await testDb.db
      .select()
      .from(executions)
      .where(eq(executions.tenant_id, tenantA));
    expect(execRowsA.length).toBe(0);
  });

  test("tenant B's properly signed delivery enqueues against tenant B only", async () => {
    const body = JSON.stringify({
      id: "evt_tenantb_legit",
      type: "charge.failed",
      object: "event",
      created: 1709300100,
    });
    // allow-wall-clock: stripe signature window is real-time
    const ts = Math.floor(Date.now() / 1000);
    const sig = signStripe(SECRET_B, ts, body);
    const outcome = await handleInbound(
      { db: testDb.db, boss },
      {
        slug: "wf-wf-b",
        rawBody: body,
        headers: { "stripe-signature": sig },
      },
    );
    expect(outcome.status).toBe("ok");
    if (outcome.status !== "ok") throw new Error("expected ok");
    expect(outcome.inbound_id).toBe(inboundB);

    const rows = await testDb.db
      .select()
      .from(executions)
      .where(eq(executions.id, outcome.execution_id));
    expect(rows.length).toBe(1);
    const row = rows[0];
    expect(row?.tenant_id).toBe(tenantB);
    expect(row?.workflow_id).toBe(workflowB);

    const execRowsA = await testDb.db
      .select()
      .from(executions)
      .where(eq(executions.tenant_id, tenantA));
    expect(execRowsA.length).toBe(0);
  });
});

describe("two tenants binding a workflow with the same slug", () => {
  async function bindShared(tenant_id: string, workflow_id: string) {
    return await bindFromWorkflow(
      {
        tenant_id,
        workflow_id,
        workflow_slug: SHARED_WORKFLOW_SLUG,
        trigger: stripeTrigger,
        actor_id: null,
      },
      testDb.db,
    );
  }

  async function deliver(slug: string, secret: string, eventId: string) {
    const body = JSON.stringify({
      id: eventId,
      type: "charge.failed",
      object: "event",
      created: 1709300200,
    });
    // allow-wall-clock: stripe signature window is real-time
    const ts = Math.floor(Date.now() / 1000);
    return await handleInbound(
      { db: testDb.db, boss },
      { slug, rawBody: body, headers: { "stripe-signature": signStripe(secret, ts, body) } },
    );
  }

  async function executionOwner(executionId: string) {
    const [row] = await testDb.db
      .select({ tenant_id: executions.tenant_id, workflow_id: executions.workflow_id })
      .from(executions)
      .where(eq(executions.id, executionId));
    return row;
  }

  test("each tenant gets its own URL and each URL delivers only to its own tenant", async () => {
    const boundC = await bindShared(tenantC, workflowC);
    const boundD = await bindShared(tenantD, workflowD);
    expect(boundC.status).toBe("created");
    expect(boundD.status).toBe("created");
    expect(boundC.row.slug).toBe(`wf-${SHARED_WORKFLOW_SLUG}`);
    expect(boundD.row.slug).toBe(inboundSlugCandidate(`wf-${SHARED_WORKFLOW_SLUG}`, tenantD, 1));
    expect(boundD.row.slug).not.toBe(boundC.row.slug);
    expect(boundD.row.slug.length).toBeLessThanOrEqual(64);
    await rotateInboundSecret(tenantC, boundC.row.id, SECRET_C, testDb.db);
    await rotateInboundSecret(tenantD, boundD.row.id, SECRET_D, testDb.db);

    const toC = await deliver(boundC.row.slug, SECRET_C, "evt_shared_slug_c");
    if (toC.status !== "ok") throw new Error(`expected ok, got ${JSON.stringify(toC)}`);
    expect(toC.inbound_id).toBe(boundC.row.id);
    expect(await executionOwner(toC.execution_id)).toEqual({
      tenant_id: tenantC,
      workflow_id: workflowC,
    });

    const toD = await deliver(boundD.row.slug, SECRET_D, "evt_shared_slug_d");
    if (toD.status !== "ok") throw new Error(`expected ok, got ${JSON.stringify(toD)}`);
    expect(toD.inbound_id).toBe(boundD.row.id);
    expect(await executionOwner(toD.execution_id)).toEqual({
      tenant_id: tenantD,
      workflow_id: workflowD,
    });

    const crossed = await deliver(boundC.row.slug, SECRET_D, "evt_shared_slug_crossed");
    expect(crossed).toMatchObject({
      status: "denied",
      reason: "bad_signature",
      inbound_id: boundC.row.id,
    });
  });

  test("a re-save keeps the tenant's URL even after the plain slug is freed", async () => {
    const before = await bindShared(tenantD, workflowD);
    expect(before.status).toBe("noop");
    expect(await unbindFromWorkflow(tenantC, workflowC, null, testDb.db)).toBe(1);

    const after = await bindShared(tenantD, workflowD);
    expect(after.status).toBe("noop");
    expect(after.row.id).toBe(before.row.id);
    expect(after.row.slug).toBe(before.row.slug);
  });
});
