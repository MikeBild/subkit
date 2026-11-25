import { afterAll, beforeAll, describe, expect, test } from "bun:test";
import { AuditAction } from "../../audit/index.ts";
import { auditLog, conversationElicitations, conversationTurns } from "../../db/schema/index.ts";
import { taskRuns, tasks } from "../../db/schema/tasks.ts";
import { createTestDb, type TestDb } from "../../db/tests/setup.ts";
import { testEnv } from "../../test-helpers/determinism/env.ts";
import { createDeterministicUuidFactory } from "../../test-helpers/determinism/ids.ts";
import { seedConversation, seedTenant } from "../../test-helpers/seed.ts";
import { aggregateConfirmations } from "../aggregate-confirmations.ts";
import { readConfirmationFacts } from "./confirmations.ts";

const skip = testEnv.REQUIRES_PG === "0";
const uuid = createDeterministicUuidFactory(0x08_76);
const FROM = new Date("2026-05-01T00:00:00.000Z");
const TO = new Date("2026-05-08T00:00:00.000Z");
const MINUTE = 60_000;
const at = (minutes: number) => new Date(FROM.getTime() + 3_600_000 + minutes * MINUTE);
const FINGERPRINT = "e".repeat(64);
const OWNER = "0e0e0e0e-0e0e-4e0e-8e0e-0e0e0e0e0e0e";

let testDb: TestDb;
let tenantId = "";
let otherTenantId = "";
let traceCounter = 0;

async function seedTask(): Promise<string> {
  const [row] = await testDb.db
    .insert(tasks)
    .values({
      locale: "en",
      tenant_id: tenantId,
      name: "Weekly digest",
      owner_id: OWNER,
      goal: "goal",
      done_when: "done",
      plan: { title: "Digest", goal: "goal", steps: [] },
      bindings: { workflow_ids: [], connector_ids: [], skill_slugs: [], web_search: false },
      environment: "prod",
      fingerprint: FINGERPRINT,
    })
    .returning({ id: tasks.id });
  if (!row) throw new Error("task seed failed");
  return row.id;
}

async function seedRun(taskId: string, conversationId: string, createdAt: Date): Promise<void> {
  traceCounter += 1;
  await testDb.db.insert(taskRuns).values({
    tenant_id: tenantId,
    task_id: taskId,
    task_revision: 1,
    fingerprint: FINGERPRINT,
    conversation_id: conversationId,
    trigger: "cron",
    state: "completed",
    deadline_at: new Date(createdAt.getTime() + 4 * 3_600_000),
    trace_id: traceCounter.toString(16).padStart(32, "0"),
    created_at: createdAt,
    updated_at: createdAt,
    ended_at: new Date(createdAt.getTime() + 30 * MINUTE),
  });
}

async function seedTurn(conversationId: string, createdAt: Date, tenant = tenantId) {
  await testDb.db.insert(conversationTurns).values({
    tenant_id: tenant,
    conversation_id: conversationId,
    state: "completed",
    created_at: createdAt,
    updated_at: createdAt,
  });
}

async function seedAsk(
  conversationId: string,
  createdAt: Date,
  values: {
    tool?: string | null;
    status?: "pending" | "resolved" | "cancelled" | "timeout";
    output?: Record<string, unknown> | null;
    reason?: string | null;
    tool_name?: string;
    tenant?: string;
  } = {},
) {
  const tool = values.tool === undefined ? "send_email" : values.tool;
  await testDb.db.insert(conversationElicitations).values({
    tenant_id: values.tenant ?? tenantId,
    conversation_id: conversationId,
    tool_name: values.tool_name ?? "ask_user_confirm",
    summary: "Confirm",
    input: tool ? { kind: "external_write", target: { tool, args: {} } } : { question: "Sure?" },
    output: values.output ?? null,
    status: values.status ?? "resolved",
    decision_reason: values.reason ?? null,
    created_at: createdAt,
    updated_at: createdAt,
  });
}

async function seedCover(tool: string, reason: string, ts: Date) {
  await testDb.db.insert(auditLog).values({
    id: uuid(),
    ts,
    tenant_id: tenantId,
    actor_type: "system",
    action: AuditAction.TOOL_POLICY_CONFIRMATION_SKIPPED,
    resource_type: "conversation",
    result: "success",
    reason,
    metadata: { tool, resolver_reason: reason },
  });
}

