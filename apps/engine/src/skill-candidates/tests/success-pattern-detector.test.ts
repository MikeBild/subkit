// Integration tests for detectSuccessPatterns.
//
// The detector:
//   • Queries execution_steps with kind='request', status='succeeded', tenant_id,
//     started_at >= cutoff (30 days).
//   • Skips rows whose execution has no workflow_id (draft/step runs).
//   • Groups by workflow_id; threshold >= 10 steps per group.
//   • Within a group, checks data_selector usage: if >= 10 steps carry
//     request_meta.data_selector AND the dominant selector accounts for >= 80%
//     of those steps at >= 10 count, emits 1 signal per qualifying selector.
//   • Fingerprint: sha256(`success:<workflowId>:data_selector:<selector>`).slice(0,32).
//   • Emitted signal: scope:"workflow", workflow_id set.
//
// Clock: detectSuccessPatterns reads time through `now()`. Tests that need
// a lookback boundary use installClock/restoreClock to freeze time.

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
import { detectSuccessPatterns } from "../detectors/success-pattern.ts";

const skip = process.env.REQUIRES_PG === "0";

let testDb: TestDb;
let tenantId: string;
let otherTenantId: string;
let workflowId: string;
let otherWorkflowId: string;

// Fixed timestamps relative to FROZEN_NOW.
const WITHIN_WINDOW_TS = new Date(FROZEN_NOW - 24 * 60 * 60 * 1000); // 1 day before frozen
const OUTSIDE_WINDOW_TS = new Date(FROZEN_NOW - 31 * 24 * 60 * 60 * 1000); // 31 days before frozen

