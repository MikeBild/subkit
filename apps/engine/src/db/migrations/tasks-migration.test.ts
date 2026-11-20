import { afterAll, beforeAll, describe, expect, test } from "bun:test";
import { eq, sql } from "drizzle-orm";
import { provisionSelfServiceTenant } from "../../identity/self-service.ts";
import { createDeterministicUuidFactory } from "../../test-helpers/determinism/ids.ts";
import { configureHostedPolicyForTests } from "../../test-helpers/hosted-policy.ts";
import { seedConversation, seedTenant } from "../../test-helpers/seed.ts";
import { TEST_WORKSPACE_REGISTRATION } from "../../test-helpers/workspace-registration.ts";
import {
  conversations,
  hostedTenantUsage,
  schedulerSweepCursors,
  schedulerSweepProducerEnum,
  taskGrants,
  taskRuns,
  tasks,
} from "../schema/index.ts";
import { createTestDb, type TestDb } from "../tests/setup.ts";
import { EMBEDDED_MIGRATIONS, type EmbeddedMigration } from "./embedded.ts";

const nextUuid = createDeterministicUuidFactory(0x7e07);

const TAG = "0007_tasks";
const FINGERPRINT = "c".repeat(64);
const TRACE = "d".repeat(32);
const EARLIER_PRODUCERS = schedulerSweepProducerEnum.enumValues.filter((value) => value !== "task");
const RUN_STATES = [
  "running",
  "waiting",
  "sleeping",
  "result_ready",
  "completed",
  "aborted",
  "failed",
] as const;
type RunState = (typeof RUN_STATES)[number];

let ctx: TestDb;
let tenantId: string;

beforeAll(async () => {
  ctx = await createTestDb("tasks-migration");
  await configureHostedPolicyForTests(ctx.db, ctx.url);
  tenantId = (await seedTenant(ctx.db, { slug: "tasks-migration", display_name: "Tasks" })).id;
}, 120_000);

afterAll(async () => {
  await ctx?.cleanup();
}, 30_000);

function migration(): EmbeddedMigration {
  const found = EMBEDDED_MIGRATIONS.find((item) => item.tag === TAG);
  if (!found) throw new Error(`${TAG} missing from the embedded bundle`);
  return found;
}

async function runStatements(include: (statement: string) => boolean): Promise<number> {
  const statements = migration().statements.filter(include);
  await ctx.db.transaction(async (tx) => {
    for (const statement of statements) await tx.execute(sql.raw(statement));
  });
  return statements.length;
}

async function insertTask(tenant: string, name = "Weekly report"): Promise<string> {
  const [row] = await ctx.db
    .insert(tasks)
    .values({
      tenant_id: tenant,
      name,
      owner_id: nextUuid(),
      goal: "Send the weekly report",
      done_when: "The report is in the inbox",
      plan: { title: "Report", goal: "Send the weekly report", steps: [] },
      bindings: { workflow_ids: [], connector_ids: [], skill_slugs: [], web_search: false },
      environment: "prod",
      fingerprint: FINGERPRINT,
    })
    .returning({ id: tasks.id });
  if (!row) throw new Error("task insert returned no row");
  return row.id;
}

async function insertRun(taskId: string, state: RunState): Promise<string> {
  const [row] = await ctx.db
    .insert(taskRuns)
    .values({
      tenant_id: tenantId,
      task_id: taskId,
      task_revision: 1,
      fingerprint: FINGERPRINT,
      trigger: "manual",
      state,
      deadline_at: sql`clock_timestamp() + interval '4 hours'`,
      trace_id: TRACE,
    })
    .returning({ id: taskRuns.id });
  if (!row) throw new Error("task run insert returned no row");
  return row.id;
}

async function insertGrant(taskId: string, environment: "dev" | "prod"): Promise<string> {
  const [row] = await ctx.db
    .insert(taskGrants)
    .values({
      tenant_id: tenantId,
      task_id: taskId,
      fingerprint: FINGERPRINT,
      environment,
      created_by: nextUuid(),
    })
    .returning({ id: taskGrants.id });
  if (!row) throw new Error("task grant insert returned no row");
  return row.id;
}

