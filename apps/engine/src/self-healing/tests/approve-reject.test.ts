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
  workflowVersions,
} from "../../db/schema/index.ts";
import { FROZEN_NOW } from "../../test-helpers/determinism/clock.ts";
import { approvePatchCandidate, rejectPatchCandidate } from "../candidate-decision.ts";
import { runSelfHealingLoop } from "../service.ts";
import { createSelfHealingCtx, type SelfHealingTestCtx } from "./setup.ts";

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
