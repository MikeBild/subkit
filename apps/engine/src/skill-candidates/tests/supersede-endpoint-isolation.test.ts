import { afterAll, afterEach, beforeAll, describe, expect, test } from "bun:test";
import { createHash } from "node:crypto";
import { connectors } from "../../db/schema/connectors.ts";
import { executionFixtures, patchCandidates } from "../../db/schema/executions.ts";
import { tenants } from "../../db/schema/identity.ts";
import { skillCandidates } from "../../db/schema/skills.ts";
import { workflows } from "../../db/schema/workflows.ts";
import { createTestDb, type TestDb } from "../../db/tests/setup.ts";
import { runPatternAnalysis } from "../service.ts";

const skip = process.env.REQUIRES_PG === "0";

let testDb: TestDb;
let tenantId: string;
let connectorId: string;
const workflowIds: string[] = [];

// allow-wall-clock: anchor for patch created_at — detector uses now() with no override
const RECENT_TS = new Date(Date.now() - 24 * 60 * 60 * 1000);

beforeAll(async () => {
  if (skip) return;

  testDb = await createTestDb("supersede-endpoint-iso");

  const [tenant] = await testDb.db
    .insert(tenants)
    .values({ slug: "sei-tenant", display_name: "SEI Tenant" })
    .returning();
  if (!tenant) throw new Error("seed tenant failed");
  tenantId = tenant.id;

  const [conn] = await testDb.db
    .insert(connectors)
    .values({
      tenant_id: tenantId,
      slug: "sei-api",
      display_name: "SEI API",
      driver: "http",
    })
    .returning();
  if (!conn) throw new Error("seed connector failed");
  connectorId = conn.id;

  for (let i = 0; i < 3; i++) {
    const [wf] = await testDb.db
      .insert(workflows)
      .values({
        tenant_id: tenantId,
        slug: `sei-wf-${i}`,
        name: `SEI Workflow ${i}`,
        lifecycle: "active",
      })
      .returning();
    if (!wf) throw new Error(`seed workflow ${i} failed`);
    workflowIds.push(wf.id);
  }
}, 60_000);

afterAll(async () => {
  if (!skip && testDb?.cleanup) await testDb.cleanup();
}, 30_000);

afterEach(async () => {
  if (skip) return;
  await testDb.db.delete(patchCandidates);
  await testDb.db.delete(executionFixtures);
  await testDb.db.delete(skillCandidates);
}, 30_000);

function realDiff(kind: string) {
  return {
    proposal: {
      classification: "safe",
      kind,
      description: `patch: ${kind}`,
      patch: { path: "/data/id", value: "/data/result/id" },
      reasoning: "observed drift",
    },
    drift_signal: {},
    dry_run: { ok: true, error: null, fixture_id: null, skipped: false },
    policy: {},
    step_id: "step-1",
    execution_id: "exec-1",
    source: "test",
  };
}

async function seedPatches(endpointKey: string): Promise<void> {
  for (let i = 0; i < 3; i++) {
    const [fix] = await testDb.db
      .insert(executionFixtures)
      .values({
        tenant_id: tenantId,
        connector_id: connectorId,
        endpoint_key: endpointKey,
        request: {},
        response: {},
      })
      .returning();
    if (!fix) throw new Error("seed fixture failed");

    await testDb.db.insert(patchCandidates).values({
      tenant_id: tenantId,
      workflow_id: workflowIds[i % workflowIds.length]!,
      diff: realDiff("update_field_path"),
      classification: "safe",
      fixture_id: fix.id,
      status: "applied",
      created_at: RECENT_TS,
      updated_at: RECENT_TS,
    });
  }
}

