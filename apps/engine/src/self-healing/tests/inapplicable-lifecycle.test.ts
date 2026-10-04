import { afterAll, beforeAll, describe, expect, test } from "bun:test";
import { and, eq } from "drizzle-orm";
import { auditLog } from "../../db/schema/audit.ts";
import { events, patchCandidates, workflows, workflowVersions } from "../../db/schema/index.ts";
import { getMockProvider } from "../../llm/mock-provider.ts";
import { getMetrics, resetMetricsRegistryForTests } from "../../observability/metrics.ts";
import { getLatestShape } from "../../schema-versions/service.ts";
import { approvePatchCandidate, PatchDecisionError } from "../candidate-decision.ts";
import { analyzeStepFailure } from "../drift-detector.ts";
import { sweepUndecidableCandidates } from "../open-decisions.ts";
import { processDriftSignal } from "../service.ts";
import {
  createSelfHealingCtx,
  resetSeedDag,
  SEED_STEP_ID,
  type SelfHealingTestCtx,
} from "./setup.ts";

let ctx: SelfHealingTestCtx;

beforeAll(async () => {
  ctx = await createSelfHealingCtx("inapplicable");
});

afterAll(async () => {
  await ctx.cleanup();
});

async function currentVersionId(): Promise<string> {
  const [wf] = await ctx.testDb.db
    .select({ id: workflows.current_version_id })
    .from(workflows)
    .where(and(eq(workflows.tenant_id, ctx.tenant_id), eq(workflows.id, ctx.workflow_id)));
  if (!wf?.id) throw new Error("workflow has no current version");
  return wf.id;
}

async function healStepInPlace(): Promise<void> {
  const id = await currentVersionId();
  const [ver] = await ctx.testDb.db
    .select({ dag: workflowVersions.dag })
    .from(workflowVersions)
    .where(eq(workflowVersions.id, id));
  const dag = ver?.dag as { steps: Record<string, unknown>[] };
  await ctx.testDb.db
    .update(workflowVersions)
    .set({
      dag: {
        ...dag,
        steps: dag.steps.map((s) =>
          s.id === SEED_STEP_ID ? { ...s, data_selector: "data.result.id" } : s,
        ),
      },
    })
    .where(eq(workflowVersions.id, id));
}

async function proactiveSignal() {
  const lastShape = await getLatestShape(
    { tenant_id: ctx.tenant_id, connector_id: ctx.connector_id, endpoint_key: ctx.endpoint_key },
    ctx.testDb.db,
  );
  const signal = analyzeStepFailure(
    {
      id: ctx.step_id,
      kind: "request" as const,
      status: "failed",
      error: { kind: "http", status: 404, body: { error: { code: "not_found", detail: "x" } } },
      request_meta: null,
      output_preview: { data: { id: 1 } },
    },
    lastShape,
  );
  if (!signal) throw new Error("expected drift signal");
  return signal;
}

const signalCtx = () => ({
  tenant_id: ctx.tenant_id,
  workflow_id: ctx.workflow_id,
  execution_id: ctx.execution_id,
  step_id: ctx.step_id,
  workflow_step_id: SEED_STEP_ID,
  connector_id: ctx.connector_id,
  endpoint_key: ctx.endpoint_key,
  actor_id: null,
  source: "proactive_scheduler" as const,
  repair_input: { failing_step_id: `proactive:test:${ctx.step_id}`, response: { data: { id: 1 } } },
});

async function closureAudits(candidateId: string) {
  return ctx.testDb.db
    .select()
    .from(auditLog)
    .where(
      and(
        eq(auditLog.tenant_id, ctx.tenant_id),
        eq(auditLog.resource_id, candidateId),
        eq(auditLog.action, "patch_candidate.closed_inapplicable"),
      ),
    );
}

