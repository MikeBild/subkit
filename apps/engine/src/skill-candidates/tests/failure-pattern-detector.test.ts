import { afterAll, afterEach, beforeAll, describe, expect, test } from "bun:test";
import { createHash } from "node:crypto";
import { executionSteps, executions } from "../../db/schema/executions.ts";
import { tenants } from "../../db/schema/identity.ts";
import { workflows } from "../../db/schema/workflows.ts";
import { createTestDb, type TestDb } from "../../db/tests/setup.ts";
import {
  createDeterministicClock,
  FROZEN_NOW,
  installClock,
  restoreClock,
} from "../../test-helpers/determinism/clock.ts";
import { detectFailurePatterns } from "../detectors/failure-pattern.ts";

const skip = process.env.REQUIRES_PG === "0";

let testDb: TestDb;
let tenantId: string;
let otherTenantId: string;
let workflowId: string;
let otherWorkflowId: string;

const WITHIN_WINDOW_TS = new Date(FROZEN_NOW - 24 * 60 * 60 * 1000);
const OUTSIDE_WINDOW_TS = new Date(FROZEN_NOW - 31 * 24 * 60 * 60 * 1000);

beforeAll(async () => {
  if (skip) return;

  testDb = await createTestDb("failure-pattern-detector");

  const [tenant] = await testDb.db
    .insert(tenants)
    .values({ slug: "fpd-tenant", display_name: "FPD Tenant" })
    .returning();
  if (!tenant) throw new Error("seed tenant failed");
  tenantId = tenant.id;

  const [otherTenant] = await testDb.db
    .insert(tenants)
    .values({ slug: "fpd-other", display_name: "FPD Other" })
    .returning();
  if (!otherTenant) throw new Error("seed other tenant failed");
  otherTenantId = otherTenant.id;

  const [wf] = await testDb.db
    .insert(workflows)
    .values({
      tenant_id: tenantId,
      slug: "fpd-wf",
      name: "FPD Workflow",
      lifecycle: "active",
    })
    .returning();
  if (!wf) throw new Error("seed workflow failed");
  workflowId = wf.id;

  const [otherWf] = await testDb.db
    .insert(workflows)
    .values({
      tenant_id: otherTenantId,
      slug: "fpd-other-wf",
      name: "FPD Other Workflow",
      lifecycle: "active",
    })
    .returning();
  if (!otherWf) throw new Error("seed other workflow failed");
  otherWorkflowId = otherWf.id;
}, 60_000);

afterAll(async () => {
  if (!skip && testDb?.cleanup) await testDb.cleanup();
  restoreClock(null);
}, 30_000);

afterEach(async () => {
  if (skip) return;
  restoreClock(null);
  await testDb.db.delete(executionSteps);
  await testDb.db.delete(executions);
}, 30_000);

async function seedExecution(tenantIdArg: string, wfId: string, startedAt: Date): Promise<string> {
  const [ex] = await testDb.db
    .insert(executions)
    .values({
      tenant_id: tenantIdArg,
      workflow_id: wfId,
      status: "failed",
      request_source: "api",
      execution_mode: "prod",
      started_at: startedAt,
    })
    .returning();
  if (!ex) throw new Error("seed execution failed");
  return ex.id;
}

async function seedFailedStep(
  executionId: string,
  stepKey: string,
  error: Record<string, unknown>,
  startedAt: Date,
): Promise<void> {
  await testDb.db.insert(executionSteps).values({
    tenant_id: tenantId,
    execution_id: executionId,
    step_key: stepKey,
    kind: "request",
    status: "failed",
    error,
    started_at: startedAt,
  });
}

