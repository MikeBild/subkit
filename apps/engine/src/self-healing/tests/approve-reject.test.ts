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
  await ctx.testDb.db
    .delete(patchCandidates)
    .where(eq(patchCandidates.workflow_id, ctx.workflow_id));
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
  test("preparation does not infer an actor type from an actor ID", async () => {
    const candidateId = await seedProposedCandidate();
    const db = ctx.testDb.db;
    const preview = await previewPatchCandidate(ctx.tenant_id, candidateId, db);
    if (!preview?.review_digest) throw new Error("expected executable preview");

    await preparePatchCandidate(
      {
        tenant_id: ctx.tenant_id,
        candidate_id: candidateId,
        actor_id: "10000000-0000-4000-8000-000000000004",
        expected_review_digest: preview.review_digest,
      },
      db,
    );

    const [audit] = await db
      .select()
      .from(auditLog)
      .where(
        and(
          eq(auditLog.tenant_id, ctx.tenant_id),
          eq(auditLog.action, "patch_candidate.prepared"),
          eq(auditLog.resource_id, candidateId),
        ),
      );
    expect(audit?.actor_type).toBe("unknown");
    expect(audit?.actor_id).toBeNull();
  });

  test("preparation is inert and idempotent; approval activates exactly the reviewed version", async () => {
    const candidateId = await seedProposedCandidate();
    const db = ctx.testDb.db;
    const preview = await previewPatchCandidate(ctx.tenant_id, candidateId, db);
    if (!preview?.review_digest) throw new Error("expected executable preview");
    const params = {
      tenant_id: ctx.tenant_id,
      candidate_id: candidateId,
      actor_id: "10000000-0000-4000-8000-000000000001",
      actor_type: "system_account" as const,
      expected_review_digest: preview.review_digest,
    };
    const prepared = await preparePatchCandidate(params, db);
    expect(await preparePatchCandidate(params, db)).toEqual(prepared);
    expect(
      await preparePatchCandidate(
        { ...params, actor_id: "10000000-0000-4000-8000-000000000002", actor_type: "user" },
        db,
      ),
    ).toEqual(prepared);
    const [authored] = await db
      .select()
      .from(workflowVersions)
      .where(
        and(
          eq(workflowVersions.tenant_id, ctx.tenant_id),
          eq(workflowVersions.id, prepared.workflow_version_id),
        ),
      );
    expect(authored?.author_system_account_id).toBe(params.actor_id);
    expect(authored?.author_user_id).toBeNull();
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
    const [approvalAudit] = await db
      .select()
      .from(auditLog)
      .where(
        and(
          eq(auditLog.tenant_id, ctx.tenant_id),
          eq(auditLog.resource_id, candidateId),
          eq(auditLog.action, "patch_candidate.approved"),
        ),
      );
    expect([approvalAudit?.actor_type, approvalAudit?.actor_id]).toEqual([
      "system_account",
      params.actor_id,
    ]);
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

    const newVersion = (
      await db.select().from(workflowVersions).where(eq(workflowVersions.id, newVersionId!))
    )[0];
    if (!newVersion) throw new Error("new workflow version missing");
    const steps = (newVersion.dag as { steps: Record<string, unknown>[] }).steps;
    expect(steps.find((s) => s.id === SEED_STEP_ID)?.data_selector).toBe("$.data.result.id");

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

    const after = (
      await db.select().from(patchCandidates).where(eq(patchCandidates.id, candidateId))
    )[0];
    expect(after?.status).toBe("inapplicable");
    expect(after?.closed_reason).toBe("no_step_anchor");

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
    await approvePatchCandidate(
      { tenant_id: ctx.tenant_id, candidate_id: candidateId, actor_id: null },
      ctx.testDb.db,
    );
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
        actor_id: "10000000-0000-4000-8000-000000000001",
        actor_type: "system_account",
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
    expect([auditRows[0]?.actor_type, auditRows[0]?.actor_id]).toEqual([
      "system_account",
      "10000000-0000-4000-8000-000000000001",
    ]);
  });

  test("audits an untyped non-null actor as unknown without an actor ID", async () => {
    const candidateId = await seedProposedCandidate();
    const actorId = "10000000-0000-4000-8000-000000000003";
    const db = ctx.testDb.db;

    expect(
      await rejectPatchCandidate(
        { tenant_id: ctx.tenant_id, candidate_id: candidateId, actor_id: actorId },
        db,
      ),
    ).toBe(true);
    const [auditRow] = await db
      .select()
      .from(auditLog)
      .where(
        and(
          eq(auditLog.tenant_id, ctx.tenant_id),
          eq(auditLog.resource_id, candidateId),
          eq(auditLog.action, "patch_candidate.rejected"),
        ),
      );
    expect([auditRow?.actor_type, auditRow?.actor_id]).toEqual(["unknown", null]);
  });

  test("keeps the candidate proposed when its rejection audit cannot persist", async () => {
    const candidateId = await seedProposedCandidate();
    const db = ctx.testDb.db;

    await expect(
      rejectPatchCandidate(
        {
          tenant_id: ctx.tenant_id,
          candidate_id: candidateId,
          actor_id: "10000000-0000-4000-8000-000000000009",
          actor_type: "invalid" as never,
        },
        db,
      ),
    ).rejects.toThrow();

    const [candidate] = await db
      .select({ status: patchCandidates.status })
      .from(patchCandidates)
      .where(eq(patchCandidates.id, candidateId));
    expect(candidate?.status).toBe("proposed");
    const [audit] = await db
      .select({ id: auditLog.id })
      .from(auditLog)
      .where(
        and(
          eq(auditLog.tenant_id, ctx.tenant_id),
          eq(auditLog.action, "patch_candidate.rejected"),
          eq(auditLog.resource_id, candidateId),
        ),
      );
    expect(audit).toBeUndefined();
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
    expect(auditRows[0]?.reason ?? null).toBeNull();
  });
});
