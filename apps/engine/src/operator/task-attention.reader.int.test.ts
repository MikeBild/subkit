import { afterAll, beforeAll, describe, expect, test } from "bun:test";
import { and, eq } from "drizzle-orm";
import {
  conversationHidden,
  conversations,
  taskGrants,
  taskRuns,
  tasks,
  tenants,
} from "../db/schema/index.ts";
import { createTestDb, type TestDb } from "../db/tests/setup.ts";
import {
  readTaskAttention,
  retargetRunConversations,
  type TaskAttentionScope,
  taskAttentionHref,
} from "./task-attention.ts";

let ctx: TestDb;
let tenant_id = "";
let other_tenant_id = "";

const OWNER = "aaaaaaaa-0000-4000-8000-000000000001";
const COLLEAGUE = "aaaaaaaa-0000-4000-8000-000000000002";
const ADMIN = "aaaaaaaa-0000-4000-8000-000000000003";
const NOW = new Date("2026-11-19T10:00:00.000Z");
const HOUR = 3_600_000;
const GOAL = "Collect the confidential payroll figures";
const FINGERPRINT = "a".repeat(64);

type RunState = (typeof taskRuns.$inferInsert)["state"];

const ownerScope = (): TaskAttentionScope => ({ tenant_id, owner_id: OWNER, viewer_id: OWNER });
const colleagueScope = (): TaskAttentionScope => ({
  tenant_id,
  owner_id: COLLEAGUE,
  viewer_id: COLLEAGUE,
});
const adminScope = (): TaskAttentionScope => ({ tenant_id, owner_id: null, viewer_id: ADMIN });

async function seedTask(
  values: Partial<typeof tasks.$inferInsert> = {},
  tenant = tenant_id,
): Promise<string> {
  const [row] = await ctx.db
    .insert(tasks)
    .values({
      tenant_id: tenant,
      name: "Weekly report",
      category: "reports",
      category_source: "human",
      description_source: "human",
      owner_id: OWNER,
      goal: GOAL,
      done_when: "The figures are in the inbox",
      plan: { title: "Report", goal: GOAL, steps: [] },
      bindings: { workflow_ids: [], connector_ids: [], skill_slugs: [], web_search: false },
      environment: "prod",
      fingerprint: FINGERPRINT,
      ...values,
    })
    .returning({ id: tasks.id });
  if (!row) throw new Error("task fixture missing");
  return row.id;
}

let runSeq = 0;

async function seedRun(
  task_id: string,
  state: RunState,
  values: Partial<typeof taskRuns.$inferInsert> = {},
  tenant = tenant_id,
): Promise<string> {
  runSeq += 1;
  const [row] = await ctx.db
    .insert(taskRuns)
    .values({
      tenant_id: tenant,
      task_id,
      task_revision: 1,
      fingerprint: FINGERPRINT,
      trigger: "manual",
      state,
      deadline_at: new Date(NOW.getTime() + 4 * HOUR),
      trace_id: "b".repeat(32),
      created_at: new Date(NOW.getTime() - 10 * HOUR + runSeq * 1000),
      ...values,
    })
    .returning({ id: taskRuns.id });
  if (!row) throw new Error("run fixture missing");
  return row.id;
}

async function seedGrant(
  task_id: string,
  values: Partial<typeof taskGrants.$inferInsert> = {},
): Promise<string> {
  const [row] = await ctx.db
    .insert(taskGrants)
    .values({
      tenant_id,
      task_id,
      fingerprint: FINGERPRINT,
      environment: "prod",
      valid_from: new Date(NOW.getTime() - 48 * HOUR),
      created_by: OWNER,
      ...values,
    })
    .returning({ id: taskGrants.id });
  if (!row) throw new Error("grant fixture missing");
  return row.id;
}

async function seedConversation(owner_id: string, status: "active" | "awaiting_input") {
  const [row] = await ctx.db
    .insert(conversations)
    .values({ tenant_id, owner_id, status, title: "Weekly report" })
    .returning({ id: conversations.id });
  if (!row) throw new Error("conversation fixture missing");
  return row.id;
}

