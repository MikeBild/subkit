// approvePatchCandidate / rejectPatchCandidate tests.
//
// The loop test covers the auto-apply happy path. The two reviewer
// helpers (manual approve / manual reject) are routed via HTTP at
// http/routes/patch-candidates.ts but had no direct service-level
// coverage. This file pins:
//
//   - approve writes a workflow_versions row, flips the candidate to
//     applied, and emits patch_candidate.approved audit
//   - reject flips the candidate to rejected and emits
//     patch_candidate.rejected audit (with the reason if supplied)
//   - both helpers are tenant-scoped: a wrong-tenant call returns
//     null/false without touching the row
//   - approve refuses already-applied or already-rejected candidates
//   - reject refuses already-applied or already-rejected candidates

import { afterAll, beforeAll, describe, expect, test } from "bun:test";
import { and, eq } from "drizzle-orm";
import { auditLog } from "../../db/schema/audit.ts";
import {
  patchCandidates,
  workflowAutohealPolicies,
  workflows,
  workflowVersions,
} from "../../db/schema/index.ts";
import { FROZEN_NOW } from "../../test-helpers/determinism/clock.ts";
import { approvePatchCandidate, rejectPatchCandidate } from "../candidate-decision.ts";
import { previewPatchCandidate } from "../candidate-review.ts";
import { preparePatchCandidate } from "../prepare-candidate.ts";
import { runSelfHealingLoop } from "../service.ts";
import {
  createSelfHealingCtx,
  resetSeedDag,
  SEED_STEP_ID,
  type SelfHealingTestCtx,
} from "./setup.ts";

let ctx: SelfHealingTestCtx;

beforeAll(async () => {
  ctx = await createSelfHealingCtx("approve_reject");
}, 30_000);

afterAll(async () => {
  await ctx.cleanup();
}, 30_000);

async function seedProposedCandidate(): Promise<string> {
  // The loop's default policy auto-applies safe patches. We park the
  // proposal by switching the policy to never-auto, run the loop, and
  // get a candidate row in `proposed` state.
  //
  // Clean slate first: the reactive path dedups against active AND
  // terminal candidates by drift fingerprint, so a leftover row from a
  // previous test would be refreshed/skipped instead of freshly
  // proposed — every seed must start from zero candidates.
  await ctx.testDb.db
    .delete(patchCandidates)
    .where(eq(patchCandidates.workflow_id, ctx.workflow_id));
  // …and a workflow the patch can still change: an earlier approve rewrote
  // the step, and re-applying the same rewrite is correctly a no-op.
  await resetSeedDag(ctx);
  await ctx.testDb.db
    .insert(workflowAutohealPolicies)
    .values({
      tenant_id: ctx.tenant_id,
      workflow_id: ctx.workflow_id,
      policy: "never-auto",
    })
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
    ctx.testDb.db,
  );
  if (!result.patch_candidate_id) {
    throw new Error(`expected a candidate, got ${JSON.stringify(result)}`);
  }
  return result.patch_candidate_id;
}

