import { afterAll, beforeAll, beforeEach, describe, expect, test } from "bun:test";
import { eq } from "drizzle-orm";
import {
  conversationElicitations,
  conversations,
  conversationToolCalls,
  taskRuns,
  tasks,
  tenants,
  users,
} from "../../db/schema/index.ts";
import { notificationRules } from "../../db/schema/notifications.ts";
import { SLACK_DECISION_COPY } from "../../http/i18n/slack-decisions.ts";
import { builtinRoleId } from "../../rbac/roles.ts";
import { createDeterministicUuidFactory } from "../../test-helpers/determinism/ids.ts";
import { requestApproval } from "../../tools/approval.ts";
import { __resetBreakers } from "../circuit-breaker.ts";
import { __resetRateLimiter } from "../rate-limit.ts";
import { dispatchEvent } from "../service.ts";
import { slackDecisionBlocks } from "../slack-decision-card.ts";
import { createNotificationCtx, FakeAdapter, type NotificationTestCtx } from "./setup.ts";

const nextId = createDeterministicUuidFactory(0x5c4d);
const BASE = "https://subkit.example.com";

let ctx: NotificationTestCtx;
let ownerId: string;

beforeAll(async () => {
  ctx = await createNotificationCtx("slack_card");
  await ctx.db.update(tenants).set({ language: "de" }).where(eq(tenants.id, ctx.tenant_id));
  const [owner] = await ctx.db
    .insert(users)
    .values({
      tenant_id: ctx.tenant_id,
      email: "owner@card.test",
      role_id: await builtinRoleId(ctx.db, "admin"),
    })
    .returning();
  if (!owner) throw new Error("seed owner");
  ownerId = owner.id;
}, 120_000);

afterAll(async () => {
  await ctx?.cleanup();
}, 120_000);

beforeEach(() => {
  __resetBreakers();
  __resetRateLimiter();
});

async function heldRun(
  withApproval: boolean,
): Promise<{ task_run_id: string; approval_id: string }> {
  const tenant_id = ctx.tenant_id;
  const [task] = await ctx.db
    .insert(tasks)
    .values({
      tenant_id,
      name: "Weekly report",
      owner_id: ownerId,
      goal: "send the weekly report",
      done_when: "the report is sent",
      plan: {},
      bindings: { workflow_ids: [], connector_ids: [], skill_slugs: [], web_search: false },
      environment: "prod",
      fingerprint: nextId().replace(/-/g, "").padEnd(64, "0"),
      locale: "de",
    })
    .returning();
  const [conversation] = await ctx.db
    .insert(conversations)
    .values({ tenant_id, owner_id: ownerId, status: "awaiting_input", draft: {} })
    .returning();
  if (!task || !conversation) throw new Error("seed task");
  const approval_id = nextId();
  if (withApproval) {
    await requestApproval({
      db: ctx.db,
      principal: { provider: "test", kind: "user", id: ownerId, tenant_id, roles: ["admin"] },
      approval_id,
      tool: "run_workflow",
      surface: "mcp",
      via: "mcp",
      reason: "held_writes",
      execution_mode: "prod",
      args: { workflow: "report" },
    });
    const [call] = await ctx.db
      .insert(conversationToolCalls)
      .values({
        tenant_id,
        conversation_id: conversation.id,
        tool: "run_workflow",
        input: {},
        approval_required: true,
      })
      .returning();
    if (!call) throw new Error("seed tool call");
    await ctx.db.insert(conversationElicitations).values({
      tenant_id,
      conversation_id: conversation.id,
      tool_call_id: call.id,
      tool_name: "request_human_approval",
      summary: "approve the run",
      input: { commit_intent: { payload: { approval_id } } },
      status: "pending",
    });
  }
  const [run] = await ctx.db
    .insert(taskRuns)
    .values({
      tenant_id,
      task_id: task.id,
      task_revision: 1,
      fingerprint: task.fingerprint,
      conversation_id: conversation.id,
      trigger: "manual",
      state: "waiting",
      waiting_reason: "approval",
      deadline_at: new Date("2026-11-24T10:00:00.000Z"),
      trace_id: "b".repeat(32),
    })
    .returning();
  if (!run) throw new Error("seed run");
  return { task_run_id: run.id, approval_id };
}

function waitingEvent(task_run_id: string) {
  return {
    tenant_id: ctx.tenant_id,
    type: "task_run.waiting",
    severity: "warn" as const,
    payload: { task_run_id, task_id: nextId(), trigger: "manual", waiting_reason: "approval" },
  };
}

function actionIds(blocks: unknown): string[] {
  const actions = (blocks as Array<{ type: string; elements?: Array<{ action_id: string }> }>).find(
    (block) => block.type === "actions",
  );
  return actions?.elements?.map((element) => element.action_id) ?? [];
}

describe("Slack decision card on notifications", () => {
  test("a run held for approval is posted with approve, decline and the deep link", async () => {
    const { task_run_id, approval_id } = await heldRun(true);
    const blocks = await slackDecisionBlocks(ctx.db, waitingEvent(task_run_id), BASE);
    expect(actionIds(blocks)).toEqual([
      `sk_decide:approve:tool_approval:${approval_id}`,
      `sk_decide:decline:tool_approval:${approval_id}`,
      `sk_open:tool_approval:${approval_id}`,
    ]);
    const serialized = JSON.stringify(blocks);
    expect(serialized).toContain(SLACK_DECISION_COPY.de.heldRunTitle("Weekly report"));
    expect(serialized).toContain(SLACK_DECISION_COPY.de.approve);
    expect(serialized).toContain(`${BASE}/cockpit/tasks/`);
  }, 60_000);

  test("without an open approval the card keeps only the deep link", async () => {
    const { task_run_id } = await heldRun(false);
    const blocks = await slackDecisionBlocks(ctx.db, waitingEvent(task_run_id), BASE);
    expect(actionIds(blocks)).toEqual([`sk_open:task_run:${task_run_id}`]);
  }, 60_000);

  test("dispatch attaches the card to the Slack delivery and keeps the text fallback", async () => {
    const { task_run_id, approval_id } = await heldRun(true);
    await ctx.db.insert(notificationRules).values({
      tenant_id: ctx.tenant_id,
      name: "held-runs",
      event_pattern: "task_run.*",
      severity: "info",
      target_workspace_id: "T_CARD",
      target_channel_id: "C_CARD",
    });
    const adapter = new FakeAdapter();
    const result = await dispatchEvent(
      { db: ctx.db, resolveAdapter: () => adapter },
      waitingEvent(task_run_id),
    );
    expect(result.delivered).toBe(1);
    expect(adapter.sends[0]?.text).toContain("task_run.waiting");
    expect(actionIds(adapter.sends[0]?.blocks)).toContain(
      `sk_decide:approve:tool_approval:${approval_id}`,
    );
  }, 60_000);

  test("other events keep the plain notification", async () => {
    expect(
      await slackDecisionBlocks(
        ctx.db,
        { tenant_id: ctx.tenant_id, type: "execution.failed" },
        BASE,
      ),
    ).toBeNull();
  });
});
