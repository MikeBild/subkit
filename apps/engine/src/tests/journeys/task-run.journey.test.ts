import { afterAll, beforeAll, describe, expect, test } from "bun:test";
import { and, eq } from "drizzle-orm";
import { conversations } from "../../db/schema/index.ts";
import { type ConverseMockStep, getMockProvider } from "../../llm/mock-provider.ts";
import { registerTaskRunTurnHandler } from "../../queue/handlers/task-run-turn.ts";
import { TASK_RUN_TURN_QUEUE } from "../../queue/queues.ts";
import { waitForJson } from "../../test-helpers/determinism/wait.ts";
import { createJourneyCtx, JOURNEY_HOOK_TIMEOUT, type JourneyCtx, journeyFetch } from "./setup.ts";

const GOAL = "Summarize the open invoices";
const SUMMARY = "Three invoices are open, 1.240 € in total.";

interface PlanStep {
  id: string;
  criterion: Record<string, unknown>;
  [key: string]: unknown;
}

interface Plan {
  steps: PlanStep[];
  [key: string]: unknown;
}

interface Run {
  id: string;
  task_id: string;
  conversation_id: string;
  state: string;
  failure_code: string | null;
  turns_used: number;
  result_ready_at: string | null;
  ended_at: string | null;
}

interface AttentionItem {
  id: string;
  class: string;
  reason: string;
  detail: string | null;
  subject: { kind: string; id: string; name: string };
  actions: Array<{ verb: string; href: string }>;
}

interface AuditEntry {
  action: string;
  result: string;
  actor_type: string;
  details: Record<string, unknown>;
}

let ctx: JourneyCtx;
let summaryTaskId = "";
let summaryRun: Run;
let stuckTaskId = "";
let stuckRun: Run;

function taskBody(name: string, max_turns?: number) {
  return {
    name,
    goal: GOAL,
    done_when: "The summary is written",
    plan: {
      title: name,
      goal: GOAL,
      steps: [
        {
          id: "summary",
          label: "Write the summary",
          criterion: { kind: "assessment", description: "Summary is written", result: null },
          depends_on: [],
          evidence_ids: [],
          note: null,
          progress: "open",
          next_action: null,
        },
      ],
      cancelled: false,
      completion_step_id: null,
    },
    bindings: { workflow_ids: [], connector_ids: [], skill_slugs: [], web_search: false },
    environment: "dev",
    ...(max_turns === undefined ? {} : { max_turns }),
  };
}

async function createTask(
  name: string,
  max_turns?: number,
): Promise<{ id: string; max_turns: number }> {
  const res = await journeyFetch(ctx, "/v1/tasks", {
    method: "POST",
    body: JSON.stringify(taskBody(name, max_turns)),
  });
  expect(res.status).toBe(201);
  return (await res.json()) as { id: string; max_turns: number };
}

async function startRun(task_id: string): Promise<Run> {
  await ctx.boss.offWork(TASK_RUN_TURN_QUEUE);
  const res = await journeyFetch(ctx, `/v1/tasks/${task_id}/runs`, { method: "POST" });
  expect(res.status).toBe(201);
  return (await res.json()) as Run;
}

async function playbookOf(conversation_id: string): Promise<{ plan: Plan; revision: number }> {
  const [row] = await ctx.db
    .select({ playbook: conversations.playbook, revision: conversations.playbook_revision })
    .from(conversations)
    .where(and(eq(conversations.tenant_id, ctx.tenantId), eq(conversations.id, conversation_id)));
  if (!row) throw new Error("missing conversation");
  return { plan: (row.playbook as { plan: Plan }).plan, revision: row.revision };
}

async function letTheModelWork(conversation_id: string, steps: ConverseMockStep[]): Promise<void> {
  getMockProvider().setConversePlan(conversation_id, steps);
  await registerTaskRunTurnHandler({ boss: ctx.boss, db: ctx.db });
}

function runSettles(run_id: string): Promise<Run> {
  return waitForJson<Run>(
    () => journeyFetch(ctx, `/v1/task-runs/${run_id}`),
    (run) => run.state !== "running",
    { tries: 2_000, label: `task run ${run_id}` },
  );
}

async function auditOf(run_id: string): Promise<AuditEntry[]> {
  const res = await journeyFetch(ctx, `/v1/audit-log?task_run_id=${run_id}`);
  expect(res.status).toBe(200);
  return ((await res.json()) as { items: AuditEntry[] }).items;
}

async function attentionFor(task_id: string): Promise<AttentionItem | undefined> {
  const res = await journeyFetch(ctx, "/v1/attention");
  expect(res.status).toBe(200);
  const body = (await res.json()) as { items: AttentionItem[] };
  return body.items.find((item) => item.subject.kind === "task" && item.subject.id === task_id);
}

beforeAll(async () => {
  ctx = await createJourneyCtx("core-task-run");
}, JOURNEY_HOOK_TIMEOUT);

afterAll(async () => {
  if (ctx?.cleanup) await ctx.cleanup();
}, JOURNEY_HOOK_TIMEOUT);

