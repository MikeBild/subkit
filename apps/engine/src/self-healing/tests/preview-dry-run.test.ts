import { afterAll, beforeAll, describe, expect, test } from "bun:test";
import { and, eq } from "drizzle-orm";
import { auditLog } from "../../db/schema/audit.ts";
import { patchCandidates, workflowAutohealPolicies } from "../../db/schema/index.ts";
import { EngineClient } from "../../engine-client/index.ts";
import { FROZEN_NOW } from "../../test-helpers/determinism/clock.ts";
import { dryRunPatchCandidate, previewPatchCandidate } from "../candidate-review.ts";
import { diffStepPaths } from "../patch-apply.ts";
import { runSelfHealingLoop } from "../service.ts";
import {
  createSelfHealingCtx,
  SEED_DATA_SELECTOR,
  SEED_STEP_ID,
  type SelfHealingTestCtx,
} from "./setup.ts";

let ctx: SelfHealingTestCtx;
let candidateId: string;

beforeAll(async () => {
  ctx = await createSelfHealingCtx("preview_dry_run");
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
  candidateId = result.patch_candidate_id;
}, 60_000);

afterAll(async () => {
  await ctx.cleanup();
}, 30_000);

describe("diffStepPaths", () => {
  test("flags only the keys that changed, sorted", () => {
    const before = { id: "s1", kind: "request" as const, data_selector: "$.data.id" };
    const after = { id: "s1", kind: "request" as const, data_selector: "$.data.result.id" };
    expect(diffStepPaths(before, after)).toEqual(["data_selector"]);
  });
  test("identical steps yield no paths", () => {
    const step = {
      id: "s1",
      kind: "transform" as const,
      expression: "return input.scope.s0.data.x;",
    };
    expect(diffStepPaths(step, { ...step })).toEqual([]);
  });
});

describe("previewPatchCandidate", () => {
  test("renders before/after + changed_paths + drift summary", async () => {
    const preview = await previewPatchCandidate(ctx.tenant_id, candidateId, ctx.testDb.db);
    expect(preview).not.toBeNull();
    expect(preview!.candidate_id).toBe(candidateId);
    expect(preview!.workflow_id).toBe(ctx.workflow_id);
    expect(preview!.status).toBe("proposed");
    expect(preview!.proposal).not.toBeNull();
    expect(typeof preview!.drift_summary).toBe("string");
    expect(preview!.before_step?.data_selector).toBe("$.data.id");
    expect(preview!.after_step?.data_selector).toBe("$.data.result.id");
    expect(preview!.changed_paths).toEqual(["data_selector"]);
  });

  test("a candidate found by a scan previews from its definition anchor", async () => {
    const [row] = await ctx.testDb.db
      .insert(patchCandidates)
      .values({
        tenant_id: ctx.tenant_id,
        workflow_id: ctx.workflow_id,
        classification: "safe",
        status: "proposed",
        diff: {
          drift_diff: "kind: schema_diff\nwidened: data.id",
          step_id: null,
          workflow_step_id: SEED_STEP_ID,
          proposal: {
            classification: "safe",
            kind: "update_field_path",
            description: "Follow the renamed field",
            patch: { path: "data.id", value: "data.result.id" },
            reasoning: "the response moved the id under result",
          },
        },
      })
      .returning();
    if (!row) throw new Error("candidate insert failed");

    const preview = await previewPatchCandidate(ctx.tenant_id, row.id, ctx.testDb.db);
    expect(preview!.before_step?.data_selector).toBe(SEED_DATA_SELECTOR);
    expect(preview!.after_step?.data_selector).toBe("$.data.result.id");
    expect(preview!.changed_paths).toEqual(["data_selector"]);
  });

  test("wrong tenant sees null", async () => {
    const preview = await previewPatchCandidate(
      "00000000-0000-0000-0000-000000000000",
      candidateId,
      ctx.testDb.db,
    );
    expect(preview).toBeNull();
  });
});

describe("dryRunPatchCandidate", () => {
  test("persists an actor-id-only caller as unknown without an actor ID", async () => {
    const outcome = await dryRunPatchCandidate(
      {
        tenant_id: ctx.tenant_id,
        candidate_id: candidateId,
        actor_id: "10000000-0000-4000-8000-000000000003",
      },
      ctx.testDb.db,
    );
    expect(outcome.status).toBe("ran");

    const [audit] = await ctx.testDb.db
      .select()
      .from(auditLog)
      .where(
        and(
          eq(auditLog.tenant_id, ctx.tenant_id),
          eq(auditLog.action, "patch_candidate.dry_run_requested"),
          eq(auditLog.resource_id, candidateId),
        ),
      );
    expect(audit?.actor_type).toBe("unknown");
    expect(audit?.actor_id).toBeNull();
  });

  test("replays without mutating status and writes an audit row", async () => {
    const outcome = await dryRunPatchCandidate(
      { tenant_id: ctx.tenant_id, candidate_id: candidateId, actor_id: null },
      ctx.testDb.db,
    );
    expect(outcome.status).toBe("ran");
    if (outcome.status === "ran") {
      expect(typeof outcome.ok).toBe("boolean");
      expect(["recorded", "synthesized"]).toContain(outcome.fixture_source);
    }

    const rows = await ctx.testDb.db
      .select()
      .from(patchCandidates)
      .where(eq(patchCandidates.id, candidateId));
    expect(rows[0]?.status).toBe("proposed");

    const audits = await ctx.testDb.db
      .select()
      .from(auditLog)
      .where(
        and(
          eq(auditLog.action, "patch_candidate.dry_run_requested"),
          eq(auditLog.resource_id, candidateId),
        ),
      );
    expect(audits.length).toBeGreaterThan(0);
  });

  test("EngineClient dry runs retain the typed system-account actor", async () => {
    const accountId = "20000000-0000-4000-8000-000000000003";
    const client = new EngineClient({
      tenant_id: ctx.tenant_id,
      actor_id: accountId,
      actor_type: "system_account",
      db: ctx.testDb.db,
    });

    const outcome = await client.patchCandidates.dryRun(candidateId);
    expect(outcome.status).toBe("ran");

    const [audit] = await ctx.testDb.db
      .select({ actor_type: auditLog.actor_type, actor_id: auditLog.actor_id })
      .from(auditLog)
      .where(
        and(
          eq(auditLog.action, "patch_candidate.dry_run_requested"),
          eq(auditLog.resource_id, candidateId),
          eq(auditLog.actor_id, accountId),
        ),
      )
      .limit(1);
    expect(audit).toEqual({ actor_type: "system_account", actor_id: accountId });
  });

  test("falls back to a synthesized fixture when fixture_id is null", async () => {
    await ctx.testDb.db
      .update(patchCandidates)
      .set({ fixture_id: null })
      .where(eq(patchCandidates.id, candidateId));
    const outcome = await dryRunPatchCandidate(
      { tenant_id: ctx.tenant_id, candidate_id: candidateId, actor_id: null },
      ctx.testDb.db,
    );
    expect(outcome.status).toBe("ran");
    if (outcome.status === "ran") {
      expect(outcome.fixture_source).toBe("synthesized");
    }
  });

  test("wrong tenant sees not_found", async () => {
    const outcome = await dryRunPatchCandidate(
      {
        tenant_id: "00000000-0000-0000-0000-000000000000",
        candidate_id: candidateId,
        actor_id: null,
      },
      ctx.testDb.db,
    );
    expect(outcome.status).toBe("not_found");
  });
});
