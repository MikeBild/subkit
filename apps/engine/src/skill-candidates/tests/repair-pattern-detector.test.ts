// Integration tests for detectRepairPatterns (the reworked repair-pattern
// detector). Requires a real Postgres database — set REQUIRES_PG=0 to skip.
//
// The detector:
//   • Inner-joins patch_candidates → execution_fixtures on fixture_id + tenant_id.
//   • Reads kind from diff.proposal.kind (rows without proposal are skipped).
//   • Groups by (connector_id, endpoint_key, kind); threshold >= 3 → one signal.
//   • Emitted signal: scope:"connector", connector_id set, no workflow_id,
//     fingerprint = sha256(`repair:<conn>:<ep>:<kind>`).slice(0,32).
//
// Note on clock usage: detectRepairPatterns calls Date.now() directly (it is
// not wired to the production clock seam). Tests therefore insert created_at
// values close to wall-clock time so rows fall inside the 30-day lookback
// window relative to the real Date.now() when the test runs.

import { afterAll, afterEach, beforeAll, describe, expect, test } from "bun:test";
import { createHash } from "node:crypto";
import { connectors } from "../../db/schema/connectors.ts";
import { executionFixtures, patchCandidates } from "../../db/schema/executions.ts";
import { tenants } from "../../db/schema/identity.ts";
import { workflows } from "../../db/schema/workflows.ts";
import { createTestDb, type TestDb } from "../../db/tests/setup.ts";
import { detectRepairPatterns } from "../detectors/repair-pattern.ts";

// A timestamp well within the 30-day lookback window (1 day ago relative to
// wall-clock time when the test file is loaded). The detector uses Date.now()
// directly, so we must stay anchored to real wall time.
// allow-wall-clock: anchor for patch created_at — the detector computes its
// own cutoff via Date.now(), so tests must stay within the real 30-day window.
const RECENT_TS = new Date(Date.now() - 24 * 60 * 60 * 1000); // 1 day ago

const skip = process.env.REQUIRES_PG === "0";

let testDb: TestDb;
let tenantId: string;
let otherTenantId: string;
let connectorId: string;

// Three distinct workflow ids (cross-workflow grouping tests).
const workflowIds: string[] = [];

