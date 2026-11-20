import { afterAll, beforeAll, describe, expect, test } from "bun:test";
import { eq, sql } from "drizzle-orm";
import { failureStreak, type ScheduledRunOutcome } from "../../scheduler/failure-backoff.ts";
import { readScheduledRunOutcomes } from "../../scheduler/schedule-failure-pause.ts";
import { createDeterministicUuidFactory } from "../../test-helpers/determinism/ids.ts";
import { getTestNow } from "../../test-helpers/determinism/index.ts";
import { emptyRoleId } from "../../test-helpers/roles.ts";
import { seedTenant, seedWorkflow } from "../../test-helpers/seed.ts";
import { executions, toolApprovalRules, users, workflowsSchedules } from "../schema/index.ts";
import { createTestDb, type TestDb } from "../tests/setup.ts";
import { EMBEDDED_MIGRATIONS, type EmbeddedMigration } from "./embedded.ts";

const nextUuid = createDeterministicUuidFactory(0x7e13);
const TAG = "0013_rule_expiry_and_gentle_auto_pause";
const DAY_MS = 24 * 60 * 60 * 1000;

let ctx: TestDb;
let tenantId: string;
let userId: string;

beforeAll(async () => {
  ctx = await createTestDb("rule-expiry-gentle-auto-pause-migration");
  tenantId = (await seedTenant(ctx.db, { slug: "gentle-rollout", display_name: "Rollout" })).id;
  const [user] = await ctx.db
    .insert(users)
    .values({
      tenant_id: tenantId,
      email: "rules@example.test",
      display_name: "Rules",
      role_id: await emptyRoleId(ctx.db, tenantId),
    })
    .returning({ id: users.id });
  if (!user) throw new Error("user insert returned no row");
  userId = user.id;
}, 120_000);

afterAll(async () => {
  await ctx?.cleanup();
}, 30_000);

function migration(): EmbeddedMigration {
  const found = EMBEDDED_MIGRATIONS.find((item) => item.tag === TAG);
  if (!found) throw new Error(`${TAG} missing from the embedded bundle`);
  return found;
}

async function migrate(): Promise<void> {
  await ctx.db.transaction(async (tx) => {
    for (const statement of migration().statements) await tx.execute(sql.raw(statement));
  });
}

async function insertRule(
  state: "active" | "observed" | "offered",
  created_at: Date,
  expires_at: Date | null,
): Promise<string> {
  const [row] = await ctx.db
    .insert(toolApprovalRules)
    .values({
      tenant_id: tenantId,
      user_id: userId,
      tool: "call_connector",
      scope_hash: nextUuid().replaceAll("-", "").padEnd(64, "a"),
      scope: {} as never,
      state,
      decided_at: state === "active" ? created_at : null,
      created_at,
      expires_at,
    })
    .returning({ id: toolApprovalRules.id });
  if (!row) throw new Error("rule insert returned no row");
  return row.id;
}

async function expiryOf(id: string): Promise<Date | null> {
  const [row] = await ctx.db
    .select({ expires_at: toolApprovalRules.expires_at })
    .from(toolApprovalRules)
    .where(eq(toolApprovalRules.id, id));
  return row?.expires_at ?? null;
}

describe(TAG, () => {
  test("it follows the rule limits migration", () => {
    expect(migration().idx).toBe(13);
    expect(migration().statements).toHaveLength(3);
  });

  test("an active rule without expiry ends 90 days after it was created", async () => {
    const recent = new Date(getTestNow() - 10 * DAY_MS);
    const old = new Date(getTestNow() - 200 * DAY_MS);
    const kept = new Date(getTestNow() + 5 * DAY_MS);
    const fresh = await insertRule("active", recent, null);
    const stale = await insertRule("active", old, null);
    const dated = await insertRule("active", recent, kept);
    const observed = await insertRule("observed", recent, null);
    const offered = await insertRule("offered", recent, null);
    await migrate();
    expect((await expiryOf(fresh))?.getTime()).toBe(recent.getTime() + 90 * DAY_MS);
    expect((await expiryOf(stale))?.getTime()).toBe(old.getTime() + 90 * DAY_MS);
    expect((await expiryOf(stale))?.getTime()).toBeLessThan(getTestNow());
    expect((await expiryOf(dated))?.getTime()).toBe(kept.getTime());
    expect(await expiryOf(observed)).toBeNull();
    expect(await expiryOf(offered)).toBeNull();
    await migrate();
    expect((await expiryOf(fresh))?.getTime()).toBe(recent.getTime() + 90 * DAY_MS);
  });

  test("failures from before the rollout no longer count towards a pause", async () => {
    const workflow = await seedWorkflow(ctx.db, { tenant_id: tenantId, slug: "nightly-report" });
    const [schedule] = await ctx.db
      .insert(workflowsSchedules)
      .values({ tenant_id: tenantId, workflow_id: workflow.workflow.id, cron: "0 * * * *" })
      .returning();
    if (!schedule) throw new Error("schedule insert returned no row");
    expect(schedule.failures_reset_at).toBeNull();
    const failed = (minutesAgo: number) => ({
      tenant_id: tenantId,
      workflow_id: workflow.workflow.id,
      status: "failed" as const,
      request_source: "scheduler" as const,
      execution_mode: schedule.execution_mode,
      failure: { error_code: "http_5xx" } as never,
      created_at: new Date(getTestNow() - minutesAgo * 60_000),
      finished_at: new Date(getTestNow() - minutesAgo * 60_000),
    });
    await ctx.db.insert(executions).values([5, 4, 3, 2, 1].map((hours) => failed(hours * 60)));
    const streakOf = async (): Promise<number> => {
      const [row] = await ctx.db
        .select()
        .from(workflowsSchedules)
        .where(eq(workflowsSchedules.id, schedule.id));
      if (!row) throw new Error("schedule missing");
      const outcomes: ScheduledRunOutcome[] = await readScheduledRunOutcomes(ctx.db, {
        tenant_id: tenantId,
        workflow_id: workflow.workflow.id,
        execution_mode: row.execution_mode,
        failures_reset_at: row.failures_reset_at,
      });
      return failureStreak(outcomes).streak;
    };
    expect(await streakOf()).toBe(5);
    await migrate();
    expect(await streakOf()).toBe(0);
    const [baselined] = await ctx.db
      .select({ at: workflowsSchedules.failures_reset_at })
      .from(workflowsSchedules)
      .where(eq(workflowsSchedules.id, schedule.id));
    const baseline = baselined?.at;
    expect(baseline).toBeInstanceOf(Date);
    await ctx.db.execute(
      sql`INSERT INTO subkit.executions (tenant_id, workflow_id, status, request_source, execution_mode, failure, created_at, finished_at)
          SELECT tenant_id, workflow_id, status, request_source, execution_mode, failure, now() + interval '1 second', now() + interval '1 second'
          FROM subkit.executions WHERE workflow_id = ${workflow.workflow.id}::uuid LIMIT 2`,
    );
    expect(await streakOf()).toBe(2);
    await migrate();
    const [again] = await ctx.db
      .select({ at: workflowsSchedules.failures_reset_at })
      .from(workflowsSchedules)
      .where(eq(workflowsSchedules.id, schedule.id));
    expect(again?.at?.getTime()).toBe(baseline?.getTime());
    expect(await streakOf()).toBe(2);
  });
});