describe.skipIf(skip)("detectFailurePatterns", () => {
  test("BELOW THRESHOLD: 2 failures on same (workflow, step, error_kind) → 0 signals", async () => {
    installClock(createDeterministicClock(FROZEN_NOW));

    for (let i = 0; i < 2; i++) {
      const execId = await seedExecution(tenantId, workflowId, WITHIN_WINDOW_TS);
      await seedFailedStep(execId, "call_api", { kind: "network_error" }, WITHIN_WINDOW_TS);
    }

    const signals = await detectFailurePatterns(tenantId, testDb.db);
    expect(signals).toHaveLength(0);
  });

  test("AT THRESHOLD: 3 failures on same (workflow, step, error_kind) → exactly 1 signal", async () => {
    installClock(createDeterministicClock(FROZEN_NOW));

    const execIds: string[] = [];
    for (let i = 0; i < 3; i++) {
      const execId = await seedExecution(tenantId, workflowId, WITHIN_WINDOW_TS);
      execIds.push(execId);
      await seedFailedStep(execId, "transform_data", { kind: "type_error" }, WITHIN_WINDOW_TS);
    }

    const signals = await detectFailurePatterns(tenantId, testDb.db);
    expect(signals).toHaveLength(1);

    const s = signals[0]!;
    expect(s.pattern_kind).toBe("failure_pattern");
    expect(s.scope).toBe("workflow");
    expect(s.workflow_id).toBe(workflowId);
    expect(s.connector_id).toBeUndefined();
    expect(s.evidence).toHaveLength(3);
    for (const e of s.evidence) {
      expect(e.evidence_type).toBe("step_failure");
      const eid: string = e.execution_id ?? "";
      expect(execIds.includes(eid)).toBe(true);
    }
  });

  test("ABOVE THRESHOLD: 5 failures produce 1 signal with 5 evidence entries", async () => {
    installClock(createDeterministicClock(FROZEN_NOW));

    for (let i = 0; i < 5; i++) {
      const execId = await seedExecution(tenantId, workflowId, WITHIN_WINDOW_TS);
      await seedFailedStep(execId, "send_email", { code: "SMTP_TIMEOUT" }, WITHIN_WINDOW_TS);
    }

    const signals = await detectFailurePatterns(tenantId, testDb.db);
    expect(signals).toHaveLength(1);
    expect(signals[0]!.evidence).toHaveLength(5);
    expect(signals[0]!.facts).toEqual({
      kind: "recurring_failure",
      step_key: "send_email",
      error_kind: "SMTP_TIMEOUT",
      cause_class: "driver_error",
      count: 5,
      lookback_days: 30,
    });
  });

  test("ERROR KIND: falls back to err.code when err.kind is absent", async () => {
    installClock(createDeterministicClock(FROZEN_NOW));

    for (let i = 0; i < 3; i++) {
      const execId = await seedExecution(tenantId, workflowId, WITHIN_WINDOW_TS);
      await seedFailedStep(execId, "query_db", { code: "CONNECTION_REFUSED" }, WITHIN_WINDOW_TS);
    }

    const signals = await detectFailurePatterns(tenantId, testDb.db);
    expect(signals).toHaveLength(1);
    const fingerprint = createHash("sha256")
      .update(`failure:${workflowId}:query_db:CONNECTION_REFUSED`)
      .digest("hex")
      .slice(0, 32);
    expect(signals[0]!.fingerprint).toBe(fingerprint);
  });

  test("ERROR KIND: falls back to 'unknown' when error is null", async () => {
    installClock(createDeterministicClock(FROZEN_NOW));

    for (let i = 0; i < 3; i++) {
      const execId = await seedExecution(tenantId, workflowId, WITHIN_WINDOW_TS);
      await testDb.db.insert(executionSteps).values({
        tenant_id: tenantId,
        execution_id: execId,
        step_key: "null_err_step",
        kind: "request",
        status: "failed",
        error: null,
        started_at: WITHIN_WINDOW_TS,
      });
    }

    const signals = await detectFailurePatterns(tenantId, testDb.db);
    expect(signals).toHaveLength(1);
    const fingerprint = createHash("sha256")
      .update(`failure:${workflowId}:null_err_step:unknown`)
      .digest("hex")
      .slice(0, 32);
    expect(signals[0]!.fingerprint).toBe(fingerprint);
  });

  test("FINGERPRINT STABILITY: two runs with the same data produce the same fingerprint", async () => {
    installClock(createDeterministicClock(FROZEN_NOW));

    for (let i = 0; i < 3; i++) {
      const execId = await seedExecution(tenantId, workflowId, WITHIN_WINDOW_TS);
      await seedFailedStep(execId, "fetch_user", { kind: "auth_error" }, WITHIN_WINDOW_TS);
    }

    const [first, second] = await Promise.all([
      detectFailurePatterns(tenantId, testDb.db),
      detectFailurePatterns(tenantId, testDb.db),
    ]);

    expect(first).toHaveLength(1);
    expect(second).toHaveLength(1);
    expect(first[0]!.fingerprint).toBe(second[0]!.fingerprint);

    const expected = createHash("sha256")
      .update(`failure:${workflowId}:fetch_user:auth_error`)
      .digest("hex")
      .slice(0, 32);
    expect(first[0]!.fingerprint).toBe(expected);
  });

  test("TENANT ISOLATION: other tenant's failures are excluded", async () => {
    installClock(createDeterministicClock(FROZEN_NOW));

    for (let i = 0; i < 3; i++) {
      const [ex] = await testDb.db
        .insert(executions)
        .values({
          tenant_id: otherTenantId,
          workflow_id: otherWorkflowId,
          status: "failed",
          request_source: "api",
          execution_mode: "prod",
          started_at: WITHIN_WINDOW_TS,
        })
        .returning();
      if (!ex) throw new Error("seed execution failed");

      await testDb.db.insert(executionSteps).values({
        tenant_id: otherTenantId,
        execution_id: ex.id,
        step_key: "isolated_step",
        kind: "request",
        status: "failed",
        error: { kind: "permission_denied" },
        started_at: WITHIN_WINDOW_TS,
      });
    }

    const signals = await detectFailurePatterns(tenantId, testDb.db);
    expect(signals).toHaveLength(0);
  });

  test("LOOKBACK BOUNDARY: steps dated 31 days before FROZEN_NOW are excluded (0 signals)", async () => {
    installClock(createDeterministicClock(FROZEN_NOW));

    for (let i = 0; i < 3; i++) {
      const execId = await seedExecution(tenantId, workflowId, OUTSIDE_WINDOW_TS);
      await seedFailedStep(execId, "old_step", { kind: "stale_error" }, OUTSIDE_WINDOW_TS);
    }

    const signals = await detectFailurePatterns(tenantId, testDb.db);
    expect(signals).toHaveLength(0);
  });

  test("LOOKBACK BOUNDARY: steps within 30-day window are included (1 signal)", async () => {
    installClock(createDeterministicClock(FROZEN_NOW));

    for (let i = 0; i < 3; i++) {
      const execId = await seedExecution(tenantId, workflowId, WITHIN_WINDOW_TS);
      await seedFailedStep(execId, "recent_step", { kind: "timeout" }, WITHIN_WINDOW_TS);
    }

    const signals = await detectFailurePatterns(tenantId, testDb.db);
    expect(signals).toHaveLength(1);
    expect(signals[0]!.workflow_id).toBe(workflowId);
  });

  test("DRAFT EXCLUSION: steps without workflow_id (draft executions) are skipped", async () => {
    installClock(createDeterministicClock(FROZEN_NOW));

    const [draftEx] = await testDb.db
      .insert(executions)
      .values({
        tenant_id: tenantId,
        workflow_id: null,
        status: "failed",
        request_source: "api",
        execution_mode: "dev",
        started_at: WITHIN_WINDOW_TS,
      })
      .returning();
    if (!draftEx) throw new Error("seed draft execution failed");

    for (let i = 0; i < 3; i++) {
      await testDb.db.insert(executionSteps).values({
        tenant_id: tenantId,
        execution_id: draftEx.id,
        step_key: "draft_step",
        kind: "request",
        status: "failed",
        error: { kind: "draft_error" },
        started_at: WITHIN_WINDOW_TS,
      });
    }

    const signals = await detectFailurePatterns(tenantId, testDb.db);
    expect(signals).toHaveLength(0);
  });

  test("MULTIPLE GROUPS: two distinct (workflow, step, error_kind) triples each at threshold → 2 signals", async () => {
    installClock(createDeterministicClock(FROZEN_NOW));

    for (let i = 0; i < 3; i++) {
      const execId = await seedExecution(tenantId, workflowId, WITHIN_WINDOW_TS);
      await seedFailedStep(execId, "step_a", { kind: "timeout" }, WITHIN_WINDOW_TS);
    }

    for (let i = 0; i < 3; i++) {
      const execId = await seedExecution(tenantId, workflowId, WITHIN_WINDOW_TS);
      await seedFailedStep(execId, "step_b", { kind: "parse_error" }, WITHIN_WINDOW_TS);
    }

    const signals = await detectFailurePatterns(tenantId, testDb.db);
    expect(signals).toHaveLength(2);
    const stepKeys = signals.map((s) => s.title).sort();
    expect(stepKeys[0]).toContain("step_a");
    expect(stepKeys[1]).toContain("step_b");
  });
});