describe("approvePatchCandidate", () => {
  test("preparation is inert and idempotent; approval activates exactly the reviewed version", async () => {
    const candidateId = await seedProposedCandidate();
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
    expect(await preparePatchCandidate(params, db)).toEqual(prepared);
    const [before] = await db.select().from(workflows).where(eq(workflows.id, ctx.workflow_id));
    expect(before?.current_version_id).toBe(preview.base_version_id);
    const [candidate] = await db
      .select()
      .from(patchCandidates)
      .where(eq(patchCandidates.id, candidateId));
    expect(candidate?.status).toBe("proposed");
    expect(
      await approvePatchCandidate(
        { ...params, prepared_version_id: prepared.workflow_version_id },
        db,
      ),
    ).toBe(prepared.workflow_version_id);
    const after = await previewPatchCandidate(ctx.tenant_id, candidateId, db);
    expect(after?.reviewable).toBe(false);
    expect(after?.review_reason).toBe("already_decided");
    const [workflow] = await db.select().from(workflows).where(eq(workflows.id, ctx.workflow_id));
    expect(workflow?.current_version_id).toBe(prepared.workflow_version_id);
  });

  test("stale review cannot change the workflow and the refusal is audited", async () => {
    const candidateId = await seedProposedCandidate();
    const db = ctx.testDb.db;
    await expect(
      approvePatchCandidate(
        {
          tenant_id: ctx.tenant_id,
          candidate_id: candidateId,
          actor_id: null,
          expected_review_digest: "0".repeat(64),
        },
        db,
      ),
    ).rejects.toThrow("review_changed");
    const [candidate] = await db
      .select()
      .from(patchCandidates)
      .where(eq(patchCandidates.id, candidateId));
    expect(candidate?.status).toBe("proposed");
    const rows = await db
      .select()
      .from(auditLog)
      .where(and(eq(auditLog.tenant_id, ctx.tenant_id), eq(auditLog.resource_id, candidateId)));
    expect(rows.some((row) => row.result === "error" && row.reason === "review_changed")).toBe(
      true,
    );
  });

  test("concurrent approvals create only one active version", async () => {
    const candidateId = await seedProposedCandidate();
    const db = ctx.testDb.db;
    const preview = await previewPatchCandidate(ctx.tenant_id, candidateId, db);
    if (!preview?.review_digest) throw new Error("expected executable preview");
    const params = {
      tenant_id: ctx.tenant_id,
      candidate_id: candidateId,
      actor_id: null,
      expected_review_digest: preview.review_digest,
    };
    const before = await db
      .select()
      .from(workflowVersions)
      .where(eq(workflowVersions.workflow_id, ctx.workflow_id));
    const results = await Promise.all([
      approvePatchCandidate(params, db),
      approvePatchCandidate(params, db),
    ]);
    expect(results.filter(Boolean)).toHaveLength(1);
    const after = await db
      .select()
      .from(workflowVersions)
      .where(eq(workflowVersions.workflow_id, ctx.workflow_id));
    expect(after).toHaveLength(before.length + 1);
  });

  test("flips status to applied, writes a new workflow_versions row, audits", async () => {
    const candidateId = await seedProposedCandidate();
    const db = ctx.testDb.db;

    const versionsBefore = await db
      .select()
      .from(workflowVersions)
      .where(eq(workflowVersions.workflow_id, ctx.workflow_id));

    const newVersionId = await approvePatchCandidate(
      { tenant_id: ctx.tenant_id, candidate_id: candidateId, actor_id: null },
      db,
    );
    expect(newVersionId).toBeTruthy();

    const versionsAfter = await db
      .select()
      .from(workflowVersions)
      .where(eq(workflowVersions.workflow_id, ctx.workflow_id));
    expect(versionsAfter.length).toBe(versionsBefore.length + 1);

    // The point of applying: the new version's step actually reads the new
    // path. A version that only carries an annotation heals nothing.
    const newVersion = (
      await db.select().from(workflowVersions).where(eq(workflowVersions.id, newVersionId!))
    )[0];
    if (!newVersion) throw new Error("new workflow version missing");
    const steps = (newVersion.dag as { steps: Record<string, unknown>[] }).steps;
    expect(steps.find((s) => s.id === SEED_STEP_ID)?.data_selector).toBe("data.result.id");

    // …and the workflow points at it, so the next run uses the repaired step.
    const wf = (await db.select().from(workflows).where(eq(workflows.id, ctx.workflow_id)))[0];
    expect(wf?.current_version_id).toBe(newVersionId!);

    const candidateAfter = (
      await db.select().from(patchCandidates).where(eq(patchCandidates.id, candidateId))
    )[0];
    expect(candidateAfter?.status).toBe("applied");

    const auditRows = await db
      .select()
      .from(auditLog)
      .where(
        and(eq(auditLog.resource_id, candidateId), eq(auditLog.action, "patch_candidate.approved")),
      );
    expect(auditRows.length).toBe(1);
    expect(auditRows[0]?.tenant_id).toBe(ctx.tenant_id);
  });

  test("a candidate with no step anchor is never recorded as applied", async () => {
    // The regression this guards: an approve that rotates a workflow version
    // carrying only an annotation. The candidate looks healed, the next run
    // behaves exactly as before, and the drift scan sees a fixed endpoint.
    const candidateId = await seedProposedCandidate();
    const db = ctx.testDb.db;

    const row = (
      await db.select().from(patchCandidates).where(eq(patchCandidates.id, candidateId))
    )[0];
    if (!row) throw new Error("candidate missing");
    const {
      step_id: _s,
      workflow_step_id: _w,
      ...anchorless
    } = row.diff as Record<string, unknown>;
    await db
      .update(patchCandidates)
      .set({ diff: anchorless })
      .where(eq(patchCandidates.id, candidateId));

    const versionsBefore = await db
      .select()
      .from(workflowVersions)
      .where(eq(workflowVersions.workflow_id, ctx.workflow_id));

    await expect(
      approvePatchCandidate(
        { tenant_id: ctx.tenant_id, candidate_id: candidateId, actor_id: null },
        db,
      ),
    ).rejects.toThrow("no_step_anchor");

    const versionsAfter = await db
      .select()
      .from(workflowVersions)
      .where(eq(workflowVersions.workflow_id, ctx.workflow_id));
    expect(versionsAfter.length).toBe(versionsBefore.length);

    // Still open for review — not silently closed as a repair that happened.
    const after = (
      await db.select().from(patchCandidates).where(eq(patchCandidates.id, candidateId))
    )[0];
    expect(after?.status).toBe("proposed");

    // The refusal is on the record, with the reason.
    const auditRows = await db
      .select()
      .from(auditLog)
      .where(
        and(eq(auditLog.resource_id, candidateId), eq(auditLog.action, "patch_candidate.approved")),
      );
    expect(auditRows.some((r) => r.result === "error" && r.reason === "no_step_anchor")).toBe(true);
  });

  test("returns null when the candidate is on a different tenant", async () => {
    const candidateId = await seedProposedCandidate();
    const result = await approvePatchCandidate(
      {
        tenant_id: "00000000-0000-0000-0000-00000000bbbb",
        candidate_id: candidateId,
        actor_id: null,
      },
      ctx.testDb.db,
    );
    expect(result).toBeNull();
  });

  test("returns null when the candidate is already applied", async () => {
    const candidateId = await seedProposedCandidate();
    // First approve goes through.
    await approvePatchCandidate(
      { tenant_id: ctx.tenant_id, candidate_id: candidateId, actor_id: null },
      ctx.testDb.db,
    );
    // Second approve must no-op (status is no longer `proposed`).
    const second = await approvePatchCandidate(
      { tenant_id: ctx.tenant_id, candidate_id: candidateId, actor_id: null },
      ctx.testDb.db,
    );
    expect(second).toBeNull();
  });

  test("returns null when the candidate id does not exist", async () => {
    const result = await approvePatchCandidate(
      {
        tenant_id: ctx.tenant_id,
        candidate_id: "11111111-1111-1111-1111-111111111111",
        actor_id: null,
      },
      ctx.testDb.db,
    );
    expect(result).toBeNull();
  });
});

