import { afterAll, beforeAll, describe, expect, test } from "bun:test";
import { and, eq } from "drizzle-orm";
import {
  patchCandidates,
  workflowAutohealPolicies,
  workflows,
  workflowVersions,
} from "../../db/schema/index.ts";
import { FROZEN_NOW } from "../../test-helpers/determinism/clock.ts";
import type { WorkflowSpec } from "../../workflows/index.ts";
import { approvePatchCandidate } from "../candidate-decision.ts";
import { previewPatchCandidate } from "../candidate-review.ts";
import { preparePatchCandidate } from "../prepare-candidate.ts";
import { runSelfHealingLoop } from "../service.ts";
import { createSelfHealingCtx, resetSeedDag, type SelfHealingTestCtx } from "./setup.ts";

let ctx: SelfHealingTestCtx;

const SPEC: WorkflowSpec = {
  goal: "Read the user record for the nightly sync",
  inputs: [],
  outputs: [{ name: "user" }],
  delivery: null,
  conventions_applied: [],
  evidence: [],
  open_questions: [],
  origin: "person",
};

beforeAll(async () => {
  ctx = await createSelfHealingCtx("spec_carry");
}, 30_000);

afterAll(async () => {
  await ctx.cleanup();
}, 30_000);

async function currentVersionId(): Promise<string> {
  const [wf] = await ctx.testDb.db
    .select({ current_version_id: workflows.current_version_id })
    .from(workflows)
    .where(and(eq(workflows.tenant_id, ctx.tenant_id), eq(workflows.id, ctx.workflow_id)));
  if (!wf?.current_version_id) throw new Error("workflow has no current version");
  return wf.current_version_id;
}

async function specOf(version_id: string) {
  const [row] = await ctx.testDb.db
    .select({ spec: workflowVersions.spec })
    .from(workflowVersions)
    .where(and(eq(workflowVersions.tenant_id, ctx.tenant_id), eq(workflowVersions.id, version_id)));
  return row?.spec ?? null;
}

async function seedCandidateOnSpecVersion(): Promise<string> {
  const db = ctx.testDb.db;
  await db.delete(patchCandidates).where(eq(patchCandidates.workflow_id, ctx.workflow_id));
  await resetSeedDag(ctx);
  await db
    .update(workflowVersions)
    .set({ spec: SPEC })
    .where(
      and(
        eq(workflowVersions.tenant_id, ctx.tenant_id),
        eq(workflowVersions.id, await currentVersionId()),
      ),
    );
  await db
    .insert(workflowAutohealPolicies)
    .values({ tenant_id: ctx.tenant_id, workflow_id: ctx.workflow_id, policy: "never-auto" })
    .onConflictDoUpdate({
      target: [workflowAutohealPolicies.workflow_id],
      set: { policy: "never-auto", updated_at: new Date(FROZEN_NOW) },
    });
  const result = await runSelfHealingLoop(
    {
      tenant_id: ctx.tenant_id,
      workflow_id: ctx.workflow_id,
      execution_id: ctx.execution_id,
      step_id: ctx.step_id,
      connector_id: ctx.connector_id,
      endpoint_key: ctx.endpoint_key,
    },
    db,
  );
  if (!result.patch_candidate_id)
    throw new Error(`expected a candidate: ${JSON.stringify(result)}`);
  return result.patch_candidate_id;
}

describe("self-healing versions keep the spec of the version they repair", () => {
  test("a prepared repair carries the spec into the version it activates", async () => {
    const candidateId = await seedCandidateOnSpecVersion();
    const db = ctx.testDb.db;
    const preview = await previewPatchCandidate(ctx.tenant_id, candidateId, db);
    if (!preview?.review_digest) throw new Error("expected executable preview");
    const params = {
      tenant_id: ctx.tenant_id,
      candidate_id: candidateId,
      actor_id: null,
      expected_review_digest: preview.review_digest,
    };
    const prepared = await preparePatchCandidate(params, db);
    expect(await specOf(prepared.workflow_version_id)).toEqual(SPEC);
    await approvePatchCandidate(
      { ...params, prepared_version_id: prepared.workflow_version_id },
      db,
    );
    expect(await currentVersionId()).toBe(prepared.workflow_version_id);
  });

  test("an applied repair without preparation carries the spec as well", async () => {
    const candidateId = await seedCandidateOnSpecVersion();
    const db = ctx.testDb.db;
    const before = await currentVersionId();
    const preview = await previewPatchCandidate(ctx.tenant_id, candidateId, db);
    if (!preview?.review_digest) throw new Error("expected executable preview");
    const applied = await approvePatchCandidate(
      {
        tenant_id: ctx.tenant_id,
        candidate_id: candidateId,
        actor_id: null,
        expected_review_digest: preview.review_digest,
      },
      db,
    );
    if (!applied) throw new Error("expected an applied version");
    expect(applied).not.toBe(before);
    expect(await specOf(applied)).toEqual(SPEC);
  });
});
