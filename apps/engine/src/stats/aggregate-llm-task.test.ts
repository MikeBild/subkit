import { afterAll, beforeAll, describe, expect, test } from "bun:test";
import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { eq } from "drizzle-orm";
import { _resetConfigForTests, loadConfig } from "../config/loader.ts";
import { conversations, executions, llmUsage, workflows } from "../db/schema/index.ts";
import { taskRuns, tasks } from "../db/schema/tasks.ts";
import { createTestDb, type TestDb } from "../db/tests/setup.ts";
import { TASK_USAGE_NOT_INCLUDED, taskUsage } from "../tasks/usage.ts";
import { testEnv } from "../test-helpers/determinism/env.ts";
import { seedConversation, seedTenant } from "../test-helpers/seed.ts";
import { aggregateLlm, type LlmGroup } from "./aggregate-llm.ts";
import { readLlmCostByKey, readLlmWindowCost } from "./llm-cost.ts";

const skip = testEnv.REQUIRES_PG === "0";

const FROM = new Date("2026-03-01T00:00:00.000Z");
const TO = new Date("2026-04-01T00:00:00.000Z");
const MARCH = new Date("2026-03-10T12:00:00.000Z");
const FEBRUARY = new Date("2026-02-10T12:00:00.000Z");
const NOW = new Date("2026-03-20T08:00:00.000Z");
const FINGERPRINT = "a".repeat(64);
const OWNER = "0f0f0f0f-0f0f-4f0f-8f0f-0f0f0f0f0f0f";

let testDb: TestDb;
let tenantId = "";
let otherTenantId = "";
let reportTask = "";
let triageTask = "";
let idleTask = "";
let foreignTask = "";
let firstReportRun = "";
let lastReportRun = "";
let deletedConversationRun = "";
let runStartedExecution = "";
let traceCounter = 0;
let configDir = "";

function monthBucket(d: Date): number {
  return d.getUTCFullYear() * 100 + (d.getUTCMonth() + 1);
}

async function seedTask(tenant: string, name: string): Promise<string> {
  const [row] = await testDb.db
    .insert(tasks)
    .values({
      locale: "de",
      tenant_id: tenant,
      name,
      owner_id: OWNER,
      goal: "goal",
      done_when: "done",
      plan: { title: name, goal: "goal", steps: [] },
      bindings: { workflow_ids: [], connector_ids: [], skill_slugs: [], web_search: false },
      environment: "prod",
      fingerprint: FINGERPRINT,
    })
    .returning({ id: tasks.id });
  if (!row) throw new Error("task seed failed");
  return row.id;
}

async function seedRun(
  tenant: string,
  taskId: string,
  createdAt: Date,
): Promise<{ id: string; conversation_id: string }> {
  const conversation = await seedConversation(testDb.db, { tenant_id: tenant });
  traceCounter += 1;
  const [row] = await testDb.db
    .insert(taskRuns)
    .values({
      tenant_id: tenant,
      task_id: taskId,
      task_revision: 1,
      fingerprint: FINGERPRINT,
      conversation_id: conversation.id,
      trigger: "cron",
      state: "completed",
      deadline_at: new Date(createdAt.getTime() + 4 * 3_600_000),
      trace_id: traceCounter.toString(16).padStart(32, "0"),
      created_at: createdAt,
      updated_at: createdAt,
    })
    .returning({ id: taskRuns.id });
  if (!row) throw new Error("task run seed failed");
  return { id: row.id, conversation_id: conversation.id };
}

function usage(values: {
  tenant?: string;
  flow?: string;
  tokens: number;
  at?: Date;
  result?: string;
  conversation_id?: string | null;
  execution_id?: string | null;
}) {
  const at = values.at ?? MARCH;
  return {
    tenant_id: values.tenant ?? tenantId,
    flow: values.flow ?? "converse",
    model: "claude-haiku-4-5",
    prompt_tokens: values.tokens,
    completion_tokens: 0,
    total_tokens: values.tokens,
    cache_read_tokens: 0,
    cache_creation_tokens: 0,
    latency_ms: 100,
    result: values.result ?? "success",
    user_id: OWNER,
    actor_type: "user",
    created_at: at,
    month_bucket: monthBucket(at),
    conversation_id: values.conversation_id ?? null,
    execution_id: values.execution_id ?? null,
  };
}