async function itemFor(scope: TaskAttentionScope, task_id: string) {
  const found = await readTaskAttention(ctx.db, scope, NOW);
  return found.find((candidate) => candidate.item.subject?.id === task_id)?.item ?? null;
}

beforeAll(async () => {
  ctx = await createTestDb("operator_task_attention_reader");
  const [mine, other] = await ctx.db
    .insert(tenants)
    .values([
      { slug: "t-task-attention", display_name: "Task attention" },
      { slug: "t-task-attention-other", display_name: "Task attention other" },
    ])
    .returning();
  if (!mine || !other) throw new Error("tenant fixture missing");
  tenant_id = mine.id;
  other_tenant_id = other.id;
});

afterAll(async () => {
  await ctx.cleanup();
});

describe("failed runs", () => {
  test("the latest failed run shows for the owner and for admins, not for a colleague", async () => {
    const task = await seedTask();
    await seedRun(task, "failed", {
      failure_code: "turn_failed",
      ended_at: new Date(NOW.getTime() - HOUR),
    });
    const mine = await itemFor(ownerScope(), task);
    expect(mine).toMatchObject({
      id: `task:${task}`,
      class: "failing",
      kind: "task",
      reason: "task_run_failed",
      subject: { kind: "task", id: task, name: "Weekly report" },
      detail: "turn_failed",
      since: new Date(NOW.getTime() - HOUR).toISOString(),
      actions: [
        { verb: "open", href: taskAttentionHref(task), primary: true, permission: "task:read" },
      ],
    });
    expect((await itemFor(adminScope(), task))?.reason).toBe("task_run_failed");
    expect(await itemFor(colleagueScope(), task)).toBeNull();
  });

  test("a newer run supersedes the failure", async () => {
    const task = await seedTask();
    await seedRun(task, "failed", { failure_code: "turn_failed" });
    expect((await itemFor(ownerScope(), task))?.reason).toBe("task_run_failed");
    await seedRun(task, "running");
    expect(await itemFor(ownerScope(), task)).toBeNull();
  });

  test("an item never carries the goal", async () => {
    const task = await seedTask();
    await seedRun(task, "failed", { failure_code: "turn_failed" });
    expect(JSON.stringify(await itemFor(ownerScope(), task))).not.toContain("payroll");
  });
});

describe("results awaiting review", () => {
  test("a ready result shows until it is confirmed", async () => {
    const task = await seedTask();
    const readyAt = new Date(NOW.getTime() - 2 * HOUR);
    const run = await seedRun(task, "result_ready", { result_ready_at: readyAt });
    expect(await itemFor(ownerScope(), task)).toMatchObject({
      class: "decide",
      reason: "task_result_ready",
      since: readyAt.toISOString(),
      detail: null,
      actions: [{ verb: "review", href: taskAttentionHref(task), permission: "task:run" }],
    });
    expect((await itemFor(adminScope(), task))?.reason).toBe("task_result_ready");
    expect(await itemFor(colleagueScope(), task)).toBeNull();
    await ctx.db
      .update(taskRuns)
      .set({ state: "completed", completed_at: NOW, ended_at: NOW })
      .where(and(eq(taskRuns.tenant_id, tenant_id), eq(taskRuns.id, run)));
    expect(await itemFor(ownerScope(), task)).toBeNull();
  });

  test("an older unconfirmed result stays visible while a newer run works", async () => {
    const task = await seedTask();
    await seedRun(task, "result_ready", { result_ready_at: NOW });
    await seedRun(task, "running");
    expect((await itemFor(ownerScope(), task))?.reason).toBe("task_result_ready");
  });
});