describe("rejectPatchCandidate", () => {
  test("flips status to rejected, audits, returns true", async () => {
    const candidateId = await seedProposedCandidate();
    const db = ctx.testDb.db;
    const ok = await rejectPatchCandidate(
      {
        tenant_id: ctx.tenant_id,
        candidate_id: candidateId,
        actor_id: null,
        reason: "operator_review",
      },
      db,
    );
    expect(ok).toBe(true);

    const candidateAfter = (
      await db.select().from(patchCandidates).where(eq(patchCandidates.id, candidateId))
    )[0];
    expect(candidateAfter?.status).toBe("rejected");

    const auditRows = await db
      .select()
      .from(auditLog)
      .where(
        and(eq(auditLog.resource_id, candidateId), eq(auditLog.action, "patch_candidate.rejected")),
      );
    expect(auditRows.length).toBe(1);
    expect(auditRows[0]?.reason).toBe("operator_review");
  });

  test("returns false on cross-tenant attempt; row stays proposed", async () => {
    const candidateId = await seedProposedCandidate();
    const ok = await rejectPatchCandidate(
      {
        tenant_id: "00000000-0000-0000-0000-00000000aaaa",
        candidate_id: candidateId,
        actor_id: null,
      },
      ctx.testDb.db,
    );
    expect(ok).toBe(false);

    const candidateAfter = (
      await ctx.testDb.db.select().from(patchCandidates).where(eq(patchCandidates.id, candidateId))
    )[0];
    expect(candidateAfter?.status).toBe("proposed");
  });

  test("returns false when the candidate is already rejected", async () => {
    const candidateId = await seedProposedCandidate();
    const first = await rejectPatchCandidate(
      { tenant_id: ctx.tenant_id, candidate_id: candidateId, actor_id: null },
      ctx.testDb.db,
    );
    expect(first).toBe(true);
    const second = await rejectPatchCandidate(
      { tenant_id: ctx.tenant_id, candidate_id: candidateId, actor_id: null },
      ctx.testDb.db,
    );
    expect(second).toBe(false);
  });

  test("rejection without a reason omits the audit reason field", async () => {
    const candidateId = await seedProposedCandidate();
    await rejectPatchCandidate(
      { tenant_id: ctx.tenant_id, candidate_id: candidateId, actor_id: null },
      ctx.testDb.db,
    );
    const auditRows = await ctx.testDb.db
      .select()
      .from(auditLog)
      .where(
        and(eq(auditLog.resource_id, candidateId), eq(auditLog.action, "patch_candidate.rejected")),
      );
    expect(auditRows.length).toBe(1);
    // The optional reason field is absent (or null) when the caller
    // did not supply one.
    expect(auditRows[0]?.reason ?? null).toBeNull();
  });
});
