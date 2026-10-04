import { afterAll, beforeAll, expect, test } from "bun:test";
import { and, eq, sql } from "drizzle-orm";
import {
  patchCandidates,
  selfHealingScans,
  workflows,
  workflowVersions,
} from "../../db/schema/index.ts";
import { runProactiveDriftScanForTenant } from "../../scheduler/proactive-drift-scan-runner.ts";
import { getTestNow } from "../../test-helpers/determinism/clock.ts";
import { lockWorkflowForVersionWrite } from "../../workflows/version-write-lock.ts";
import { sweepUndecidableCandidates } from "../open-decisions.ts";
import { createSelfHealingCtx, SEED_STEP_ID, type SelfHealingTestCtx } from "./setup.ts";

let ctx: SelfHealingTestCtx;

beforeAll(async () => {
  ctx = await createSelfHealingCtx("sweep_isolation");
});

afterAll(async () => {
  await ctx.cleanup();
});

function dag(dataSelector: string) {
  return {
    steps: [
      {
        kind: "request",
        id: SEED_STEP_ID,
        method: "GET",
        connector_id: ctx.connector_id,
        path: "/users/1",
        data_selector: dataSelector,
      },
    ],
  };
}

async function saveVersion(
  exec: typeof ctx.testDb.db,
  version: number,
  dataSelector: string,
): Promise<string> {
  const [ver] = await exec
    .insert(workflowVersions)
    .values({
      tenant_id: ctx.tenant_id,
      workflow_id: ctx.workflow_id,
      version,
      dag: dag(dataSelector),
    })
    .returning();
  await exec
    .update(workflows)
    .set({ current_version_id: ver!.id })
    .where(and(eq(workflows.tenant_id, ctx.tenant_id), eq(workflows.id, ctx.workflow_id)));
  return ver!.id;
}

async function proposeMove(): Promise<string> {
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
  return row!.id;
}

async function statusOf(id: string) {
  const [row] = await ctx.testDb.db
    .select()
    .from(patchCandidates)
    .where(eq(patchCandidates.id, id));
  return row?.status;
}

test("readiness is read under the workflow lock, against the version current when it is taken", async () => {
  await saveVersion(ctx.testDb.db, 2, "data.result.id");
  const candidateId = await proposeMove();

  let release!: () => void;
  const gate = new Promise<void>((resolve) => {
    release = resolve;
  });
  let held!: () => void;
  const lockHeld = new Promise<void>((resolve) => {
    held = resolve;
  });
  const save = ctx.testDb.db.transaction(async (tx) => {
    await lockWorkflowForVersionWrite(tx, ctx.tenant_id, ctx.workflow_id);
    held();
    await gate;
    await saveVersion(tx as unknown as typeof ctx.testDb.db, 3, "data.id");
  });
  await lockHeld;

  let settled = false;
  const sweep = sweepUndecidableCandidates(ctx.testDb.db, ctx.tenant_id).finally(() => {
    settled = true;
  });
  for (let i = 0; i < 2000 && !settled; i++) {
    const rows = await ctx.testDb.db.execute(
      sql`SELECT count(*)::int AS n FROM pg_stat_activity
           WHERE datname = current_database() AND wait_event_type = 'Lock'`,
    );
    const n =
      ((rows as unknown as { rows?: { n: number }[] }).rows ??
        (rows as unknown as { n: number }[]))[0]?.n ?? 0;
    if (n > 0) break;
  }
  release();
  await save;
  await sweep;

  expect(await statusOf(candidateId)).toBe("proposed");
});

test("a row whose close fails is skipped, the rest close, and the drift scan still succeeds", async () => {
  await saveVersion(ctx.testDb.db, 4, "data.result.id");
  const bad = await proposeMove();
  const good = await proposeMove();
  await ctx.testDb.db.execute(
    sql.raw(`CREATE FUNCTION refuse_close_for_test() RETURNS trigger AS $$
      BEGIN
        IF NEW.status = 'inapplicable' AND NEW.id = '${bad}' THEN
          RAISE EXCEPTION 'close refused for test';
        END IF;
        RETURN NEW;
      END $$ LANGUAGE plpgsql`),
  );
  await ctx.testDb.db.execute(
    sql.raw(`CREATE TRIGGER refuse_close_for_test BEFORE UPDATE ON patch_candidates
      FOR EACH ROW EXECUTE FUNCTION refuse_close_for_test()`),
  );
  try {
    await runProactiveDriftScanForTenant(ctx.tenant_id, new Date(getTestNow()), ctx.testDb.db);

    expect(await statusOf(bad)).toBe("proposed");
    expect(await statusOf(good)).toBe("inapplicable");
    const scans = await ctx.testDb.db
      .select()
      .from(selfHealingScans)
      .where(eq(selfHealingScans.tenant_id, ctx.tenant_id));
    expect(scans).toHaveLength(1);
    expect(scans[0]?.status).toBe("succeeded");
  } finally {
    await ctx.testDb.db.execute(sql.raw("DROP TRIGGER refuse_close_for_test ON patch_candidates"));
    await ctx.testDb.db.execute(sql.raw("DROP FUNCTION refuse_close_for_test()"));
  }
});
