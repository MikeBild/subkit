// The converse loop withholds tools for an enumeration question only when the
// tenant snapshot lists every row. With more workflows than the snapshot
// shows, the first step is steered to list_workflows instead — the pin that
// once made the model deny workflows sitting past the 40-row cap.

import { afterAll, beforeAll, expect, test } from "bun:test";
import { workflows } from "../../db/schema/index.ts";
import { MAX_WORKFLOWS_IN_SUMMARY } from "../../llm/core/tenant-summary.ts";
import { getMockProvider } from "../../llm/mock-provider.ts";
import {
  appendMessageWithTurn,
  type ConversationTestCtx,
  createConversationTestCtx,
  createConversationWithTurn,
} from "./setup.ts";

let ctx: ConversationTestCtx;
beforeAll(async () => {
  ctx = await createConversationTestCtx("enum-coverage");
});
afterAll(async () => {
  await ctx.cleanup();
});

async function seedWorkflows(from: number, to: number): Promise<void> {
  const rows = [];
  for (let i = from; i < to; i++) {
    const slug = `enum-wf-${String(i).padStart(2, "0")}`;
    rows.push({ tenant_id: ctx.tenant_id, slug, name: slug, lifecycle: "active" as const });
  }
  await ctx.testDb.db.insert(workflows).values(rows);
}

async function firstToolChoiceFor(message: string, plan: Array<{ tool: string }>) {
  const db = ctx.testDb.db;
  const conv = await createConversationWithTurn(
    { tenant_id: ctx.tenant_id, actor_id: ctx.user_id },
    db,
  );
  const mock = getMockProvider();
  mock.setConversePlan(
    conv.conversation.id,
    plan.map((step) => ({ ...step, args: {} })),
  );
  const start = mock.toolChoices.length;
  await appendMessageWithTurn(
    {
      tenant_id: ctx.tenant_id,
      conversation_id: conv.conversation.id,
      actor_id: ctx.user_id,
      message,
      principal: {
        provider: "test",
        kind: "user",
        id: ctx.user_id,
        tenant_id: ctx.tenant_id,
        roles: ["admin"],
      },
    },
    db,
  );
  return mock.toolChoices.slice(start)[0];
}

test("a complete snapshot answers an enumeration with tools withheld", async () => {
  await seedWorkflows(0, 3);
  const choice = await firstToolChoiceFor("welche workflows habe ich", []);
  expect(choice?.type).toBe("none");
});

test("a trimmed snapshot keeps tools and steers the first step to list_workflows", async () => {
  await seedWorkflows(3, MAX_WORKFLOWS_IN_SUMMARY + 1);
  const choice = await firstToolChoiceFor("welche workflows habe ich", [
    { tool: "list_workflows" },
  ]);
  expect(choice).toEqual({ type: "tool", toolName: "list_workflows" });
});