function window(groupBy: Parameters<typeof aggregateLlm>[1]["groupBy"], tenant = tenantId) {
  return { tenantId: tenant, bucket: "month" as const, from: FROM, to: TO, tz: "UTC", groupBy };
}

function byTask(groups: LlmGroup[]): Map<string, LlmGroup> {
  return new Map(groups.map((group) => [group.key.task ?? "", group]));
}

beforeAll(async () => {
  if (skip) return;
  configDir = mkdtempSync(join(tmpdir(), "subkit-llm-task-test-"));
  _resetConfigForTests();
  await loadConfig({
    env: { DATABASE_URL: "postgres://placeholder/llm-task", NODE_ENV: "test" },
    configPathOverride: join(configDir, "subkit.config.json"),
  });
  testDb = await createTestDb("stats-agg-llm-task");
  tenantId = (await seedTenant(testDb.db, { slug: "llm-task", display_name: "LLM task" })).id;
  otherTenantId = (await seedTenant(testDb.db, { slug: "llm-task-other", display_name: "Other" }))
    .id;

  reportTask = await seedTask(tenantId, "Weekly report");
  triageTask = await seedTask(tenantId, "Inbox triage");
  idleTask = await seedTask(tenantId, "Never ran");
  foreignTask = await seedTask(otherTenantId, "Foreign task");

  const february = await seedRun(tenantId, reportTask, FEBRUARY);
  const first = await seedRun(tenantId, reportTask, new Date("2026-03-05T06:00:00.000Z"));
  const last = await seedRun(tenantId, reportTask, new Date("2026-03-12T06:00:00.000Z"));
  const triage = await seedRun(tenantId, triageTask, new Date("2026-03-08T06:00:00.000Z"));
  const deleted = await seedRun(tenantId, triageTask, new Date("2026-03-09T06:00:00.000Z"));
  const foreign = await seedRun(otherTenantId, foreignTask, new Date("2026-03-09T06:00:00.000Z"));
  firstReportRun = first.id;
  lastReportRun = last.id;
  deletedConversationRun = deleted.id;

  const chat = await seedConversation(testDb.db, { tenant_id: tenantId });
  const [workflow] = await testDb.db
    .insert(workflows)
    .values({ tenant_id: tenantId, slug: "report-mail", name: "Report mail", lifecycle: "active" })
    .returning();
  const [execution] = await testDb.db
    .insert(executions)
    .values({
      tenant_id: tenantId,
      workflow_id: workflow!.id,
      status: "succeeded",
      request_source: "chat",
      execution_mode: "prod",
    })
    .returning();
  runStartedExecution = execution!.id;

  await testDb.db
    .insert(llmUsage)
    .values([
      usage({ tokens: 1_000, at: FEBRUARY, conversation_id: february.conversation_id }),
      usage({ tokens: 100, conversation_id: first.conversation_id }),
      usage({ tokens: 200, conversation_id: first.conversation_id }),
      usage({ tokens: 400, conversation_id: last.conversation_id }),
      usage({ tokens: 50, flow: "tool_repair", conversation_id: last.conversation_id }),
      usage({ tokens: 30, result: "error", conversation_id: last.conversation_id }),
      usage({ tokens: 7_000, conversation_id: triage.conversation_id }),
      usage({ tokens: 900, conversation_id: deleted.conversation_id }),
      usage({ tokens: 20_000, flow: "workflow_step", execution_id: runStartedExecution }),
      usage({ tokens: 60, result: "quota_exhausted" }),
      usage({ tokens: 5_000, conversation_id: chat.id }),
      usage({ tenant: otherTenantId, tokens: 90_000, conversation_id: foreign.conversation_id }),
    ]);

  await testDb.db.delete(conversations).where(eq(conversations.id, deleted.conversation_id));
}, 60_000);