describe("a task hands over a written result, a stuck run stops at its round limit", () => {
  test("a new task allows ten rounds per run unless the person sets another limit", async () => {
    const task = await createTask("Invoice summary");
    expect(task.max_turns).toBe(10);
    summaryTaskId = task.id;
  });

  test("the run with the fake model writes its result and waits for the person", async () => {
    summaryRun = await startRun(summaryTaskId);
    expect(summaryRun.state).toBe("running");
    const { plan, revision } = await playbookOf(summaryRun.conversation_id);
    const written: Plan = {
      ...plan,
      steps: plan.steps.map((step) => ({
        ...step,
        progress: "waiting_for_input",
        criterion: { ...step.criterion, result: SUMMARY },
      })),
    };
    await letTheModelWork(summaryRun.conversation_id, [
      { tool: "update_playbook", args: { expected_revision: revision, plan: written } },
      { text: SUMMARY },
    ]);
    const settled = await runSettles(summaryRun.id);
    expect(settled).toMatchObject({ state: "result_ready", failure_code: null, turns_used: 1 });
    expect(settled.result_ready_at).not.toBeNull();
  });

  test("the written result is readable in the run's conversation and its playbook", async () => {
    const res = await journeyFetch(ctx, `/v1/conversations/${summaryRun.conversation_id}`);
    expect(res.status).toBe(200);
    const body = (await res.json()) as {
      messages: Array<{ role: string; parts: Array<{ type: string; text?: string }> }>;
    };
    const said = body.messages
      .filter((message) => message.role === "assistant")
      .flatMap((message) => message.parts)
      .filter((part) => part.type === "text")
      .map((part) => part.text);
    expect(said).toContain(SUMMARY);
    const { plan } = await playbookOf(summaryRun.conversation_id);
    expect(plan.steps.map((step) => step.criterion.result)).toEqual([SUMMARY]);
  });

  test("the overview asks the person to review the result, and only a browser session may confirm it", async () => {
    const item = await attentionFor(summaryTaskId);
    expect(item).toMatchObject({ class: "decide", reason: "task_result_ready" });
    expect(item?.actions[0]).toMatchObject({
      verb: "review",
      href: `/cockpit/tasks/${summaryTaskId}`,
    });
    const confirm = await journeyFetch(ctx, `/v1/task-runs/${summaryRun.id}/complete`, {
      method: "POST",
    });
    expect(confirm.status).toBe(403);
    expect(((await confirm.json()) as { code: string }).code).toBe("human_session_required");
  });

  test("usage and audit account for the run", async () => {
    const usage = await journeyFetch(ctx, `/v1/tasks/${summaryTaskId}/usage`);
    expect(usage.status).toBe(200);
    const figures = (await usage.json()) as {
      last_run: { task_run_id: string; calls: number; tokens: number };
    };
    expect(figures.last_run.task_run_id).toBe(summaryRun.id);
    expect(figures.last_run.calls).toBeGreaterThan(0);
    expect(figures.last_run.tokens).toBeGreaterThan(0);
    const entries = await auditOf(summaryRun.id);
    expect(entries.map((entry) => entry.action).sort()).toEqual([
      "task_run.result_ready",
      "task_run.started",
    ]);
    expect(entries.find((entry) => entry.action === "task_run.started")?.actor_type).toBe("user");
  });

  test("a run that keeps working without a result is stopped by its round limit", async () => {
    const task = await createTask("Invoice chase", 2);
    stuckTaskId = task.id;
    stuckRun = await startRun(stuckTaskId);
    const { plan, revision } = await playbookOf(stuckRun.conversation_id);
    const round = (n: number): ConverseMockStep[] => [
      {
        tool: "update_playbook",
        args: {
          expected_revision: revision + n - 1,
          plan: {
            ...plan,
            steps: plan.steps.map((step) => ({
              ...step,
              progress: "in_progress",
              note: `Still looking, round ${n}.`,
            })),
          },
        },
      },
      { text: `Still looking, round ${n}.` },
    ];
    await letTheModelWork(stuckRun.conversation_id, [...round(1), ...round(2), ...round(3)]);
    const settled = await runSettles(stuckRun.id);
    expect(settled).toMatchObject({
      state: "failed",
      failure_code: "turn_limit_reached",
      turns_used: 2,
      result_ready_at: null,
    });
    expect(settled.ended_at).not.toBeNull();
  });

  test("the stop names the limit in the audit and on the overview", async () => {
    const entries = await auditOf(stuckRun.id);
    expect(entries.map((entry) => entry.action).sort()).toEqual([
      "task_run.failed",
      "task_run.started",
    ]);
    expect(entries.find((entry) => entry.action === "task_run.failed")).toMatchObject({
      result: "error",
      details: { failure_code: "turn_limit_reached", turns_used: 2 },
    });
    expect(await attentionFor(stuckTaskId)).toMatchObject({
      class: "failing",
      reason: "task_run_failed",
      detail: "turn_limit_reached",
    });
  });

  test("the stopped task is free for the next start", async () => {
    const next = await startRun(stuckTaskId);
    expect(next.state).toBe("running");
    const abort = await journeyFetch(ctx, `/v1/task-runs/${next.id}/abort`, { method: "POST" });
    expect(abort.status).toBe(200);
  });
});
