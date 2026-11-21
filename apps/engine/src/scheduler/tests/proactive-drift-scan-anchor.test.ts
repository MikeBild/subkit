import { afterAll, beforeAll, describe, expect, test } from "bun:test";
import { and, desc, eq, inArray, sql } from "drizzle-orm";
import { AuditAction } from "../../audit/index.ts";
import {
  auditLog,
  patchCandidates,
  schemaVersions,
  selfHealingScans,
} from "../../db/schema/index.ts";
import { driftSignalContext } from "../../self-healing/proactive-scanner.ts";
import { runProactiveDriftScanForTenant } from "../../self-healing/scheduled/proactive-drift-scan-runner.ts";
import {
  createSelfHealingCtx,
  SEED_STEP_ID,
  type SelfHealingTestCtx,
} from "../../self-healing/tests/setup.ts";
import { getTestNow } from "../../test-helpers/determinism/clock.ts";

let ctx: SelfHealingTestCtx;

beforeAll(async () => {
  ctx = await createSelfHealingCtx("drift_anchor");
}, 60_000);

afterAll(async () => {
  await ctx.cleanup();
}, 30_000);

describe("proactive drift scan", () => {
  test("a failed signal marks the scan and completion audit failed", async () => {
    const isolated = await createSelfHealingCtx("drift_signal_failure");
    try {
      const now = getTestNow();
      await isolated.testDb.db.insert(schemaVersions).values([
        {
          tenant_id: isolated.tenant_id,
          connector_id: isolated.connector_id,
          workflow_id: isolated.workflow_id,
          step_id: SEED_STEP_ID,
          endpoint_key: "GET /users/1",
          schema: { type: "object", properties: { data: { type: "object" } } },
          seen_at: new Date(now - 60_000),
        },
        {
          tenant_id: isolated.tenant_id,
          connector_id: isolated.connector_id,
          workflow_id: isolated.workflow_id,
          step_id: SEED_STEP_ID,
          endpoint_key: "GET /users/1",
          schema: { type: "object", properties: { data: { type: "string" } } },
          seen_at: new Date(now),
        },
      ]);
      await isolated.testDb.db.execute(
        sql.raw(`CREATE FUNCTION refuse_patch_candidate() RETURNS trigger AS $$
        BEGIN RAISE EXCEPTION 'candidate insertion refused for test'; END $$ LANGUAGE plpgsql`),
      );
      await isolated.testDb.db.execute(
        sql.raw(`CREATE TRIGGER refuse_patch_candidate BEFORE INSERT ON patch_candidates
          FOR EACH ROW EXECUTE FUNCTION refuse_patch_candidate()`),
      );
      await runProactiveDriftScanForTenant(isolated.tenant_id, new Date(now), isolated.testDb.db);
      const [scan] = await isolated.testDb.db
        .select()
        .from(selfHealingScans)
        .where(eq(selfHealingScans.tenant_id, isolated.tenant_id));
      expect(scan?.signals_detected).toBeGreaterThan(0);
      expect(scan?.status).toBe("failed");
      expect(scan?.error).toContain("drift signal(s) failed");
      const [completed] = await isolated.testDb.db
        .select({ result: auditLog.result })
        .from(auditLog)
        .where(
          and(
            eq(auditLog.tenant_id, isolated.tenant_id),
            eq(auditLog.action, AuditAction.SELF_HEALING_SCAN_COMPLETED),
          ),
        );
      expect(completed?.result).toBe("error");
    } finally {
      await isolated.cleanup();
    }
  });

  test("carries the definition anchor into the candidate it creates", async () => {
    const endpoint_key = "GET /users/1";
    const now = getTestNow();
    const older = new Date(now - 60_000);
    await ctx.testDb.db.insert(schemaVersions).values({
      tenant_id: ctx.tenant_id,
      connector_id: ctx.connector_id,
      endpoint_key,
      workflow_id: ctx.workflow_id,
      step_id: SEED_STEP_ID,
      schema: { type: "object", properties: { data: { type: "object", properties: {} } } },
      seen_at: older,
    });
    await ctx.testDb.db.insert(schemaVersions).values({
      tenant_id: ctx.tenant_id,
      connector_id: ctx.connector_id,
      endpoint_key,
      workflow_id: ctx.workflow_id,
      step_id: SEED_STEP_ID,
      schema: { type: "object", properties: { data: { type: "string" } } },
      seen_at: new Date(now),
    });

    await runProactiveDriftScanForTenant(ctx.tenant_id, new Date(now), ctx.testDb.db);

    const scanAudit = await ctx.testDb.db
      .select({
        action: auditLog.action,
        actor_type: auditLog.actor_type,
        actor_id: auditLog.actor_id,
        resource_id: auditLog.resource_id,
      })
      .from(auditLog)
      .where(
        and(
          eq(auditLog.tenant_id, ctx.tenant_id),
          inArray(auditLog.action, [
            AuditAction.SELF_HEALING_SCAN_TRIGGERED,
            AuditAction.SELF_HEALING_SCAN_COMPLETED,
          ]),
        ),
      );
    expect(scanAudit).toHaveLength(2);
    expect(
      Object.fromEntries(
        scanAudit.map(({ action, actor_type, actor_id }) => [action, { actor_type, actor_id }]),
      ),
    ).toEqual({
      [AuditAction.SELF_HEALING_SCAN_TRIGGERED]: { actor_type: "system", actor_id: null },
      [AuditAction.SELF_HEALING_SCAN_COMPLETED]: { actor_type: "system", actor_id: null },
    });
    expect(scanAudit[0]?.resource_id).toBe(scanAudit[1]?.resource_id);

    const rows = await ctx.testDb.db
      .select({ diff: patchCandidates.diff })
      .from(patchCandidates)
      .where(
        and(
          eq(patchCandidates.tenant_id, ctx.tenant_id),
          eq(patchCandidates.workflow_id, ctx.workflow_id),
        ),
      )
      .orderBy(desc(patchCandidates.created_at))
      .limit(1);
    const diff = rows[0]?.diff as Record<string, unknown> | undefined;
    expect(diff).toBeDefined();
    expect(diff?.step_id).toBeNull();
    expect(diff?.workflow_step_id).toBe(SEED_STEP_ID);
  }, 90_000);

  test("the shared translation carries every anchor a caller may hold", () => {
    const context = driftSignalContext(
      {
        tenant_id: "t",
        workflow_id: "w",
        execution_id: null,
        step_id: null,
        workflow_step_id: SEED_STEP_ID,
        connector_id: "c",
        endpoint_key: "GET /users/1",
        repair_input: { failing_step_id: "proactive:schema_diff" },
      },
      { actor_id: null, actor_type: "system", source: "proactive_admin", scan_id: "s" },
    );
    expect(context.workflow_step_id).toBe(SEED_STEP_ID);
    expect(context.connector_id).toBe("c");
    expect(context.endpoint_key).toBe("GET /users/1");
    expect(context.repair_input.failing_step_id).toBe("proactive:schema_diff");
  });

  test("a signal without a definition anchor omits the field rather than nulling it", () => {
    const context = driftSignalContext(
      {
        tenant_id: "t",
        workflow_id: "w",
        execution_id: null,
        step_id: null,
        repair_input: { failing_step_id: "proactive:stdlib" },
      },
      { actor_id: null, actor_type: "system", source: "proactive_scheduler", scan_id: "s" },
    );
    expect("workflow_step_id" in context).toBe(false);
  });
});