describe("standing permission", () => {
  test("a scheduled task without a grant asks for one until it is granted", async () => {
    const task = await seedTask({ schedule_cron: "0 7 * * *", schedule_timezone: "UTC" });
    const item = await itemFor(ownerScope(), task);
    expect(item).toMatchObject({
      class: "decide",
      reason: "task_grant_required",
      detail: "grant_required",
      deadline: "2026-11-20T07:00:00.000Z",
      actions: [{ verb: "open", href: taskAttentionHref(task), permission: "task:grant" }],
    });
    expect((await itemFor(adminScope(), task))?.reason).toBe("task_grant_required");
    expect(await itemFor(colleagueScope(), task)).toBeNull();
    await seedGrant(task);
    expect(await itemFor(ownerScope(), task)).toBeNull();
  });

  test("the detail names why the stored grant no longer covers the task", async () => {
    const expired = await seedTask({ schedule_cron: "0 7 * * *" });
    await seedGrant(expired, { valid_until: new Date(NOW.getTime() - HOUR) });
    expect((await itemFor(ownerScope(), expired))?.detail).toBe("grant_expired");

    const changed = await seedTask({ schedule_cron: "0 7 * * *" });
    await seedGrant(changed, { fingerprint: "c".repeat(64) });
    expect((await itemFor(ownerScope(), changed))?.detail).toBe("grant_fingerprint_mismatch");

    const exhausted = await seedTask({ schedule_cron: "0 7 * * *" });
    await seedGrant(exhausted, { max_runs: 2, reserved_runs: 2 });
    expect((await itemFor(ownerScope(), exhausted))?.detail).toBe("grant_exhausted");

    const otherEnvironment = await seedTask({ schedule_cron: "0 7 * * *" });
    await seedGrant(otherEnvironment, { environment: "dev" });
    expect((await itemFor(ownerScope(), otherEnvironment))?.detail).toBe("grant_required");
  });

  test("a revoked grant counts as no grant", async () => {
    const task = await seedTask({ schedule_cron: "0 7 * * *" });
    await seedGrant(task, { revoked_at: NOW, revoked_by: OWNER });
    expect((await itemFor(ownerScope(), task))?.detail).toBe("grant_required");
  });

  test("unscheduled, paused and already fired tasks ask for nothing", async () => {
    const manual = await seedTask();
    const paused = await seedTask({
      schedule_cron: "0 7 * * *",
      paused_at: NOW,
      paused_reason: "owner_request",
    });
    const fired = await seedTask({
      schedule_run_at: new Date(NOW.getTime() - HOUR),
      last_claimed_at: new Date(NOW.getTime() - HOUR),
    });
    const pending = await seedTask({ schedule_run_at: new Date(NOW.getTime() + HOUR) });
    expect(await itemFor(ownerScope(), manual)).toBeNull();
    expect(await itemFor(ownerScope(), paused)).toBeNull();
    expect(await itemFor(ownerScope(), fired)).toBeNull();
    expect(await itemFor(ownerScope(), pending)).toMatchObject({
      reason: "task_grant_required",
      deadline: new Date(NOW.getTime() + HOUR).toISOString(),
    });
  });

  test("a grant that ends soon asks to be extended until it is", async () => {
    const task = await seedTask({ schedule_cron: "0 7 * * *" });
    const until = new Date(NOW.getTime() + 24 * HOUR);
    const grant = await seedGrant(task, { valid_until: until });
    expect(await itemFor(ownerScope(), task)).toMatchObject({
      class: "decide",
      reason: "task_grant_expiring",
      deadline: until.toISOString(),
      actions: [{ verb: "renew", href: taskAttentionHref(task), permission: "task:grant" }],
    });
    expect((await itemFor(adminScope(), task))?.reason).toBe("task_grant_expiring");
    expect(await itemFor(colleagueScope(), task)).toBeNull();
    await ctx.db
      .update(taskGrants)
      .set({ valid_until: new Date(NOW.getTime() + 30 * 24 * HOUR) })
      .where(and(eq(taskGrants.tenant_id, tenant_id), eq(taskGrants.id, grant)));
    expect(await itemFor(ownerScope(), task)).toBeNull();
  });

  test("a grant that is nearly used up asks to be extended", async () => {
    const task = await seedTask({ schedule_cron: "0 7 * * *" });
    await seedGrant(task, { max_runs: 20, reserved_runs: 19 });
    expect(await itemFor(ownerScope(), task)).toMatchObject({
      reason: "task_grant_expiring",
      deadline: null,
    });
  });
});