async function refusal(
  statement: string,
): Promise<{ code?: string | undefined; constraint?: string | undefined }> {
  try {
    await ctx.pool.query(statement);
  } catch (err) {
    const { code, constraint } = err as {
      code?: string | undefined;
      constraint?: string | undefined;
    };
    return { code, constraint };
  }
  return {};
}

async function selfServiceTenant(subject: string): Promise<string> {
  const { tenant } = await provisionSelfServiceTenant(
    {
      issuer_url: "https://identity.example",
      subject,
      email: `${subject}@example.test`,
      email_verified: true,
    },
    TEST_WORKSPACE_REGISTRATION,
    ctx.db,
  );
  return tenant.id;
}

async function usage(tenant: string) {
  const [row] = await ctx.db
    .select()
    .from(hostedTenantUsage)
    .where(eq(hostedTenantUsage.tenant_id, tenant));
  if (!row) throw new Error("hosted usage row missing");
  const counts = row.resource_counts as Record<string, string>;
  return { bytes: row.logical_bytes, count: counts.tasks ?? null };
}

async function producerLabels(): Promise<string[]> {
  const result = await ctx.pool.query(
    "SELECT enumlabel FROM pg_enum WHERE enumtypid='scheduler_sweep_producer'::regtype ORDER BY enumsortorder",
  );
  return result.rows.map((row: { enumlabel: string }) => row.enumlabel);
}

function isProducerStatement(statement: string): boolean {
  return statement.includes("scheduler_sweep_producer") || statement.includes("sweep_cursors");
}

function isMeterStatement(statement: string): boolean {
  return statement.includes("hosted_meter_tasks") || statement.includes("hosted_tenant_usage");
}