describe("inapplicable lifecycle", () => {
  let closedId = "";
  let closedVersion = "";
  let reopenedId = "";

  test("a safe candidate whose apply is no_change is closed at creation — audited, never announced", async () => {
    await healStepInPlace();
    closedVersion = await currentVersionId();
    resetMetricsRegistryForTests();

    const result = await processDriftSignal(
      await proactiveSignal(),
      signalCtx(),
      { allowAutoApply: true },
      ctx.testDb.db,
    );
    expect(result.classification).toBe("safe");
    expect(result.created).toBe(true);
    expect(result.auto_applied).toBe(false);
    expect(result.status).toBe("inapplicable");
    closedId = result.candidate_id;

    const [row] = await ctx.testDb.db
      .select()
      .from(patchCandidates)
      .where(eq(patchCandidates.id, closedId));
    expect(row?.status).toBe("inapplicable");
    expect(row?.closed_reason).toBe("no_change");
    expect(row?.closed_against_version_id).toBe(closedVersion);
    expect(row?.closed_at).toBeInstanceOf(Date);

    const audits = await closureAudits(closedId);
    expect(audits).toHaveLength(1);
    expect(audits[0]?.actor_type).toBe("system");
    expect(audits[0]?.reason).toBe("no_change");
    expect(audits[0]?.metadata).toMatchObject({ closed_against_version_id: closedVersion });

    const proposedAudits = await ctx.testDb.db
      .select()
      .from(auditLog)
      .where(
        and(eq(auditLog.resource_id, closedId), eq(auditLog.action, "patch_candidate.proposed")),
      );
    expect(proposedAudits).toHaveLength(0);
    const announced = (
      await ctx.testDb.db.select().from(events).where(eq(events.tenant_id, ctx.tenant_id))
    ).filter(
      (e) =>
        e.type === "patch.proposed" &&
        (e.payload as Record<string, unknown>).patch_candidate_id === closedId,
    );
    expect(announced).toHaveLength(0);
    const exposition = getMetrics().render();
    expect(exposition).toMatch(/patch_candidates_total\{[^}]*decision="closed_inapplicable"/);
    expect(exposition).not.toMatch(/patch_candidates_total\{[^}]*decision="parked"/);
  });

  test("the same drift on the same version is deduped against the closure — no LLM, no row", async () => {
    const before = await ctx.testDb.db
      .select()
      .from(patchCandidates)
      .where(eq(patchCandidates.tenant_id, ctx.tenant_id));
    const llmCalls = getMockProvider().calls.length;

    const result = await processDriftSignal(
      await proactiveSignal(),
      signalCtx(),
      { allowAutoApply: true },
      ctx.testDb.db,
    );
    expect(result.created).toBe(false);
    expect(result.candidate_id).toBe(closedId);
    expect(result.status).toBe("inapplicable");
    expect(getMockProvider().calls.length).toBe(llmCalls);

    const after = await ctx.testDb.db
      .select()
      .from(patchCandidates)
      .where(eq(patchCandidates.tenant_id, ctx.tenant_id));
    expect(after.length).toBe(before.length);
  });

  test("a new workflow version re-opens evaluation and allows a fresh proposal", async () => {
    const [v2] = await ctx.testDb.db
      .insert(workflowVersions)
      .values({
        tenant_id: ctx.tenant_id,
        workflow_id: ctx.workflow_id,
        version: 2,
        dag: {
          steps: [
            {
              kind: "request",
              id: SEED_STEP_ID,
              method: "GET",
              connector_id: ctx.connector_id,
              path: "/users/1",
              data_selector: "data.id",
            },
          ],
        },
      })
      .returning();
    await ctx.testDb.db
      .update(workflows)
      .set({ current_version_id: v2!.id })
      .where(and(eq(workflows.tenant_id, ctx.tenant_id), eq(workflows.id, ctx.workflow_id)));

    const result = await processDriftSignal(
      await proactiveSignal(),
      signalCtx(),
      { allowAutoApply: false },
      ctx.testDb.db,
    );
    expect(result.created).toBe(true);
    expect(result.candidate_id).not.toBe(closedId);
    expect(result.status).toBe("proposed");
    reopenedId = result.candidate_id;
  });

  test("the sweep closes only what readiness proves undecidable, and bumps nothing else", async () => {
    await resetSeedDag(ctx);
    const old = new Date(Date.UTC(2026, 0, 1));
    const base = {
      tenant_id: ctx.tenant_id,
      workflow_id: ctx.workflow_id,
      classification: "safe" as const,
      status: "proposed" as const,
      updated_at: old,
    };
    const move = (value: string) => ({
      classification: "safe",
      kind: "update_field_path",
      description: `move to ${value}`,
      reasoning: "fixture",
      patch: { op: "replace", path: "/data/id", value },
    });
    const rows = await ctx.testDb.db
      .insert(patchCandidates)
      .values([
        { ...base, diff: { proposal: move("data/id"), workflow_step_id: SEED_STEP_ID } },
        {
          ...base,
          diff: {
            proposal: { ...move("data/x"), kind: "change_type" },
            workflow_step_id: SEED_STEP_ID,
          },
        },
        { ...base, diff: { proposal: move("data/other/id"), workflow_step_id: SEED_STEP_ID } },
        { ...base, diff: { proposal: move("data/other/id"), workflow_step_id: "gone" } },
      ])
      .returning();
    const [noChange, notApplicable, reviewable, stepGone] = rows;

    const closed = await sweepUndecidableCandidates(ctx.testDb.db, ctx.tenant_id);
    expect(closed).toBeGreaterThanOrEqual(2);

    const byId = async (id: string) =>
      (await ctx.testDb.db.select().from(patchCandidates).where(eq(patchCandidates.id, id)))[0];
    expect((await byId(noChange!.id))?.status).toBe("inapplicable");
    expect((await byId(noChange!.id))?.closed_reason).toBe("no_change");
    expect((await byId(notApplicable!.id))?.status).toBe("inapplicable");
    expect((await byId(notApplicable!.id))?.closed_reason).toBe("patch_not_applicable");
    for (const kept of [reviewable!, stepGone!]) {
      const row = await byId(kept.id);
      expect(row?.status).toBe("proposed");
      expect(row?.updated_at.getTime()).toBe(old.getTime());
    }
    expect(await closureAudits(noChange!.id)).toHaveLength(1);
  });

  test("a manual approve that cannot be performed closes the candidate", async () => {
    await healStepInPlace();
    const [row] = await ctx.testDb.db
      .insert(patchCandidates)
      .values({
        tenant_id: ctx.tenant_id,
        workflow_id: ctx.workflow_id,
        classification: "safe",
        status: "proposed",
        diff: {
          proposal: {
            classification: "safe",
            kind: "update_field_path",
            description: "move",
            reasoning: "fixture",
            patch: { op: "replace", path: "/data/id", value: "data/result/id" },
          },
          workflow_step_id: SEED_STEP_ID,
        },
      })
      .returning();

    const refused = await approvePatchCandidate(
      { tenant_id: ctx.tenant_id, candidate_id: row!.id, actor_id: null },
      ctx.testDb.db,
    ).catch((err: unknown) => err);
    expect(refused).toBeInstanceOf(PatchDecisionError);
    const [after] = await ctx.testDb.db
      .select()
      .from(patchCandidates)
      .where(eq(patchCandidates.id, row!.id));
    expect(after?.status).toBe("inapplicable");
    expect(after?.closed_reason).toBe("no_change");
  });

  test("the refresh path closes an open candidate once its version can no longer take it", async () => {
    const result = await processDriftSignal(
      await proactiveSignal(),
      signalCtx(),
      { allowAutoApply: false },
      ctx.testDb.db,
    );
    expect(result.candidate_id).toBe(reopenedId);
    expect(result.created).toBe(false);
    expect(result.status).toBe("inapplicable");
    const audits = await closureAudits(reopenedId);
    expect(audits).toHaveLength(1);
    expect(audits[0]?.metadata).toMatchObject({ via: "proactive_refresh" });
  });
});