afterAll(async () => {
  if (skip) return;
  _resetConfigForTests();
  rmSync(configDir, { recursive: true, force: true });
  if (testDb?.cleanup) await testDb.cleanup();
}, 30_000);

describe.skipIf(skip)("LLM usage grouped by task", () => {
  test("the conversation turns of a task's runs are summed under the task", async () => {
    const result = await aggregateLlm(testDb.db, window(["task"]));
    const groups = byTask(result.groups);
    expect(groups.get(reportTask)?.totals.calls).toBe(5);
    expect(groups.get(reportTask)?.totals.tokens.total).toBe(780);
    expect(groups.get(reportTask)?.totals.result).toEqual({ success: 4, error: 1 });
    expect(groups.get(triageTask)?.totals.tokens.total).toBe(7_000);
    expect(groups.has(idleTask)).toBe(false);
    expect(groups.has(foreignTask)).toBe(false);
    expect(result.totals.tokens.total).toBe(780 + 7_000 + 900 + 20_000 + 60 + 5_000);
  });

  test("every flow recorded with the run's conversation counts, not only converse", async () => {
    const result = await aggregateLlm(testDb.db, window(["task", "flow"]));
    const report = result.groups.filter((group) => group.key.task === reportTask);
    expect(report.map((group) => [group.key.flow, group.totals.tokens.total]).sort()).toEqual([
      ["converse", 730],
      ["tool_repair", 50],
    ]);
  });

  test("a model call inside a workflow execution that a run started is not attributed", async () => {
    const result = await aggregateLlm(testDb.db, window(["task", "execution"]));
    const row = result.groups.find((group) => group.key.execution === runStartedExecution);
    expect(row?.key.task).toBe("");
    expect(row?.totals.tokens.total).toBe(20_000);
    const unattributed = byTask((await aggregateLlm(testDb.db, window(["task"]))).groups).get("");
    expect(unattributed?.totals.calls).toBe(4);
    expect(unattributed?.totals.tokens.total).toBe(20_000 + 60 + 5_000 + 900);
  });

  test("a quota refusal written without a conversation is not attributed", async () => {
    const result = await aggregateLlm(testDb.db, {
      ...window(["task"]),
      result: ["quota_exhausted"],
    });
    expect(result.groups.map((group) => [group.key.task, group.totals.calls])).toEqual([["", 1]]);
  });

  test("a run whose conversation was deleted loses its attribution", async () => {
    const [run] = await testDb.db
      .select({ conversation_id: taskRuns.conversation_id })
      .from(taskRuns)
      .where(eq(taskRuns.id, deletedConversationRun));
    expect(run?.conversation_id).toBeNull();
    const result = await aggregateLlm(testDb.db, { ...window(["task"]), taskId: triageTask });
    expect(result.totals.tokens.total).toBe(7_000);
  });

  test("a task filter narrows totals and cost to that task", async () => {
    const params = { ...window([]), taskId: reportTask };
    const result = await aggregateLlm(testDb.db, params);
    expect(result.totals.calls.total).toBe(5);
    expect(result.totals.tokens.total).toBe(780);
    const cost = await readLlmWindowCost(testDb.db, params);
    const all = await readLlmWindowCost(testDb.db, window([]));
    expect(cost.amount).toBeGreaterThan(0);
    expect(cost.amount).toBeLessThan(all.amount);
  });

  test("cost is keyed by task and stays inside the tenant", async () => {
    const keyed = await readLlmCostByKey(testDb.db, window([]), ["task"]);
    expect([...keyed.groups.keys()].sort()).toEqual(
      ["task=", `task=${reportTask}`, `task=${triageTask}`].sort(),
    );
    const report = keyed.groups.get(`task=${reportTask}`);
    const triage = keyed.groups.get(`task=${triageTask}`);
    expect(report?.amount).toBeGreaterThan(0);
    expect(triage?.amount).toBeGreaterThan(report?.amount ?? 0);
    const foreign = await aggregateLlm(testDb.db, window(["task"], otherTenantId));
    expect(foreign.groups.map((group) => group.key.task)).toEqual([foreignTask]);
  });
});