describe("waiting runs", () => {
  test("the owner's open question is one item: the conversation's, not a second one", async () => {
    const task = await seedTask();
    const conversation_id = await seedConversation(OWNER, "awaiting_input");
    await seedRun(task, "waiting", { waiting_reason: "question", conversation_id });
    expect(await itemFor(ownerScope(), task)).toBeNull();
    expect(await itemFor(adminScope(), task)).toMatchObject({
      class: "stopped",
      reason: "awaiting_answer",
      detail: "question",
      actions: [{ verb: "answer", href: taskAttentionHref(task) }],
    });
    expect(await itemFor(colleagueScope(), task)).toBeNull();
  });

  test("a wait the conversation does not show is reported on the task", async () => {
    const task = await seedTask();
    const conversation_id = await seedConversation(OWNER, "active");
    const run = await seedRun(task, "waiting", { waiting_reason: "budget", conversation_id });
    expect(await itemFor(ownerScope(), task)).toMatchObject({
      reason: "awaiting_answer",
      detail: "budget",
    });
    await ctx.db
      .update(taskRuns)
      .set({ state: "running", waiting_reason: null })
      .where(and(eq(taskRuns.tenant_id, tenant_id), eq(taskRuns.id, run)));
    expect(await itemFor(ownerScope(), task)).toBeNull();
  });

  test("a conversation the owner hid no longer covers the wait", async () => {
    const task = await seedTask();
    const conversation_id = await seedConversation(OWNER, "awaiting_input");
    await seedRun(task, "waiting", { waiting_reason: "question", conversation_id });
    await ctx.db.insert(conversationHidden).values({ tenant_id, conversation_id, user_id: OWNER });
    expect((await itemFor(ownerScope(), task))?.reason).toBe("awaiting_answer");
  });
});

describe("one item per task", () => {
  test("a failure leads over a missing grant, an older result and an expiring grant", async () => {
    const task = await seedTask({ schedule_cron: "0 7 * * *" });
    await seedRun(task, "result_ready", { result_ready_at: NOW });
    const failed = await seedRun(task, "failed", { failure_code: "deadline_exceeded" });
    const all = await readTaskAttention(ctx.db, ownerScope(), NOW);
    expect(all.filter((candidate) => candidate.item.subject?.id === task)).toHaveLength(1);
    expect((await itemFor(ownerScope(), task))?.reason).toBe("task_run_failed");
    await ctx.db
      .update(taskRuns)
      .set({ state: "aborted" })
      .where(and(eq(taskRuns.tenant_id, tenant_id), eq(taskRuns.id, failed)));
    expect((await itemFor(ownerScope(), task))?.reason).toBe("task_grant_required");
    const grant = await seedGrant(task, { valid_until: new Date(NOW.getTime() + HOUR) });
    expect((await itemFor(ownerScope(), task))?.reason).toBe("task_result_ready");
    await ctx.db
      .update(taskRuns)
      .set({ state: "completed" })
      .where(and(eq(taskRuns.tenant_id, tenant_id), eq(taskRuns.task_id, task)));
    expect((await itemFor(ownerScope(), task))?.reason).toBe("task_grant_expiring");
    await ctx.db
      .update(taskGrants)
      .set({ valid_until: null })
      .where(and(eq(taskGrants.tenant_id, tenant_id), eq(taskGrants.id, grant)));
    expect(await itemFor(ownerScope(), task)).toBeNull();
  });

  test("an archived task reports nothing", async () => {
    const task = await seedTask({ schedule_cron: "0 7 * * *", lifecycle: "archived" });
    await seedRun(task, "failed", { failure_code: "turn_failed" });
    expect(await itemFor(adminScope(), task)).toBeNull();
  });
});