beforeAll(async () => {
  if (skip) return;

  testDb = await createTestDb("repair-pattern-detector");

  const [tenant] = await testDb.db
    .insert(tenants)
    .values({ slug: "rpd-tenant", display_name: "RPD Tenant" })
    .returning();
  if (!tenant) throw new Error("seed tenant failed");
  tenantId = tenant.id;

  const [otherTenant] = await testDb.db
    .insert(tenants)
    .values({ slug: "rpd-other", display_name: "RPD Other" })
    .returning();
  if (!otherTenant) throw new Error("seed other tenant failed");
  otherTenantId = otherTenant.id;

  const [connector] = await testDb.db
    .insert(connectors)
    .values({
      tenant_id: tenantId,
      slug: "rpd-api",
      display_name: "RPD API",
      driver: "http",
    })
    .returning();
  if (!connector) throw new Error("seed connector failed");
  connectorId = connector.id;

  for (let i = 0; i < 3; i++) {
    const [wf] = await testDb.db
      .insert(workflows)
      .values({
        tenant_id: tenantId,
        slug: `rpd-wf-${i}`,
        name: `RPD Workflow ${i}`,
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
  // Clean up variable-per-test rows between tests (keep tenant/connector/workflows).
  await testDb.db.delete(patchCandidates);
  await testDb.db.delete(executionFixtures);
});

/** Seed one execution_fixture for the shared connector + endpoint. */
async function seedFixture(endpointKey: string): Promise<string> {
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
  return fix.id;
}

/** Real diff shape from self-healing/service.ts:537-557. */
function realDiff(kind: string, path?: string) {
  return {
    proposal: {
      classification: "safe",
      kind,
      description: `patch: ${kind}`,
      patch: path ? { path, value: "/data/result/customer_id" } : {},
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

// ---------------------------------------------------------------------------
// Tests
// ---------------------------------------------------------------------------

describe.skipIf(skip)("detectRepairPatterns", () => {
  test("THRESHOLD: 3 applied patches on same interface emit exactly 1 signal", async () => {
    const ep = "get_orders";
    for (let i = 0; i < 3; i++) {
      const fixId = await seedFixture(ep);
      await testDb.db.insert(patchCandidates).values({
        tenant_id: tenantId,
        workflow_id: workflowIds[i % workflowIds.length]!,
        diff: realDiff("update_field_path", "/data/customer_id"),
        classification: "safe",
        fixture_id: fixId,
        status: "applied",
        created_at: RECENT_TS,
        updated_at: RECENT_TS,
      });
    }

    const signals = await detectRepairPatterns(tenantId, testDb.db);
    expect(signals).toHaveLength(1);
    const s = signals[0]!;
    expect(s.scope).toBe("connector");
    expect(s.connector_id).toBe(connectorId);
    expect(s.workflow_id).toBeUndefined();
    expect(s.pattern_kind).toBe("repair_pattern");
    expect(s.evidence).toHaveLength(3);
  });

  test("CROSS-WORKFLOW: 3 patches on the same (connector, endpoint, kind) but 3 different workflows form ONE group", async () => {
    const ep = "list_items";
    const patchIds: string[] = [];

    for (let i = 0; i < 3; i++) {
      const fixId = await seedFixture(ep);
      const [pc] = await testDb.db
        .insert(patchCandidates)
        .values({
          tenant_id: tenantId,
          workflow_id: workflowIds[i]!,
          diff: realDiff("update_field_path", "/data/customer_id"),
          classification: "safe",
          fixture_id: fixId,
          status: "applied",
          created_at: RECENT_TS,
          updated_at: RECENT_TS,
        })
        .returning();
      if (!pc) throw new Error("seed patch candidate failed");
      patchIds.push(pc.id);
    }

    const signals = await detectRepairPatterns(tenantId, testDb.db);
    expect(signals).toHaveLength(1);

    const s = signals[0]!;
    expect(s.connector_id).toBe(connectorId);
    expect(s.workflow_id).toBeUndefined();
    // Evidence must reference each of the 3 patch candidate ids.
    const evidencePatchIds = s.evidence.map((e) => e.patch_candidate_id);
    for (const id of patchIds) {
      expect(evidencePatchIds).toContain(id);
    }
  });

  test("BELOW THRESHOLD: only 2 patches on an interface → 0 signals", async () => {
    const ep = "create_record";
    for (let i = 0; i < 2; i++) {
      const fixId = await seedFixture(ep);
      await testDb.db.insert(patchCandidates).values({
        tenant_id: tenantId,
        workflow_id: workflowIds[0]!,
        diff: realDiff("update_field_path", "/data/id"),
        classification: "safe",
        fixture_id: fixId,
        status: "applied",
        created_at: RECENT_TS,
        updated_at: RECENT_TS,
      });
    }

    const signals = await detectRepairPatterns(tenantId, testDb.db);
    expect(signals).toHaveLength(0);
  });

  test("NULL FIXTURE: patches with fixture_id=null are excluded (inner join drops them)", async () => {
    // Seed 3 patches with null fixture_id — they can never join to execution_fixtures.
    for (let i = 0; i < 3; i++) {
      await testDb.db.insert(patchCandidates).values({
        tenant_id: tenantId,
        workflow_id: workflowIds[i % workflowIds.length]!,
        diff: realDiff("update_field_path", "/data/customer_id"),
        classification: "safe",
        fixture_id: null,
        status: "applied",
        created_at: RECENT_TS,
        updated_at: RECENT_TS,
      });
    }

    const signals = await detectRepairPatterns(tenantId, testDb.db);
    expect(signals).toHaveLength(0);
  });

  test("MISSING PROPOSAL: rows with legacy/no proposal key do not contribute", async () => {
    const ep = "update_contact";
    // 2 valid patches + 1 legacy-shape patch (no proposal key) → below threshold.
    for (let i = 0; i < 2; i++) {
      const fixId = await seedFixture(ep);
      await testDb.db.insert(patchCandidates).values({
        tenant_id: tenantId,
        workflow_id: workflowIds[0]!,
        diff: realDiff("update_field_path", "/data/customer_id"),
        classification: "safe",
        fixture_id: fixId,
        status: "applied",
        created_at: RECENT_TS,
        updated_at: RECENT_TS,
      });
    }
    // Legacy shape — diff has no `proposal` key.
    const legacyFixId = await seedFixture(ep);
    await testDb.db.insert(patchCandidates).values({
      tenant_id: tenantId,
      workflow_id: workflowIds[1]!,
      diff: { kind: "update_field_path", path: "/data/customer_id" },
      classification: "safe",
      fixture_id: legacyFixId,
      status: "applied",
      created_at: RECENT_TS,
      updated_at: RECENT_TS,
    });

    // 2 valid + 1 legacy = 2 valid → below threshold of 3.
    const signals = await detectRepairPatterns(tenantId, testDb.db);
    expect(signals).toHaveLength(0);
  });

  test("MISSING PROPOSAL: 3 valid + 1 legacy → 1 signal with evidence.length === 3", async () => {
    const ep = "delete_item";
    const validIds: string[] = [];
    for (let i = 0; i < 3; i++) {
      const fixId = await seedFixture(ep);
      const [pc] = await testDb.db
        .insert(patchCandidates)
        .values({
          tenant_id: tenantId,
          workflow_id: workflowIds[i % workflowIds.length]!,
          diff: realDiff("update_field_path", "/data/id"),
          classification: "safe",
          fixture_id: fixId,
          status: "applied",
          created_at: RECENT_TS,
          updated_at: RECENT_TS,
        })
        .returning();
      if (!pc) throw new Error("seed failed");
      validIds.push(pc.id);
    }
    // Legacy row that should be skipped.
    const legacyFixId = await seedFixture(ep);
    await testDb.db.insert(patchCandidates).values({
      tenant_id: tenantId,
      workflow_id: workflowIds[0]!,
      diff: { kind: "update_field_path", path: "/data/id" },
      classification: "safe",
      fixture_id: legacyFixId,
      status: "applied",
      created_at: RECENT_TS,
      updated_at: RECENT_TS,
    });

    const signals = await detectRepairPatterns(tenantId, testDb.db);
    expect(signals).toHaveLength(1);
    expect(signals[0]!.evidence).toHaveLength(3);
    const evidencePatchIds = signals[0]!.evidence.map((e) => e.patch_candidate_id);
    for (const id of validIds) {
      expect(evidencePatchIds).toContain(id);
    }
  });

  test("IDEMPOTENT FINGERPRINT: calling the detector twice yields the same fingerprint", async () => {
    const ep = "get_profile";
    for (let i = 0; i < 3; i++) {
      const fixId = await seedFixture(ep);
      await testDb.db.insert(patchCandidates).values({
        tenant_id: tenantId,
        workflow_id: workflowIds[i % workflowIds.length]!,
        diff: realDiff("rename_param"),
        classification: "safe",
        fixture_id: fixId,
        status: "applied",
        created_at: RECENT_TS,
        updated_at: RECENT_TS,
      });
    }

    const [first, second] = await Promise.all([
      detectRepairPatterns(tenantId, testDb.db),
      detectRepairPatterns(tenantId, testDb.db),
    ]);

    expect(first).toHaveLength(1);
    expect(second).toHaveLength(1);
    expect(first[0]!.fingerprint).toBe(second[0]!.fingerprint);

    // The fingerprint must match the documented formula.
    const expected = createHash("sha256")
      .update(`repair:${connectorId}:${ep}:rename_param`)
      .digest("hex")
      .slice(0, 32);
    expect(first[0]!.fingerprint).toBe(expected);
  });

  test("TENANT ISOLATION: fixture + patch under a different tenant are not pulled in", async () => {
    // Seed a connector + workflow for the other tenant.
    const [otherConnector] = await testDb.db
      .insert(connectors)
      .values({
        tenant_id: otherTenantId,
        slug: "rpd-other-api",
        display_name: "RPD Other API",
        driver: "http",
      })
      .returning();
    if (!otherConnector) throw new Error("seed other connector failed");

    const [otherWorkflow] = await testDb.db
      .insert(workflows)
      .values({
        tenant_id: otherTenantId,
        slug: "rpd-other-wf",
        name: "RPD Other Workflow",
        lifecycle: "active",
      })
      .returning();
    if (!otherWorkflow) throw new Error("seed other workflow failed");

    const ep = "search";
    // Seed 3 applied patches for the OTHER tenant (same endpoint key, same kind).
    for (let i = 0; i < 3; i++) {
      const [fix] = await testDb.db
        .insert(executionFixtures)
        .values({
          tenant_id: otherTenantId,
          connector_id: otherConnector.id,
          endpoint_key: ep,
          request: {},
          response: {},
        })
        .returning();
      if (!fix) throw new Error("seed other fixture failed");

      await testDb.db.insert(patchCandidates).values({
        tenant_id: otherTenantId,
        workflow_id: otherWorkflow.id,
        diff: realDiff("update_field_path", "/data/id"),
        classification: "safe",
        fixture_id: fix.id,
        status: "applied",
        created_at: RECENT_TS,
        updated_at: RECENT_TS,
      });
    }

    // Running the detector for the primary tenant must see 0 signals.
    const signals = await detectRepairPatterns(tenantId, testDb.db);
    expect(signals).toHaveLength(0);
  });

  test("EVIDENCE TYPE: each evidence entry carries evidence_type 'patch_applied'", async () => {
    const ep = "bulk_update";
    for (let i = 0; i < 3; i++) {
      const fixId = await seedFixture(ep);
      await testDb.db.insert(patchCandidates).values({
        tenant_id: tenantId,
        workflow_id: workflowIds[i % workflowIds.length]!,
        diff: realDiff("add_header"),
        classification: "safe",
        fixture_id: fixId,
        status: "applied",
        created_at: RECENT_TS,
        updated_at: RECENT_TS,
      });
    }

    const signals = await detectRepairPatterns(tenantId, testDb.db);
    expect(signals).toHaveLength(1);
    for (const e of signals[0]!.evidence) {
      expect(e.evidence_type).toBe("patch_applied");
    }
  });
});