beforeAll(async () => {
  if (skip) return;
  testDb = await createTestDb("stats-agg-confirmations");
  tenantId = (await seedTenant(testDb.db, { slug: "confirm-figures", display_name: "Confirm" })).id;
  otherTenantId = (
    await seedTenant(testDb.db, { slug: "confirm-figures-other", display_name: "Other" })
  ).id;
  const chat = await seedConversation(testDb.db, { tenant_id: tenantId });
  const quiet = await seedConversation(testDb.db, { tenant_id: tenantId });
  const runConversation = await seedConversation(testDb.db, { tenant_id: tenantId });
  const idleRunConversation = await seedConversation(testDb.db, { tenant_id: tenantId });
  const foreign = await seedConversation(testDb.db, { tenant_id: otherTenantId });
  const taskId = await seedTask();

  await seedTurn(chat.id, at(0));
  await seedAsk(chat.id, at(1), { output: { confirmed: true } });
  await seedAsk(chat.id, at(2), { output: { confirmed: false } });
  await seedTurn(chat.id, at(10));
  await seedAsk(chat.id, at(11), { status: "timeout", reason: "approval_expired" });
  await seedAsk(chat.id, at(12), { status: "cancelled", reason: "superseded_by_new_elicitation" });
  await seedAsk(chat.id, at(13), { tool: null, status: "pending" });
  await seedAsk(chat.id, at(14), { tool_name: "ask_user_choice", tool: null });
  await seedAsk(chat.id, new Date(FROM.getTime() - MINUTE));
  await seedTurn(quiet.id, at(20));

  await seedRun(taskId, runConversation.id, at(30));
  await seedTurn(runConversation.id, at(30));
  await seedAsk(runConversation.id, at(31), { tool: "run_workflow", output: { approved: true } });
  await seedAsk(runConversation.id, at(32), { tool: "run_workflow", status: "cancelled" });
  await seedAsk(runConversation.id, at(33), { tool: "run_workflow", output: { declined: true } });
  await seedRun(taskId, idleRunConversation.id, at(40));
  await seedTurn(idleRunConversation.id, at(40));

  await seedCover("send_email", "standing_rule", at(50));
  await seedCover("send_email", "user_instruction", at(51));
  await seedCover("run_workflow", "authority_covered", at(52));
  await seedCover("run_workflow", "authority_covered", TO);

  await seedTurn(foreign.id, at(0), otherTenantId);
  await seedAsk(foreign.id, at(1), { tenant: otherTenantId });
});

afterAll(async () => {
  if (skip) return;
  await testDb.cleanup();
});

describe("readConfirmationFacts", () => {
  test("reads the asks per run, counting a run without a question as 0", async () => {
    if (skip) return;
    const facts = await readConfirmationFacts(testDb.db, { tenantId, from: FROM, to: TO });
    expect([...facts.asks_per_run].sort((left, right) => left - right)).toEqual([0, 3]);
    expect(facts).toMatchObject({ turns: 5, turns_with_ask: 3 });
  });
});

describe("aggregateConfirmations", () => {
  test("records each outcome of an ask from the stored confirmation", async () => {
    if (skip) return;
    const figures = await aggregateConfirmations(testDb.db, { tenantId, from: FROM, to: TO });
    expect(figures.outcomes).toEqual({
      granted: 2,
      declined: 2,
      expired: 1,
      superseded: 1,
      cancelled: 1,
      open: 1,
    });
    expect(figures.kinds).toEqual({ policy_gate: 7, ask_user: 1 });
    expect(figures.covered_by).toEqual({ rule: 1, instruction: 1, authority: 1 });
    expect(figures).toMatchObject({ asked: 8, covered: 3 });
  });

  test("aggregates per turn and per task run", async () => {
    if (skip) return;
    const figures = await aggregateConfirmations(testDb.db, { tenantId, from: FROM, to: TO });
    expect(figures.per_turn).toEqual({ turns: 5, turns_with_ask: 3, asked_per_turn: 1.6 });
    expect(figures.per_task_run).toEqual({
      runs: 2,
      runs_with_ask: 1,
      asked: 3,
      asked_per_run: 1.5,
      median_per_run: 1.5,
    });
  });

  test("splits by tool, with the asks inside task runs and the covered calls", async () => {
    if (skip) return;
    const figures = await aggregateConfirmations(testDb.db, { tenantId, from: FROM, to: TO });
    expect(
      figures.tools.map((row) => ({
        tool: row.tool,
        asked: row.asked,
        in_runs: row.asked_in_task_runs,
        covered: row.covered,
      })),
    ).toEqual([
      {
        tool: "send_email",
        asked: 4,
        in_runs: 0,
        covered: { rule: 1, instruction: 1, authority: 0 },
      },
      {
        tool: "run_workflow",
        asked: 3,
        in_runs: 3,
        covered: { rule: 0, instruction: 0, authority: 1 },
      },
      {
        tool: "ask_user_confirm",
        asked: 1,
        in_runs: 0,
        covered: { rule: 0, instruction: 0, authority: 0 },
      },
    ]);
  });

  test("a window without activity counts nothing", async () => {
    if (skip) return;
    const figures = await aggregateConfirmations(testDb.db, {
      tenantId,
      from: TO,
      to: new Date(TO.getTime() + MINUTE),
    });
    expect(figures).toMatchObject({ asked: 0, covered: 1 });
    expect(figures.per_turn.asked_per_turn).toBeNull();
    expect(figures.per_task_run.median_per_run).toBeNull();
  });
});