describe(TAG, () => {
  test("a fresh database carries the tables, the meter trigger and the task sweep cursor", async () => {
    expect(migration().idx).toBe(7);
    const present = await ctx.pool.query(
      `SELECT to_regclass('subkit.tasks') IS NOT NULL AS tasks,
              to_regclass('subkit.task_runs') IS NOT NULL AS runs,
              to_regclass('subkit.task_grants') IS NOT NULL AS grants`,
    );
    expect(present.rows).toEqual([{ tasks: true, runs: true, grants: true }]);
    const triggers = await ctx.pool.query(
      `SELECT c.relname AS name FROM pg_trigger t JOIN pg_class c ON c.oid = t.tgrelid
        WHERE NOT t.tgisinternal AND t.tgname = 'hosted_meter_' || c.relname
          AND c.relname IN ('tasks', 'task_runs', 'task_grants')`,
    );
    expect(triggers.rows).toEqual([{ name: "tasks" }]);
    expect(await producerLabels()).toEqual([...schedulerSweepProducerEnum.enumValues]);
    const [cursor] = await ctx.db
      .select()
      .from(schedulerSweepCursors)
      .where(eq(schedulerSweepCursors.producer, "task"));
    expect(cursor).toMatchObject({ epoch: 0, revision: 0, after_id: null, lease_token: null });
  });

  test("a task takes the documented defaults", async () => {
    const taskId = await insertTask(tenantId, "Defaults");
    const [row] = await ctx.db.select().from(tasks).where(eq(tasks.id, taskId));
    expect(row).toMatchObject({
      max_turns: 20,
      run_deadline_minutes: 240,
      revision: 1,
      lifecycle: "active",
      category: "other",
      schedule_cron: null,
      schedule_run_at: null,
      paused_at: null,
    });
  });

  test("every closed value is accepted and anything else is refused by its constraint", async () => {
    const taskId = await insertTask(tenantId, "Closed sets");
    const runId = await insertRun(taskId, "running");
    const grantId = await insertGrant(taskId, "prod");
    const accepted = [
      ...["active", "archived"].map((v) => `UPDATE subkit.tasks SET lifecycle='${v}'`),
      ...["owner_request", "admin", "owner_unavailable"].map(
        (v) => `UPDATE subkit.tasks SET paused_at=clock_timestamp(), paused_reason='${v}'`,
      ),
      "UPDATE subkit.tasks SET schedule_cron='0 8 * * 1', schedule_timezone='Europe/Berlin'",
      "UPDATE subkit.tasks SET schedule_cron=NULL, schedule_run_at=clock_timestamp()",
    ].map((statement) => `${statement} WHERE id='${taskId}'`);
    const acceptedRuns = [
      ...RUN_STATES.map((v) => `UPDATE subkit.task_runs SET state='${v}'`),
      ...["manual", "once", "cron"].map((v) => `UPDATE subkit.task_runs SET trigger='${v}'`),
      ...[
        "question",
        "approval",
        "no_progress",
        "budget",
        "question_expired",
        "ai_access",
        "turn_stopped",
      ].map((v) => `UPDATE subkit.task_runs SET waiting_reason='${v}'`),
      `UPDATE subkit.task_runs SET sleep_reason='${"s".repeat(200)}'`,
    ].map((statement) => `${statement} WHERE id='${runId}'`);
    for (const statement of [...accepted, ...acceptedRuns])
      expect(await refusal(statement)).toEqual({});

    const refusedTasks: Array<[string, string]> = [
      ["lifecycle='draft'", "tasks_lifecycle_check"],
      ["fingerprint='abc'", "tasks_fingerprint_check"],
      ["revision=0", "tasks_revision_check"],
      ["max_turns=0", "tasks_limits_check"],
      ["run_deadline_minutes=0", "tasks_limits_check"],
      ["plan='[]'::jsonb", "tasks_documents_check"],
      ["schedule_cron='0 8 * * 1', schedule_run_at=clock_timestamp()", "tasks_schedule_check"],
      ["paused_reason='vacation'", "tasks_paused_check"],
      ["paused_at=NULL, paused_reason='admin'", "tasks_paused_check"],
      ["category='Not A Slug'", "tasks_category_format"],
      ["description_source='import'", "tasks_catalog_sources"],
    ];
    for (const [fields, constraint] of refusedTasks)
      expect(await refusal(`UPDATE subkit.tasks SET ${fields} WHERE id='${taskId}'`)).toEqual({
        code: "23514",
        constraint,
      });
    const refusedRuns: Array<[string, string]> = [
      ["state='paused'", "task_runs_state_check"],
      ["trigger='webhook'", "task_runs_trigger_check"],
      ["waiting_reason='tired'", "task_runs_waiting_reason_check"],
      [`sleep_reason='${"s".repeat(201)}'`, "task_runs_sleep_reason_check"],
      [`failure_code='${"f".repeat(201)}'`, "task_runs_failure_code_check"],
      ["fingerprint='abc'", "task_runs_fingerprint_check"],
      ["trace_id='abc'", "task_runs_trace_id_check"],
      ["turns_used=-1", "task_runs_counters_check"],
    ];
    for (const [fields, constraint] of refusedRuns)
      expect(await refusal(`UPDATE subkit.task_runs SET ${fields} WHERE id='${runId}'`)).toEqual({
        code: "23514",
        constraint,
      });
    const refusedGrants: Array<[string, string]> = [
      ["fingerprint='abc'", "task_grants_fingerprint_check"],
      ["valid_until=valid_from", "task_grants_window_check"],
      ["max_runs=0", "task_grants_run_limit_check"],
      ["max_runs=1, reserved_runs=2", "task_grants_run_limit_check"],
      ["reserved_runs=-1", "task_grants_run_limit_check"],
      ["revoked_at=clock_timestamp()", "task_grants_revocation_check"],
      ["workflow_authority_ids='{}'::jsonb", "task_grants_authorities_check"],
      [
        "workflow_authority_ids=(SELECT jsonb_agg(gen_random_uuid()) FROM generate_series(1, 201))",
        "task_grants_authorities_check",
      ],
      [
        "workflow_authority_ids=jsonb_build_array(repeat('a', 8190))",
        "task_grants_authorities_check",
      ],
    ];
    for (const [fields, constraint] of refusedGrants)
      expect(
        await refusal(`UPDATE subkit.task_grants SET ${fields} WHERE id='${grantId}'`),
      ).toEqual({ code: "23514", constraint });
    expect(
      await refusal(
        `UPDATE subkit.task_grants SET max_runs=2, reserved_runs=2, valid_until=valid_from + interval '1 day' WHERE id='${grantId}'`,
      ),
    ).toEqual({});
    expect(
      await refusal(
        `UPDATE subkit.task_grants SET workflow_authority_ids=jsonb_build_array(repeat('a', 8188)) WHERE id='${grantId}'`,
      ),
    ).toEqual({});
    expect(
      await refusal(
        `UPDATE subkit.task_grants SET workflow_authority_ids=(SELECT jsonb_agg(gen_random_uuid()) FROM generate_series(1, 200)) WHERE id='${grantId}'`,
      ),
    ).toEqual({});
  });

  test("a conversation belongs to one run at most", async () => {
    const first = await insertRun(await insertTask(tenantId, "Conversation one"), "running");
    const second = await insertRun(await insertTask(tenantId, "Conversation two"), "running");
    const conversation = await seedConversation(ctx.db, { id: nextUuid(), tenant_id: tenantId });
    await ctx.db
      .update(taskRuns)
      .set({ conversation_id: conversation.id })
      .where(eq(taskRuns.id, first));
    await expect(
      (async () =>
        ctx.db
          .update(taskRuns)
          .set({ conversation_id: conversation.id })
          .where(eq(taskRuns.id, second)))(),
    ).rejects.toMatchObject({
      cause: { code: "23505", constraint: "task_runs_one_run_per_conversation_key" },
    });
    const [untouched] = await ctx.db.select().from(taskRuns).where(eq(taskRuns.id, second));
    expect(untouched?.conversation_id).toBeNull();
  });

  test("a task has one open run at most and a finished run does not block the next", async () => {
    const taskId = await insertTask(tenantId, "Open runs");
    const first = await insertRun(taskId, "running");
    for (const state of ["running", "waiting", "sleeping"] as const)
      await expect(insertRun(taskId, state)).rejects.toMatchObject({
        cause: { code: "23505", constraint: "task_runs_one_open_run_key" },
      });
    for (const state of ["result_ready", "completed", "aborted", "failed"] as const) {
      await ctx.db.update(taskRuns).set({ state }).where(eq(taskRuns.id, first));
      const next = await insertRun(taskId, "sleeping");
      await ctx.db.update(taskRuns).set({ state: "completed" }).where(eq(taskRuns.id, next));
    }
    const other = await insertTask(tenantId, "Other open run");
    await insertRun(other, "waiting");
  });

  test("a task has one unrevoked grant per environment", async () => {
    const taskId = await insertTask(tenantId, "Grants");
    const first = await insertGrant(taskId, "prod");
    await expect(insertGrant(taskId, "prod")).rejects.toMatchObject({
      cause: { code: "23505", constraint: "task_grants_one_unrevoked_key" },
    });
    await insertGrant(taskId, "dev");
    await ctx.db
      .update(taskGrants)
      .set({ revoked_at: sql`clock_timestamp()`, revoked_by: nextUuid() })
      .where(eq(taskGrants.id, first));
    await insertGrant(taskId, "prod");
  });

  test("a deleted conversation leaves its run and a task is deleted only after its grants", async () => {
    const taskId = await insertTask(tenantId, "References");
    const runId = await insertRun(taskId, "running");
    await insertGrant(taskId, "prod");
    const conversation = await seedConversation(ctx.db, { id: nextUuid(), tenant_id: tenantId });
    await ctx.db
      .update(taskRuns)
      .set({ conversation_id: conversation.id })
      .where(eq(taskRuns.id, runId));
    await ctx.db.delete(conversations).where(eq(conversations.id, conversation.id));
    const [run] = await ctx.db.select().from(taskRuns).where(eq(taskRuns.id, runId));
    expect(run).toMatchObject({ id: runId, conversation_id: null });

    await expect(
      (async () => ctx.db.delete(tasks).where(eq(tasks.id, taskId)))(),
    ).rejects.toMatchObject({
      cause: { code: "23503", constraint: "task_grants_task_id_tasks_id_fk" },
    });
    await ctx.db.delete(taskGrants).where(eq(taskGrants.task_id, taskId));
    await ctx.db.delete(tasks).where(eq(tasks.id, taskId));
    expect(await ctx.db.select().from(taskRuns).where(eq(taskRuns.task_id, taskId))).toEqual([]);
  });

  test("audit provenance accepts the task run access type next to the earlier ones", async () => {
    const strip = async (accessType: string) => {
      const result = await ctx.pool.query(
        "SELECT subkit.hosted_audit_metadata_without_provenance($1::jsonb) AS rest",
        [JSON.stringify({ audit_access_type: accessType, kept: true })],
      );
      return result.rows[0]?.rest ?? null;
    };
    for (const accessType of [
      "api_key",
      "browser_session",
      "mcp_oauth",
      "token_exchange",
      "external_bearer",
      "portal_token",
      "task_run",
    ])
      expect(await strip(accessType)).toEqual({ kept: true });
    expect(await strip("task")).toBeNull();
  });

  test("the operational guard admits the task queue next to the earlier ones for a hosted tenant", async () => {
    const hosted = await selfServiceTenant("tasks-guard-hosted");
    const admit = (queue: string) =>
      refusal(
        `INSERT INTO subkit.hosted_work_admissions (tenant_id, kind, state, queue_name, job_id, owner_boot_id)
         VALUES ('${hosted}', 'chat', 'active', '${queue}', '${nextUuid()}', '${nextUuid()}')`,
      );
    for (const queue of ["execution.run", "conversation.run-turn", "chat.event", "task.run-turn"])
      expect(await admit(queue)).toEqual({});
    expect(await admit("task.other")).toEqual({ code: "P0001", constraint: undefined });
    const guard = await ctx.pool.query(
      "SELECT prosrc FROM pg_proc WHERE oid = 'subkit.hosted_operational_guard()'::regprocedure",
    );
    expect(guard.rows[0]?.prosrc).not.toContain("hosted_budget_reservations");
  });

  test("an upgraded hosted installation counts existing tasks once and meters new ones the same", async () => {
    await ctx.pool.query("DROP TRIGGER hosted_meter_tasks ON subkit.tasks");
    await ctx.pool.query("DROP FUNCTION subkit.hosted_meter_tasks()");
    const legacy = await selfServiceTenant("tasks-upgrade-legacy");
    const legacyBefore = await usage(legacy);
    await insertTask(legacy);
    await insertTask(legacy);
    expect(await usage(legacy)).toEqual(legacyBefore);
    expect(legacyBefore.count).toBeNull();

    expect(await runStatements(isMeterStatement)).toBe(3);
    const legacyAfter = await usage(legacy);
    expect(legacyAfter.count).toBe("2");
    expect(legacyAfter.bytes).toBeGreaterThan(legacyBefore.bytes);

    const live = await selfServiceTenant("tasks-upgrade-live");
    const liveBefore = await usage(live);
    const liveTask = await insertTask(live);
    await insertTask(live);
    const liveAfter = await usage(live);
    expect(liveAfter.count).toBe("2");
    expect(liveAfter.bytes - liveBefore.bytes).toBe(legacyAfter.bytes - legacyBefore.bytes);

    await runStatements(isMeterStatement);
    expect(await usage(legacy)).toEqual(legacyAfter);
    expect(await usage(live)).toEqual(liveAfter);

    await ctx.db.delete(tasks).where(eq(tasks.id, liveTask));
    const afterDelete = await usage(live);
    expect(afterDelete.count).toBe("1");
    expect(afterDelete.bytes - liveBefore.bytes).toBe((liveAfter.bytes - liveBefore.bytes) / 2n);
  });

  test("an installation without the task producer gains it and keeps its cursor state", async () => {
    await ctx.pool.query(
      `UPDATE subkit.scheduler_sweep_cursors SET epoch=1, revision=7,
         epoch_upper_id='00000000-0000-4000-8000-000000000002', epoch_cutoff_at=clock_timestamp()
       WHERE producer='docs'`,
    );
    const earlier = EARLIER_PRODUCERS.map((value) => `'${value}'`).join(",");
    const client = await ctx.pool.connect();
    try {
      await client.query("BEGIN");
      await client.query("DELETE FROM subkit.scheduler_sweep_cursors WHERE producer='task'");
      await client.query(
        "ALTER TYPE public.scheduler_sweep_producer RENAME TO scheduler_sweep_producer_current",
      );
      await client.query(`CREATE TYPE public.scheduler_sweep_producer AS ENUM (${earlier})`);
      await client.query(
        "ALTER TABLE subkit.scheduler_sweep_cursors ALTER COLUMN producer TYPE public.scheduler_sweep_producer USING producer::text::public.scheduler_sweep_producer",
      );
      await client.query("DROP TYPE public.scheduler_sweep_producer_current");
      await client.query("COMMIT");
    } finally {
      client.release();
    }
    expect(await producerLabels()).toEqual(EARLIER_PRODUCERS);

    expect(await runStatements(isProducerStatement)).toBe(2);
    expect(await producerLabels()).toEqual([...schedulerSweepProducerEnum.enumValues]);
    const rows = await ctx.pool.query(
      "SELECT producer::text AS producer, revision::int AS revision FROM subkit.scheduler_sweep_cursors ORDER BY producer::text",
    );
    expect(rows.rows).toEqual(
      [...schedulerSweepProducerEnum.enumValues]
        .sort()
        .map((producer) => ({ producer, revision: producer === "docs" ? 7 : 0 })),
    );

    await runStatements(isProducerStatement);
    expect(await producerLabels()).toEqual([...schedulerSweepProducerEnum.enumValues]);
    const after = await ctx.pool.query(
      "SELECT count(*)::int AS n FROM subkit.scheduler_sweep_cursors",
    );
    expect(after.rows).toEqual([{ n: schedulerSweepProducerEnum.enumValues.length }]);
  });

  test("rerunning every statement keeps rows, usage and constraints", async () => {
    const taskId = await insertTask(tenantId, "Rerun");
    await insertRun(taskId, "running");
    await insertGrant(taskId, "prod");
    const hosted = (
      await ctx.db.select({ id: hostedTenantUsage.tenant_id }).from(hostedTenantUsage)
    ).map((row) => row.id);
    const count = async () =>
      (
        await ctx.pool.query(
          `SELECT (SELECT count(*)::int FROM subkit.tasks) AS tasks,
                  (SELECT count(*)::int FROM subkit.task_runs) AS runs,
                  (SELECT count(*)::int FROM subkit.task_grants) AS grants`,
        )
      ).rows;
    const before = { rows: await count(), usage: await Promise.all(hosted.map(usage)) };

    expect(await runStatements(() => true)).toBe(migration().statements.length);

    expect({ rows: await count(), usage: await Promise.all(hosted.map(usage)) }).toEqual(before);
    await expect(insertRun(taskId, "waiting")).rejects.toMatchObject({
      cause: { code: "23505", constraint: "task_runs_one_open_run_key" },
    });
    await ctx.db.delete(taskGrants).where(eq(taskGrants.task_id, taskId));
    await ctx.db.delete(tasks).where(eq(tasks.id, taskId));
    expect(await ctx.db.select().from(taskRuns).where(eq(taskRuns.task_id, taskId))).toEqual([]);
  });
});
