// Tenant-isolation guarantee for inbound webhook triggers.
//
// The slug → workflow lookup runs on a single shared `webhooks_inbound`
// table; the contract is that a slug owned by tenant A cannot route an
// execution against a workflow owned by tenant B even if the two
// workflow rows share an id (they don't, but the test doesn't lean on
// that). Concretely: tenant B's slug is bound to tenant B's workflow,
// and an inbound POST arriving at that slug must only ever enqueue
// against tenant B's workflow + tenant. The cross-tenant attack
// surface is "tenant A guesses tenant B's slug and signs a payload
// with an unrelated secret".

import { afterAll, beforeAll, describe, expect, test } from "bun:test";
import { createHmac } from "node:crypto";
import { eq } from "drizzle-orm";
import type { PgBoss } from "pg-boss";
import { executions, tenants, workflows, workflowVersions } from "../../../db/schema/index.ts";
import { createTestDb, type TestDb } from "../../../db/tests/setup.ts";
import { createBoss, disposeBoss } from "../../../queue/boss.ts";
import { grantScheduleAuthorityFixture } from "../../../scheduler/tests/authority-fixture.ts";
import { bindFromWorkflow, handleInbound, rotateInboundSecret } from "../service.ts";

let testDb: TestDb;
let boss: PgBoss;
let tenantA: string;
let tenantB: string;
let workflowA: string;
let workflowB: string;
let inboundA: string;
let inboundB: string;

const SECRET_A = "whsec_tenant_a_isolation_aaaaaaaaaaaaaaaa";
const SECRET_B = "whsec_tenant_b_isolation_bbbbbbbbbbbbbbbb";

function signStripe(secret: string, ts: number, body: string): string {
  const v1 = createHmac("sha256", secret).update(`${ts}.${body}`, "utf8").digest("hex");
  return `t=${ts},v1=${v1}`;
}

beforeAll(async () => {
  testDb = await createTestDb("wh-tenant-isolation");
  boss = await createBoss({ connectionString: testDb.url });

  // Two independent tenants, each with their own workflow + trigger
  // binding. Slug names are deliberately distinct so we can also
  // simulate "tenant A guesses tenant B's slug".
  for (const label of ["a", "b"] as const) {
    const [tenant] = await testDb.db
      .insert(tenants)
      .values({ slug: `tenant-${label}`, display_name: `Tenant ${label.toUpperCase()}` })
      .returning();
    if (!tenant) throw new Error(`tenant seed failed: ${label}`);
    const [wf] = await testDb.db
      .insert(workflows)
      .values({
        tenant_id: tenant.id,
        slug: `wf-${label}`,
        name: `wf-${label}`,
        lifecycle: "active",
      })
      .returning();
    if (!wf) throw new Error(`workflow seed failed: ${label}`);
    const [version] = await testDb.db
      .insert(workflowVersions)
      .values({
        tenant_id: tenant.id,
        workflow_id: wf.id,
        version: 1,
        dag: {
          name: `wf-${label}`,
          version: 1,
          steps: [{ id: "noop", kind: "transform", expression: "$" }],
        },
      })
      .returning();
    if (!version) throw new Error(`version seed failed: ${label}`);
    await testDb.db
      .update(workflows)
      .set({ current_version_id: version.id })
      .where(eq(workflows.id, wf.id));
    await grantScheduleAuthorityFixture(testDb.db, tenant.id, wf.id);
    if (label === "a") {
      tenantA = tenant.id;
      workflowA = wf.id;
    } else {
      tenantB = tenant.id;
      workflowB = wf.id;
    }
  }

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
    // Sign with tenant A's secret but POST against tenant B's slug.
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

    // No execution row was created for either tenant.
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

    // Tenant A still has zero executions.
    const execRowsA = await testDb.db
      .select()
      .from(executions)
      .where(eq(executions.tenant_id, tenantA));
    expect(execRowsA.length).toBe(0);
  });
});