describe.skipIf(skip)("supersede endpoint isolation", () => {
  test("TWO ENDPOINTS: candidates for 'get_users' and 'create_orders' coexist as proposed", async () => {
    await seedPatches("get_users");
    await seedPatches("create_orders");

    const result = await runPatternAnalysis({ tenant_id: tenantId }, testDb.db);
    expect(result.candidates_proposed).toBe(2);

    const all = await testDb.db.select().from(skillCandidates);
    const proposed = all.filter((r) => r.tenant_id === tenantId && r.status === "proposed");
    expect(proposed).toHaveLength(2);

    const endpoints = proposed.map((r) => r.endpoint_key).sort();
    expect(endpoints).toContain("get_users");
    expect(endpoints).toContain("create_orders");

    const fingerprints = proposed.map((r) => r.fingerprint);
    expect(new Set(fingerprints).size).toBe(2);
  });

  test("DEDUP: same endpoint re-proposed with same fingerprint updates, not duplicates", async () => {
    await seedPatches("get_users");

    const r1 = await runPatternAnalysis({ tenant_id: tenantId }, testDb.db);
    expect(r1.candidates_proposed).toBe(1);

    const r2 = await runPatternAnalysis({ tenant_id: tenantId }, testDb.db);
    expect(r2.candidates_proposed).toBe(0);
    expect(r2.candidates_updated).toBe(1);

    const all = await testDb.db.select().from(skillCandidates);
    const forTenant = all.filter((r) => r.tenant_id === tenantId);
    expect(forTenant).toHaveLength(1);
    expect(forTenant[0]!.status).toBe("proposed");
  });

  test("DIFFERENT KIND ON SAME ENDPOINT COEXISTS (no cross-fingerprint supersede for repair)", async () => {
    await seedPatches("get_users");

    await runPatternAnalysis({ tenant_id: tenantId }, testDb.db);

    const allBefore = await testDb.db.select().from(skillCandidates);
    const beforeRow = allBefore.find((r) => r.tenant_id === tenantId)!;
    expect(beforeRow).toBeDefined();
    expect(beforeRow.status).toBe("proposed");
    const oldFingerprint = beforeRow.fingerprint;

    for (let i = 0; i < 3; i++) {
      const [fix] = await testDb.db
        .insert(executionFixtures)
        .values({
          tenant_id: tenantId,
          connector_id: connectorId,
          endpoint_key: "get_users",
          request: {},
          response: {},
        })
        .returning();
      if (!fix) throw new Error("seed fixture failed");

      await testDb.db.insert(patchCandidates).values({
        tenant_id: tenantId,
        workflow_id: workflowIds[i % workflowIds.length]!,
        diff: realDiff("rename_param"),
        classification: "safe",
        fixture_id: fix.id,
        status: "applied",
        created_at: RECENT_TS,
        updated_at: RECENT_TS,
      });
    }

    const r2 = await runPatternAnalysis({ tenant_id: tenantId }, testDb.db);

    expect(r2.candidates_proposed).toBeGreaterThanOrEqual(1);

    const expectedNewFp = createHash("sha256")
      .update(`repair:${connectorId}:get_users:rename_param`)
      .digest("hex")
      .slice(0, 32);

    const all = await testDb.db.select().from(skillCandidates);
    const forTenant = all.filter((r) => r.tenant_id === tenantId);

    const newCandidate = forTenant.find((r) => r.fingerprint === expectedNewFp);
    expect(newCandidate).toBeDefined();
    expect(newCandidate!.status).toBe("proposed");
    expect(newCandidate!.endpoint_key).toBe("get_users");

    const oldCandidate = forTenant.find((r) => r.fingerprint === oldFingerprint);
    expect(oldCandidate).toBeDefined();
    expect(oldCandidate!.status).toBe("proposed");
    const proposedRepair = forTenant.filter(
      (r) => r.pattern_kind === "repair_pattern" && r.status === "proposed",
    );
    expect(proposedRepair).toHaveLength(2);
  });

  test("CROSS-ENDPOINT NO INTERFERENCE: proposing endpoint B does not affect endpoint A's status", async () => {
    await seedPatches("get_users");
    const r1 = await runPatternAnalysis({ tenant_id: tenantId }, testDb.db);
    expect(r1.candidates_proposed).toBe(1);

    const all1 = await testDb.db.select().from(skillCandidates);
    const endpointARow = all1.find(
      (r) => r.tenant_id === tenantId && r.endpoint_key === "get_users",
    )!;
    expect(endpointARow.status).toBe("proposed");

    await seedPatches("list_orders");
    const r2 = await runPatternAnalysis({ tenant_id: tenantId }, testDb.db);
    expect(r2.candidates_proposed).toBe(1);

    const all2 = await testDb.db.select().from(skillCandidates);
    const endpointARowAfter = all2.find((r) => r.id === endpointARow.id)!;
    expect(endpointARowAfter.status).toBe("proposed");

    const endpointBRow = all2.find(
      (r) => r.tenant_id === tenantId && r.endpoint_key === "list_orders",
    )!;
    expect(endpointBRow.status).toBe("proposed");
  });
});
