import { afterAll, beforeAll, describe, expect, test } from "bun:test";
import { and, eq } from "drizzle-orm";
import { patchCandidates, workflowVersions } from "../../db/schema/index.ts";
import { getLatestShape } from "../../schema-versions/index.ts";
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
      },
      { allowAutoApply: false },
      db,
    );

    expect(result.status).toBe("proposed");
    expect(result.auto_applied).toBe(false);
    expect(result.candidate_id).toMatch(/^[0-9a-f-]{36}$/);

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

    expect(candidateRows[0]?.fixture_id).toBe(null);

    const versionsAfter = await db
      .select()
      .from(workflowVersions)
      .where(eq(workflowVersions.workflow_id, ctx.workflow_id));
    expect(versionsAfter.length).toBe(versionCountBefore);
  });
});
