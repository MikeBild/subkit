import { afterAll, beforeAll, describe, expect, test } from "bun:test";
import { and, desc, eq } from "drizzle-orm";
import type { PgBoss } from "pg-boss";
import { auditLog } from "../../db/schema/audit.ts";
import {
  events,
  patchCandidates,
  workflowAutohealPolicies,
  workflowVersions,
} from "../../db/schema/index.ts";
import { createBoss, disposeBoss } from "../../queue/boss.ts";
import {
  enqueueRepair,
  registerWorkflowRepairHandler,
} from "../../queue/handlers/workflow-repair.ts";
import { getTestNow } from "../../test-helpers/determinism/clock.ts";
import { runSelfHealingLoop } from "../service.ts";
import {
  createSelfHealingCtx,
  resetSeedDag,
  SEED_STEP_ID,
  type SelfHealingTestCtx,
} from "./setup.ts";

const TEST_NOW_MS = getTestNow();

let ctx: SelfHealingTestCtx;

beforeAll(async () => {
  ctx = await createSelfHealingCtx("loop");
});

afterAll(async () => {
  await ctx.cleanup();
});

describe("self-healing/loop — direct call", () => {
  test("drift -> repair -> classify -> dry-run -> auto-apply safe patch", async () => {
    const db = ctx.testDb.db;

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

    expect(result.drift_detected).toBe(true);
    expect(result.drift_signal?.kind).toBe("http_status_new_shape");
    expect(result.classification).toBe("safe");
    expect(result.dry_run_passed).toBe(true);
    expect(result.auto_applied).toBe(true);
    expect(result.patch_candidate_id).toBeTruthy();

    const candidateRows = await db
      .select()
      .from(patchCandidates)
      .where(eq(patchCandidates.id, result.patch_candidate_id!));
    expect(candidateRows.length).toBe(1);
    const cand = candidateRows[0];
    if (!cand) throw new Error("candidate missing");
    expect(cand.status).toBe("applied");
    expect(cand.classification).toBe("safe");
    expect(cand.fixture_id).toBe(ctx.fixture_id);

    const versions = await db
      .select()
      .from(workflowVersions)
      .where(eq(workflowVersions.workflow_id, ctx.workflow_id))
      .orderBy(desc(workflowVersions.version));
    expect(versions.length).toBe(2);
    expect(versions[0]?.version).toBe(2);
    const newDag = (versions[0]!.dag as Record<string, unknown>) ?? {};
    const steps = newDag.steps as Record<string, unknown>[];
    expect(steps.find((s) => s.id === SEED_STEP_ID)?.data_selector).toBe("data.result.id");
    expect(newDag.__self_healing).toMatchObject({
      step_id: SEED_STEP_ID,
      changed_paths: ["data_selector"],
    });

    const audits = await db
      .select()
      .from(auditLog)
      .where(
        and(
          eq(auditLog.tenant_id, ctx.tenant_id),
          eq(auditLog.resource_id, result.patch_candidate_id!),
        ),
      );
    const actions = audits.map((a) => a.action).sort();
    expect(actions).toContain("patch_candidate.proposed");
    expect(actions).toContain("patch_candidate.auto_applied");

    const evt = await db
      .select()
      .from(events)
      .where(eq(events.tenant_id, ctx.tenant_id))
      .orderBy(desc(events.id));
    const proposed = evt.find((e) => e.type === "patch.proposed");
    expect(proposed).toBeTruthy();
    if (proposed) {
      const payload = proposed.payload as Record<string, unknown>;
      expect(payload.patch_candidate_id).toBe(result.patch_candidate_id);
      expect(payload.classification).toBe("safe");
    }
  });

  test("never-auto policy parks the patch even when safe + dry-run passes", async () => {
    const db = ctx.testDb.db;

    await resetSeedDag(ctx);
    await db
      .insert(workflowAutohealPolicies)
      .values({
        tenant_id: ctx.tenant_id,
        workflow_id: ctx.workflow_id,
        policy: "never-auto",
      })
      .onConflictDoUpdate({
        target: [workflowAutohealPolicies.workflow_id],
        set: { policy: "never-auto", updated_at: new Date(TEST_NOW_MS) },
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
    expect(result.drift_detected).toBe(true);
    expect(result.auto_applied).toBe(false);

    const rows = await db
      .select()
      .from(patchCandidates)
      .where(eq(patchCandidates.id, result.patch_candidate_id!));
    expect(rows[0]?.status).toBe("proposed");

    await db
      .delete(workflowAutohealPolicies)
      .where(eq(workflowAutohealPolicies.workflow_id, ctx.workflow_id));
  });
});

describe("self-healing/loop — workflow.repair queue", () => {
  let boss: PgBoss;
  beforeAll(async () => {
    boss = await createBoss({ connectionString: ctx.testDb.url });
    await registerWorkflowRepairHandler({ boss, db: ctx.testDb.db });
  });
  afterAll(async () => {
    await disposeBoss(boss);
  });

  test("enqueue -> worker consumes -> same-fingerprint candidate refreshed, not duplicated", async () => {
    const db = ctx.testDb.db;
    const before = await db
      .select()
      .from(patchCandidates)
      .where(eq(patchCandidates.tenant_id, ctx.tenant_id));
    const countBefore = before.length;
    const openBefore = before
      .filter((c) => c.status === "proposed")
      .sort((a, b) => b.updated_at.getTime() - a.updated_at.getTime())[0];
    if (!openBefore) throw new Error("expected an open candidate from the never-auto test");

    const jobId = await enqueueRepair(boss, {
      tenant_id: ctx.tenant_id,
      workflow_id: ctx.workflow_id,
      execution_id: ctx.execution_id,
      step_id: ctx.step_id,
      connector_id: ctx.connector_id,
      endpoint_key: ctx.endpoint_key,
    });
    expect(jobId).toBeTruthy();

    // allow-wall-clock: this test exercises real-time polling or freshness windows.
    const deadline = Date.now() + 15_000;
    let touched = false;
    // allow-wall-clock: this test exercises real-time polling or freshness windows.
    while (Date.now() < deadline) {
      const row = (
        await db.select().from(patchCandidates).where(eq(patchCandidates.id, openBefore.id))
      )[0];
      if (
        row &&
        (row.status !== "proposed" || row.updated_at.getTime() > openBefore.updated_at.getTime())
      ) {
        touched = true;
        break;
      }
      await new Promise((r) => setTimeout(r, 100)); // allow-wall-clock: self-healing loop debounce window before patch-candidate emission
    }
    expect(touched).toBe(true);

    const after = await db
      .select()
      .from(patchCandidates)
      .where(eq(patchCandidates.tenant_id, ctx.tenant_id));
    expect(after.length).toBe(countBefore);
  });
});
