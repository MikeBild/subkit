import { afterAll, beforeAll, describe, expect, test } from "bun:test";
import { eq, sql } from "drizzle-orm";
import { createDeterministicUuidFactory } from "../../test-helpers/determinism/ids.ts";
import { seedTenant } from "../../test-helpers/seed.ts";
import { taskRuns, tasks } from "../schema/index.ts";
import { createTestDb, type TestDb } from "../tests/setup.ts";
import { EMBEDDED_MIGRATIONS, type EmbeddedMigration } from "./embedded.ts";

const nextUuid = createDeterministicUuidFactory(0x7e08);

const TAG = "0008_task_run_progress_marks";
const FINGERPRINT = "c".repeat(64);

let ctx: TestDb;
let tenantId: string;

beforeAll(async () => {
  ctx = await createTestDb("task-run-progress-marks-migration");
  tenantId = (await seedTenant(ctx.db, { slug: "progress-marks", display_name: "Marks" })).id;
}, 120_000);

afterAll(async () => {
  await ctx?.cleanup();
}, 30_000);

function migration(): EmbeddedMigration {
  const found = EMBEDDED_MIGRATIONS.find((item) => item.tag === TAG);
  if (!found) throw new Error(`${TAG} missing from the embedded bundle`);
  return found;
}

async function insertRun(): Promise<string> {
  const [task] = await ctx.db
    .insert(tasks)
    .values({
      tenant_id: tenantId,
      name: `Report ${nextUuid()}`,
      owner_id: nextUuid(),
      goal: "Send the weekly report",
      done_when: "The report is in the inbox",
      plan: { title: "Report", goal: "Send the weekly report", steps: [] },
      bindings: { workflow_ids: [], connector_ids: [], skill_slugs: [], web_search: false },
      environment: "prod",
      fingerprint: FINGERPRINT,
    })
    .returning({ id: tasks.id });
  if (!task) throw new Error("task insert returned no row");
  const [run] = await ctx.db
    .insert(taskRuns)
    .values({
      tenant_id: tenantId,
      task_id: task.id,
      task_revision: 1,
      fingerprint: FINGERPRINT,
      trigger: "manual",
      state: "completed",
      deadline_at: sql`clock_timestamp() + interval '4 hours'`,
      trace_id: "d".repeat(32),
    })
    .returning({ id: taskRuns.id });
  if (!run) throw new Error("task run insert returned no row");
  return run.id;
}

describe(TAG, () => {
  test("it follows the tasks migration and only alters task_runs", () => {
    expect(migration().idx).toBe(8);
    expect(migration().statements).toHaveLength(3);
    for (const statement of migration().statements)
      expect(statement).toStartWith('ALTER TABLE "task_runs" ');
  });

  test("a run starts with no marks, keeps the ones written and refuses anything but a list", async () => {
    const id = await insertRun();
    const marks = async () =>
      (
        await ctx.db
          .select({ marks: taskRuns.progress_marks })
          .from(taskRuns)
          .where(eq(taskRuns.id, id))
      )[0]?.marks;
    expect(await marks()).toEqual([]);
    await ctx.db
      .update(taskRuns)
      .set({ progress_marks: ["ready:1"] })
      .where(eq(taskRuns.id, id));
    expect(await marks()).toEqual(["ready:1"]);
    const refused = await ctx.pool
      .query("UPDATE subkit.task_runs SET progress_marks = '{}'::jsonb WHERE id = $1", [id])
      .then(
        () => null,
        (error: { constraint?: string }) => error.constraint,
      );
    expect(refused).toBe("task_runs_progress_marks_check");
    expect(await marks()).toEqual(["ready:1"]);
  });

  test("running it again changes nothing and keeps the stored marks", async () => {
    const id = await insertRun();
    await ctx.db
      .update(taskRuns)
      .set({ progress_marks: ["result:a"] })
      .where(eq(taskRuns.id, id));
    for (let pass = 0; pass < 2; pass++)
      await ctx.db.transaction(async (tx) => {
        for (const statement of migration().statements) await tx.execute(sql.raw(statement));
      });
    const [row] = await ctx.db
      .select({ marks: taskRuns.progress_marks })
      .from(taskRuns)
      .where(eq(taskRuns.id, id));
    expect(row?.marks).toEqual(["result:a"]);
    const checks = await ctx.pool.query(
      "SELECT count(*)::int AS n FROM pg_constraint WHERE conname = 'task_runs_progress_marks_check'",
    );
    expect(checks.rows).toEqual([{ n: 1 }]);
  });
});