describe.skipIf(skip)("taskUsage", () => {
  test("the last run is the newest run, with only its own calls", async () => {
    const usageOfLast = await taskUsage(testDb.db, tenantId, reportTask, "last_run", NOW);
    expect(usageOfLast.task_run_id).toBe(lastReportRun);
    expect(usageOfLast.task_run_id).not.toBe(firstReportRun);
    expect(usageOfLast.calls).toBe(3);
    expect(usageOfLast.tokens).toBe(480);
    expect(usageOfLast.cost?.amount).toBeGreaterThan(0);
    expect(usageOfLast.cost?.unpriced_models).toEqual([]);
  });

  test("the current month sums every run of the task in that calendar month", async () => {
    const march = await taskUsage(testDb.db, tenantId, reportTask, "current_month", NOW);
    expect(march).toMatchObject({ period: "current_month", task_run_id: null, calls: 5 });
    expect(march.tokens).toBe(780);
    const february = await taskUsage(
      testDb.db,
      tenantId,
      reportTask,
      "current_month",
      new Date("2026-02-27T00:00:00.000Z"),
    );
    expect(february.tokens).toBe(1_000);
  });

  test("the result names what it counts and what it leaves out", async () => {
    const usageOfLast = await taskUsage(testDb.db, tenantId, reportTask, "last_run", NOW);
    expect(usageOfLast.attribution).toBe("conversation_turns");
    expect(usageOfLast.not_included).toEqual(["workflow_run_model_calls"]);
    expect(TASK_USAGE_NOT_INCLUDED).toEqual(["workflow_run_model_calls"]);
    expect(usageOfLast.tokens).toBeLessThan(20_000);
  });

  test("a task without runs or without calls reports zero and no cost", async () => {
    expect(await taskUsage(testDb.db, tenantId, idleTask, "last_run", NOW)).toEqual({
      period: "last_run",
      task_run_id: null,
      attribution: "conversation_turns",
      not_included: ["workflow_run_model_calls"],
      calls: 0,
      tokens: 0,
      cost: null,
    });
    expect(await taskUsage(testDb.db, tenantId, idleTask, "current_month", NOW)).toEqual({
      period: "current_month",
      task_run_id: null,
      attribution: "conversation_turns",
      not_included: ["workflow_run_model_calls"],
      calls: 0,
      tokens: 0,
      cost: null,
    });
  });

  test("a last run whose conversation was removed says so instead of reporting no usage", async () => {
    const removed = await taskUsage(testDb.db, tenantId, triageTask, "last_run", NOW);
    expect(removed).toEqual({
      period: "last_run",
      task_run_id: deletedConversationRun,
      attribution: "conversation_removed",
      not_included: ["workflow_run_model_calls"],
      calls: 0,
      tokens: 0,
      cost: null,
    });
  });

  test("a month with a run whose conversation was removed is marked as incomplete", async () => {
    const month = await taskUsage(testDb.db, tenantId, triageTask, "current_month", NOW);
    expect(month.attribution).toBe("conversation_removed");
    expect(month.tokens).toBe(7_000);
    const complete = await taskUsage(testDb.db, tenantId, reportTask, "current_month", NOW);
    expect(complete.attribution).toBe("conversation_turns");
  });

  test("another tenant's task is never read", async () => {
    const leaked = await taskUsage(testDb.db, tenantId, foreignTask, "current_month", NOW);
    expect(leaked.calls).toBe(0);
    const own = await taskUsage(testDb.db, otherTenantId, foreignTask, "current_month", NOW);
    expect(own.tokens).toBe(90_000);
  });
});
