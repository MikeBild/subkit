// Endpoint dedup + safe auto-apply for proactive drift signals.
//
// Before this slice the proactive scheduler re-proposed an identical
// `safe` patch every cadence tick — no idempotency key — so 25+
// duplicate `status='proposed'` rows piled up unreviewed (they could
// never auto-apply: the fixture gate is skipped for proactive scans).
//
// This file pins the fix:
//   1. A proactive `safe` signal with no fixture AUTO-APPLIES under the
//      default safe-patches policy (relaxed no-fixture rule).
//   2. A second signal for the SAME endpoint is short-circuited by the
//      dedup guard — refreshed when still proposed, skipped once applied
//      — so no duplicate row and no workflow-version churn.

import { afterAll, beforeAll, describe, expect, test } from "bun:test";
import { and, eq } from "drizzle-orm";
import { patchCandidates, workflowVersions } from "../../db/schema/index.ts";
import { getLatestShape } from "../../schema-versions/service.ts";
import { analyzeStepFailure } from "../drift-detector.ts";
import { processDriftSignal } from "../service.ts";
import { createSelfHealingCtx, type SelfHealingTestCtx } from "./setup.ts";

let ctx: SelfHealingTestCtx;

beforeAll(async () => {
  ctx = await createSelfHealingCtx("dedup");
});

afterAll(async () => {
  await ctx.cleanup();
});

async function buildSignal() {
  const db = ctx.testDb.db;
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
  if (!signal) throw new Error("expected drift signal");
  return { signal, snapshot };
}

function proactiveCtx(allowAutoApply: boolean) {
  return {
    signalCtx: {
      tenant_id: ctx.tenant_id,
      workflow_id: ctx.workflow_id,
      execution_id: ctx.execution_id,
      step_id: ctx.step_id,
      connector_id: ctx.connector_id,
      endpoint_key: ctx.endpoint_key,
      actor_id: null,
      source: "proactive_scheduler" as const,
      repair_input: {
        failing_step_id: `proactive:test:${ctx.step_id}`,
        response: { data: { id: 1 } },
      },
      // No dry_run_step — proactive callers omit it.
    },
    options: { allowAutoApply },
  };
}

async function endpointCandidateCount(): Promise<number> {
  const rows = await ctx.testDb.db
    .select()
    .from(patchCandidates)
    .where(
      and(
        eq(patchCandidates.tenant_id, ctx.tenant_id),
        eq(patchCandidates.workflow_id, ctx.workflow_id),
        eq(patchCandidates.connector_id, ctx.connector_id),
        eq(patchCandidates.endpoint_key, ctx.endpoint_key),
      ),
    );
  return rows.length;
}

async function versionCount(): Promise<number> {
  const rows = await ctx.testDb.db
    .select()
    .from(workflowVersions)
    .where(eq(workflowVersions.workflow_id, ctx.workflow_id));
  return rows.length;
}

describe("processDriftSignal — proactive endpoint dedup", () => {
  let firstCandidateId: string;

  test("first proactive scan (operator-invoked) parks one candidate stamped with the endpoint", async () => {
    const { signal } = await buildSignal();
    const { signalCtx, options } = proactiveCtx(/* allowAutoApply */ false);

    const result = await processDriftSignal(signal, signalCtx, options, ctx.testDb.db);
    firstCandidateId = result.candidate_id;

    expect(result.status).toBe("proposed");
    expect(result.classification).toBe("safe");
    expect(await endpointCandidateCount()).toBe(1);

    const [row] = await ctx.testDb.db
      .select()
      .from(patchCandidates)
      .where(eq(patchCandidates.id, result.candidate_id));
    expect(row?.connector_id).toBe(ctx.connector_id);
    expect(row?.endpoint_key).toBe(ctx.endpoint_key);
  });

  test("a second proactive scan refreshes the proposed candidate — no duplicate row, no LLM re-run", async () => {
    const { signal } = await buildSignal();
    const { signalCtx, options } = proactiveCtx(/* allowAutoApply */ false);

    const before = await endpointCandidateCount();
    const result = await processDriftSignal(signal, signalCtx, options, ctx.testDb.db);

    expect(result.candidate_id).toBe(firstCandidateId);
    expect(result.status).toBe("proposed");
    expect(await endpointCandidateCount()).toBe(before); // still 1
  });

  test("the scheduler tick (allowAutoApply) auto-applies the safe patch with no fixture", async () => {
    const { signal } = await buildSignal();
    const { signalCtx, options } = proactiveCtx(/* allowAutoApply */ true);

    const versionsBefore = await versionCount();
    const result = await processDriftSignal(signal, signalCtx, options, ctx.testDb.db);

    expect(result.candidate_id).toBe(firstCandidateId); // refreshed, not new
    expect(result.status).toBe("applied");
    expect(result.auto_applied).toBe(true);
    expect(await endpointCandidateCount()).toBe(1); // never duplicated
    expect(await versionCount()).toBe(versionsBefore + 1); // exactly one rotate

    const [row] = await ctx.testDb.db
      .select()
      .from(patchCandidates)
      .where(eq(patchCandidates.id, firstCandidateId));
    expect(row?.status).toBe("applied");
  });

  test("once applied, further scans skip the endpoint — no re-apply, no version churn", async () => {
    const { signal } = await buildSignal();
    const { signalCtx, options } = proactiveCtx(/* allowAutoApply */ true);

    const versionsBefore = await versionCount();
    const result = await processDriftSignal(signal, signalCtx, options, ctx.testDb.db);

    expect(result.candidate_id).toBe(firstCandidateId);
    expect(result.status).toBe("applied");
    expect(result.auto_applied).toBe(false); // skipped, not re-applied
    expect(await endpointCandidateCount()).toBe(1);
    expect(await versionCount()).toBe(versionsBefore); // no new version
  });
});
