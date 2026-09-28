// An anchorless candidate is closed — and its closure never mutes a drift a
// person could decide.
//
// A since-fixed bug produced candidates with no step anchor (neither the
// definition step nor the failing execution step). Readiness proves them
// `no_step_anchor`: no answer can make them land. They sat `proposed`, out of
// every count, and stood in for their drift in the active lookup, so a
// correctly anchored re-proposal of the same drift deduplicated against them.
//
// Closing them must not repeat the known mistake of a terminal status that
// matches by fingerprint forever. Pinned here, each against the same drift
// fingerprint:
//   1. the sweep closes the legacy row as `inapplicable` / `no_step_anchor`,
//      bound to the version it was proven against, with a system audit row;
//   2. an equally anchorless re-proposal on that version is suppressed — the
//      one that would be closed at birth again and loop on every scan;
//   3. on a NEW version the same anchorless drift is evaluated again;
//   4. an ANCHORED re-proposal is never suppressed by an anchorless closure —
//      including a legacy closure that stored no drift signal at all.

import { afterAll, beforeAll, describe, expect, test } from "bun:test";
import { and, eq } from "drizzle-orm";
import { auditLog } from "../../db/schema/audit.ts";
import { patchCandidates, workflows, workflowVersions } from "../../db/schema/index.ts";
import { getMockProvider } from "../../llm/mock-provider.ts";
import { getLatestShape } from "../../schema-versions/service.ts";
import { analyzeStepFailure } from "../drift-detector.ts";
import { sweepUndecidableCandidates } from "../open-decisions.ts";
import { processDriftSignal } from "../service.ts";
import { createSelfHealingCtx, SEED_STEP_ID, type SelfHealingTestCtx } from "./setup.ts";

let ctx: SelfHealingTestCtx;

beforeAll(async () => {
  ctx = await createSelfHealingCtx("anchorless");
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

async function driftSignal() {
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

/** The legacy shape: a proactive scan that dropped every anchor. */
const anchorlessCtx = () => ({
  tenant_id: ctx.tenant_id,
  workflow_id: ctx.workflow_id,
  execution_id: null,
  step_id: null,
  workflow_step_id: null,
  connector_id: ctx.connector_id,
  endpoint_key: ctx.endpoint_key,
  actor_id: null,
  source: "proactive_scheduler" as const,
  repair_input: { failing_step_id: "proactive:test:anchorless", response: { data: { id: 1 } } },
});

const anchoredCtx = () => ({ ...anchorlessCtx(), workflow_step_id: SEED_STEP_ID });

const move = {
  classification: "safe",
  kind: "update_field_path",
  description: "move id under result",
  reasoning: "fixture",
  patch: { op: "replace", path: "/data/id", value: "data/result/id" },
};

describe("anchorless candidates", () => {
  let legacyId = "";
  let firstVersion = "";

  test("the sweep closes a legacy anchorless row, bound to the current version", async () => {
    firstVersion = await currentVersionId();
    const [row] = await ctx.testDb.db
      .insert(patchCandidates)
      .values({
        tenant_id: ctx.tenant_id,
        workflow_id: ctx.workflow_id,
        connector_id: ctx.connector_id,
        endpoint_key: ctx.endpoint_key,
        classification: "safe",
        status: "proposed",
        diff: { proposal: move, drift_signal: await driftSignal() },
      })
      .returning();
    legacyId = row!.id;

    expect(await sweepUndecidableCandidates(ctx.testDb.db, ctx.tenant_id)).toBe(1);
    const [after] = await ctx.testDb.db
      .select()
      .from(patchCandidates)
      .where(eq(patchCandidates.id, legacyId));
    expect(after?.status).toBe("inapplicable");
    expect(after?.closed_reason).toBe("no_step_anchor");
    expect(after?.closed_against_version_id).toBe(firstVersion);
    const audits = await ctx.testDb.db
      .select()
      .from(auditLog)
      .where(
        and(
          eq(auditLog.resource_id, legacyId),
          eq(auditLog.action, "patch_candidate.closed_inapplicable"),
        ),
      );
    expect(audits).toHaveLength(1);
    expect(audits[0]?.reason).toBe("no_step_anchor");
  });

  test("an anchorless re-proposal on the same version is suppressed — no LLM, no row", async () => {
    const llmCalls = getMockProvider().calls.length;
    const result = await processDriftSignal(
      await driftSignal(),
      anchorlessCtx(),
      { allowAutoApply: false },
      ctx.testDb.db,
    );
    expect(result.created).toBe(false);
    expect(result.candidate_id).toBe(legacyId);
    expect(getMockProvider().calls.length).toBe(llmCalls);
  });

  test("on a new version the same anchorless drift is evaluated again", async () => {
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
      await driftSignal(),
      anchorlessCtx(),
      { allowAutoApply: false },
      ctx.testDb.db,
    );
    expect(result.created).toBe(true);
    expect(result.candidate_id).not.toBe(legacyId);
    // Still anchorless, so still undecidable: closed at birth, never announced.
    expect(result.status).toBe("inapplicable");
  });

  test("an anchored re-proposal is never suppressed by an anchorless closure", async () => {
    // A legacy closure with no stored drift signal on this anchored endpoint —
    // the lenient fallback that would otherwise dedup by endpoint alone.
    await ctx.testDb.db.insert(patchCandidates).values({
      tenant_id: ctx.tenant_id,
      workflow_id: ctx.workflow_id,
      connector_id: ctx.connector_id,
      endpoint_key: ctx.endpoint_key,
      classification: "safe",
      status: "inapplicable",
      closed_reason: "no_step_anchor",
      closed_against_version_id: await currentVersionId(),
      closed_at: new Date(Date.UTC(2026, 7, 1)),
      diff: { proposal: move },
    });

    const result = await processDriftSignal(
      await driftSignal(),
      anchoredCtx(),
      { allowAutoApply: false },
      ctx.testDb.db,
    );
    expect(result.created).toBe(true);
    expect(result.status).toBe("proposed");
    const [row] = await ctx.testDb.db
      .select()
      .from(patchCandidates)
      .where(eq(patchCandidates.id, result.candidate_id));
    const diff = (row?.diff ?? {}) as { workflow_step_id?: string };
    expect(diff.workflow_step_id).toBe(SEED_STEP_ID);
  });
});