describe("tasks paused because their owner is unavailable", () => {
  test("admins are asked to resume; the owner and a colleague are not", async () => {
    const pausedAt = new Date(NOW.getTime() - 3 * HOUR);
    const task = await seedTask({
      schedule_cron: "0 7 * * *",
      paused_at: pausedAt,
      paused_reason: "owner_unavailable",
    });
    await seedRun(task, "aborted");
    expect(await itemFor(adminScope(), task)).toMatchObject({
      id: `task:${task}`,
      class: "stopped",
      severity: "urgent",
      reason: "task_owner_unavailable",
      detail: "owner_unavailable",
      since: pausedAt.toISOString(),
      deadline: null,
      actions: [
        { verb: "open", href: taskAttentionHref(task), primary: true, permission: "task:resume" },
      ],
    });
    expect(await itemFor(ownerScope(), task)).toBeNull();
    expect(await itemFor(colleagueScope(), task)).toBeNull();
    await ctx.db
      .update(tasks)
      .set({ paused_at: null, paused_by: null, paused_reason: null })
      .where(and(eq(tasks.tenant_id, tenant_id), eq(tasks.id, task)));
    expect((await itemFor(adminScope(), task))?.reason).toBe("task_grant_required");
  });

  test("a pause a person chose is not reported", async () => {
    for (const paused_reason of ["owner_request", "admin"] as const) {
      const task = await seedTask({ paused_at: NOW, paused_by: ADMIN, paused_reason });
      expect(await itemFor(adminScope(), task)).toBeNull();
    }
  });

  test("the pause leads over an earlier failure, which the owner still sees", async () => {
    const task = await seedTask({ paused_at: NOW, paused_reason: "owner_unavailable" });
    await seedRun(task, "failed", { failure_code: "turn_failed" });
    expect((await itemFor(adminScope(), task))?.reason).toBe("task_owner_unavailable");
    expect((await itemFor(ownerScope(), task))?.reason).toBe("task_run_failed");
  });
});

describe("tenant isolation", () => {
  test("another tenant's tasks never reach an admin of this tenant", async () => {
    const foreign = await seedTask({ schedule_cron: "0 7 * * *" }, other_tenant_id);
    await seedRun(foreign, "failed", { failure_code: "turn_failed" }, other_tenant_id);
    expect(await itemFor(adminScope(), foreign)).toBeNull();
    expect(await itemFor(ownerScope(), foreign)).toBeNull();
    const theirs = await readTaskAttention(
      ctx.db,
      { tenant_id: other_tenant_id, owner_id: null, viewer_id: ADMIN },
      NOW,
    );
    expect(theirs.map((candidate) => candidate.item.subject?.id)).toEqual([foreign]);
  });

  test("a run conversation link is rewritten only from this tenant's runs", async () => {
    const task = await seedTask();
    const conversation_id = await seedConversation(OWNER, "awaiting_input");
    await seedRun(task, "waiting", { waiting_reason: "question", conversation_id });
    const plain = await seedConversation(OWNER, "awaiting_input");
    const candidate = (id: string) => ({
      source: "conversations" as const,
      resource: { type: "conversation", id },
      item: {
        id: `conversation:${id}`,
        class: "stopped" as const,
        severity: "urgent" as const,
        kind: "conversation",
        subject: { kind: "conversation" as const, id, name: "Weekly report" },
        reason: "awaiting_answer" as const,
        trigger: null,
        cause_class: null,
        counts: {},
        since: null,
        deadline: null,
        detail: null,
        actions: [
          {
            verb: "answer" as const,
            href: `/cockpit/chat/${id}`,
            primary: true,
            permission: "conversation:write",
          },
        ],
      },
    });
    const input = [candidate(conversation_id), candidate(plain)];
    const here = await retargetRunConversations(ctx.db, tenant_id, input);
    expect(here.map((entry) => entry.item.actions[0]?.href)).toEqual([
      taskAttentionHref(task),
      `/cockpit/chat/${plain}`,
    ]);
    expect(here.map((entry) => entry.item.id)).toEqual(input.map((entry) => entry.item.id));
    const elsewhere = await retargetRunConversations(ctx.db, other_tenant_id, input);
    expect(elsewhere.map((entry) => entry.item.actions[0]?.href)).toEqual([
      `/cockpit/chat/${conversation_id}`,
      `/cockpit/chat/${plain}`,
    ]);
  });
});