beforeAll(async () => {
  if (skip) return;

  testDb = await createTestDb("success-pattern-detector");

  const [tenant] = await testDb.db
    .insert(tenants)
    .values({ slug: "spd-tenant", display_name: "SPD Tenant" })
    .returning();
  if (!tenant) throw new Error("seed tenant failed");
  tenantId = tenant.id;

  const [otherTenant] = await testDb.db
    .insert(tenants)
    .values({ slug: "spd-other", display_name: "SPD Other" })
    .returning();
  if (!otherTenant) throw new Error("seed other tenant failed");
  otherTenantId = otherTenant.id;

  const [wf] = await testDb.db
    .insert(workflows)
    .values({
      tenant_id: tenantId,
      slug: "spd-wf",
      name: "SPD Workflow",
      lifecycle: "active",
    })
    .returning();
  if (!wf) throw new Error("seed workflow failed");
  workflowId = wf.id;

  const [otherWf] = await testDb.db
    .insert(workflows)
    .values({
      tenant_id: otherTenantId,
      slug: "spd-other-wf",
      name: "SPD Other Workflow",
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

/** Seed an execution (saved workflow). */
async function seedExecution(tenantIdArg: string, wfId: string, startedAt: Date): Promise<string> {
  const [ex] = await testDb.db
    .insert(executions)
    .values({
      tenant_id: tenantIdArg,
      workflow_id: wfId,
      status: "succeeded",
      request_source: "api",
      execution_mode: "prod",
      started_at: startedAt,
    })
    .returning();
  if (!ex) throw new Error("seed execution failed");
  return ex.id;
}

/** Seed one successful request step with an optional request_meta payload. */
async function seedSuccessStep(
  executionId: string,
  stepKey: string,
  requestMeta: Record<string, unknown> | null,
  startedAt: Date,
): Promise<void> {
  await testDb.db.insert(executionSteps).values({
    tenant_id: tenantId,
    execution_id: executionId,
    step_key: stepKey,
    kind: "request",
    status: "succeeded",
    request_meta: requestMeta,
    started_at: startedAt,
  });
}

describe.skipIf(skip)("detectSuccessPatterns", () => {
  test("BELOW THRESHOLD: 9 successful steps → 0 signals (global threshold check)", async () => {
    installClock(createDeterministicClock(FROZEN_NOW));

    for (let i = 0; i < 9; i++) {
      const execId = await seedExecution(tenantId, workflowId, WITHIN_WINDOW_TS);
      await seedSuccessStep(execId, `step_${i}`, { data_selector: "$.items" }, WITHIN_WINDOW_TS);
    }

    const signals = await detectSuccessPatterns(tenantId, testDb.db);
    expect(signals).toHaveLength(0);
  });

  test("AT THRESHOLD: 10 successful request steps with consistent data_selector → 1 signal", async () => {
    installClock(createDeterministicClock(FROZEN_NOW));

    for (let i = 0; i < 10; i++) {
      const execId = await seedExecution(tenantId, workflowId, WITHIN_WINDOW_TS);
      await seedSuccessStep(
        execId,
        `req_step_${i}`,
        { data_selector: "$.data.results" },
        WITHIN_WINDOW_TS,
      );
    }

    const signals = await detectSuccessPatterns(tenantId, testDb.db);
    expect(signals).toHaveLength(1);

    const s = signals[0]!;
    expect(s.pattern_kind).toBe("success_pattern");
    expect(s.scope).toBe("workflow");
    expect(s.workflow_id).toBe(workflowId);
    expect(s.connector_id).toBeUndefined();
    expect(s.evidence.length).toBeGreaterThanOrEqual(10);
    for (const e of s.evidence) {
      expect(e.evidence_type).toBe("step_success");
    }
  });

  test("FINGERPRINT: fingerprint matches the documented sha256 formula", async () => {
    installClock(createDeterministicClock(FROZEN_NOW));

    const selector = "$.records";
    for (let i = 0; i < 10; i++) {
      const execId = await seedExecution(tenantId, workflowId, WITHIN_WINDOW_TS);
      await seedSuccessStep(execId, `s_${i}`, { data_selector: selector }, WITHIN_WINDOW_TS);
    }

    const signals = await detectSuccessPatterns(tenantId, testDb.db);
    expect(signals).toHaveLength(1);

    const expected = createHash("sha256")
      .update(`success:${workflowId}:data_selector:${selector}`)
      .digest("hex")
      .slice(0, 32);
    expect(signals[0]!.fingerprint).toBe(expected);
  });

  test("TENANT ISOLATION: other tenant's steps are excluded", async () => {
    installClock(createDeterministicClock(FROZEN_NOW));

    // Seed 10 successful steps for the other tenant.
    for (let i = 0; i < 10; i++) {
      const [ex] = await testDb.db
        .insert(executions)
        .values({
          tenant_id: otherTenantId,
          workflow_id: otherWorkflowId,
          status: "succeeded",
          request_source: "api",
          execution_mode: "prod",
          started_at: WITHIN_WINDOW_TS,
        })
        .returning();
      if (!ex) throw new Error("seed execution failed");

      await testDb.db.insert(executionSteps).values({
        tenant_id: otherTenantId,
        execution_id: ex.id,
        step_key: `other_step_${i}`,
        kind: "request",
        status: "succeeded",
        request_meta: { data_selector: "$.items" },
        started_at: WITHIN_WINDOW_TS,
      });
    }

    // Primary tenant sees 0 signals.
    const signals = await detectSuccessPatterns(tenantId, testDb.db);
    expect(signals).toHaveLength(0);
  });

  test("LOOKBACK BOUNDARY: steps 31 days before FROZEN_NOW are excluded (0 signals)", async () => {
    installClock(createDeterministicClock(FROZEN_NOW));

    for (let i = 0; i < 10; i++) {
      const execId = await seedExecution(tenantId, workflowId, OUTSIDE_WINDOW_TS);
      await seedSuccessStep(execId, `old_step_${i}`, { data_selector: "$.old" }, OUTSIDE_WINDOW_TS);
    }

    const signals = await detectSuccessPatterns(tenantId, testDb.db);
    expect(signals).toHaveLength(0);
  });

  test("LOOKBACK BOUNDARY: steps within 30-day window are included (1 signal)", async () => {
    installClock(createDeterministicClock(FROZEN_NOW));

    for (let i = 0; i < 10; i++) {
      const execId = await seedExecution(tenantId, workflowId, WITHIN_WINDOW_TS);
      await seedSuccessStep(
        execId,
        `new_step_${i}`,
        { data_selector: "$.entries" },
        WITHIN_WINDOW_TS,
      );
    }

    const signals = await detectSuccessPatterns(tenantId, testDb.db);
    expect(signals).toHaveLength(1);
    expect(signals[0]!.workflow_id).toBe(workflowId);
  });

  test("NO DATA_SELECTOR: 10 steps without data_selector in request_meta → 0 signals", async () => {
    installClock(createDeterministicClock(FROZEN_NOW));

    for (let i = 0; i < 10; i++) {
      const execId = await seedExecution(tenantId, workflowId, WITHIN_WINDOW_TS);
      await seedSuccessStep(execId, `no_sel_${i}`, { method: "GET" }, WITHIN_WINDOW_TS);
    }

    const signals = await detectSuccessPatterns(tenantId, testDb.db);
    expect(signals).toHaveLength(0);
  });

  test("BELOW RATIO: mixed selectors (one dominant at < 80%) → 0 signals", async () => {
    installClock(createDeterministicClock(FROZEN_NOW));

    // 10 steps with data_selector, split 6/4 between two selectors.
    // The dominant one is "$.a" at 6/10 = 60% < 80% → no signal.
    for (let i = 0; i < 6; i++) {
      const execId = await seedExecution(tenantId, workflowId, WITHIN_WINDOW_TS);
      await seedSuccessStep(execId, `mixed_${i}`, { data_selector: "$.a" }, WITHIN_WINDOW_TS);
    }
    for (let i = 0; i < 4; i++) {
      const execId = await seedExecution(tenantId, workflowId, WITHIN_WINDOW_TS);
      await seedSuccessStep(execId, `mixed_b_${i}`, { data_selector: "$.b" }, WITHIN_WINDOW_TS);
    }

    const signals = await detectSuccessPatterns(tenantId, testDb.db);
    expect(signals).toHaveLength(0);
  });
});
