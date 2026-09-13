// Unit test for the proactive-disposition branch of processDriftSignal.
//
// The reactive path (loop.test.ts) covers `allowAutoApply: true` with
// classification='safe' + dry-run passing + policy=safe-patches and
// asserts the patch lands as `status='applied'`. This file covers
// the proactive contract: calling processDriftSignal with the same
// downstream conditions but `allowAutoApply: false` MUST park the
// candidate as `status='proposed'` and emit NO new workflow_version
// row, regardless of how clean the classification + policy come out.
//
// Without this test, a future refactor that accidentally treats
// `allowAutoApply` as a hint rather than a hard gate would slip past
// the test suite — the HTTP / MCP / scheduler integration tests all
// run scans against tenants with no seeded drift, so they never
// exercise the candidate-creation path.

import { afterAll, beforeAll, describe, expect, test } from "bun:test";
import { and, eq } from "drizzle-orm";

import { patchCandidates, workflowVersions } from "../../db/schema/index.ts";
import { getLatestShape } from "../../schema-versions/service.ts";
import { analyzeStepFailure } from "../drift-detector.ts";
import { processDriftSignal } from "../service.ts";
import { createSelfHealingCtx, type SelfHealingTestCtx } from "./setup.ts";

let ctx: SelfHealingTestCtx;

beforeAll(async () => {
  ctx = await createSelfHealingCtx("proactive-disposition");
});

afterAll(async () => {
  await ctx.cleanup();
});

describe("processDriftSignal — allowAutoApply: false", () => {
  test("parks the candidate as 'proposed' even when classifier + policy would auto-apply", async () => {
    const db = ctx.testDb.db;

    // Build a real DriftSignal from the seeded step snapshot so the
    // bounded repair loop runs the same way the proactive scheduler
    // would once it dispatches a synthesized signal.
    const lastShape = await getLatestShape(
      {
        tenant_id: ctx.tenant_id,
        connector_id: ctx.connector_id,
        endpoint_key: ctx.endpoint_key,
      },
      db,
    );
    const snapshot = {
      id: ctx.step_id,
      kind: "request" as const,
      status: "failed",
      error: {
        kind: "http",
        status: 404,
        body: { error: { code: "not_found", detail: "User not found" } },
      },
      request_meta: null,
      output_preview: { data: { id: 1 } },
    };
    const signal = analyzeStepFailure(snapshot, lastShape);
    expect(signal).toBeTruthy();
    if (!signal) throw new Error("expected drift signal");

    // Snapshot pre-state of workflow_versions so we can prove no new
    // version was written.
    const versionsBefore = await db
      .select()
      .from(workflowVersions)
      .where(eq(workflowVersions.workflow_id, ctx.workflow_id));
    const versionCountBefore = versionsBefore.length;

    const result = await processDriftSignal(
      signal,
      {
        tenant_id: ctx.tenant_id,
        workflow_id: ctx.workflow_id,
        execution_id: ctx.execution_id,
        step_id: ctx.step_id,
        connector_id: ctx.connector_id,
        endpoint_key: ctx.endpoint_key,
        actor_id: null,
        source: "proactive_admin",
        repair_input: {
          failing_step_id: `proactive:test:${ctx.step_id}`,
          response: snapshot.output_preview,
        },
        // Intentionally NO dry_run_step — proactive callers omit it.
      },
      { allowAutoApply: false },
      db,
    );

    expect(result.status).toBe("proposed");
    expect(result.auto_applied).toBe(false);
    expect(result.candidate_id).toMatch(/^[0-9a-f-]{36}$/);

    // Row is parked, not applied.
    const candidateRows = await db
      .select()
      .from(patchCandidates)
      .where(
        and(
          eq(patchCandidates.tenant_id, ctx.tenant_id),
          eq(patchCandidates.id, result.candidate_id),
        ),
      );
    expect(candidateRows[0]?.status).toBe("proposed");

    // No fixture_id stamped — the dry-run gate was skipped, so we
    // must not pretend the candidate was validated against a fixture.
    expect(candidateRows[0]?.fixture_id).toBe(null);

    // No new workflow_versions row landed.
    const versionsAfter = await db
      .select()
      .from(workflowVersions)
      .where(eq(workflowVersions.workflow_id, ctx.workflow_id));
    expect(versionsAfter.length).toBe(versionCountBefore);
  });
});
