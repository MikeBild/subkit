import { afterAll, beforeAll, expect, test } from "bun:test";
import { and, eq } from "drizzle-orm";
import { workflows, workflowVersions } from "../../db/schema/index.ts";
import { getMockProvider } from "../../llm/mock-provider.ts";
import {
  appendMessageWithTurn,
  type ConversationTestCtx,
  createConversationTestCtx,
  createConversationWithTurn,
} from "./setup.ts";

let ctx: ConversationTestCtx;
beforeAll(async () => {
  ctx = await createConversationTestCtx("intent-release");
});
afterAll(async () => {
  await ctx.cleanup();
});
test("one requested run leaves subsequent SDK steps free to inspect and answer", async () => {
  const db = ctx.testDb.db;
  const [wf] = await db
    .insert(workflows)
    .values({
      tenant_id: ctx.tenant_id,
      slug: "intent-release",
      name: "Report",
      lifecycle: "active",
    })
    .returning();
  const [version] = await db
    .insert(workflowVersions)
    .values({
      tenant_id: ctx.tenant_id,
      workflow_id: wf!.id,
      version: 1,
      dag: {
        name: "Report",
        slug: "intent-release",
        steps: [
          {
            id: "result",
            kind: "transform",
            language: "javascript",
            expression: "return {checked: true};",
          },
        ],
      },
    })
    .returning();
  await db
    .update(workflows)
    .set({ current_version_id: version!.id })
    .where(and(eq(workflows.tenant_id, ctx.tenant_id), eq(workflows.id, wf!.id)));
  const conv = await createConversationWithTurn(
    { tenant_id: ctx.tenant_id, actor_id: ctx.user_id, workflow_id: wf!.id },
    db,
  );
  const mock = getMockProvider();
  mock.setConversePlan(conv.conversation.id, [
    { tool: "run_workflow", args: { workflow: wf!.id, input: {}, execute_writes: false } },
    { tool: "inspect_workflow", args: { sections: ["input_schema"] } },
  ]);
  const start = mock.toolChoices.length;
  const outcome = await appendMessageWithTurn(
    {
      tenant_id: ctx.tenant_id,
      conversation_id: conv.conversation.id,
      actor_id: ctx.user_id,
      message: "Run this workflow now in preview mode, without sending anything.",
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
  const results = outcome.result.events.filter((event) => event.type === "tool_result");
  expect(results).toHaveLength(2);
  expect(results.find((event) => event.tool === "run_workflow")?.output).toMatchObject({
    status: "succeeded",
  });
  expect(results.find((event) => event.tool === "inspect_workflow")?.output).toMatchObject({
    step_count: 1,
  });
  const choices = mock.toolChoices.slice(start);
  expect(choices[0]).toEqual({ type: "tool", toolName: "run_workflow" });
  expect(choices.length).toBeGreaterThan(1);
  expect(choices.slice(1).every((choice) => choice?.type === "auto")).toBe(true);
  expect(
    outcome.result.events.filter(
      (event) => event.type === "tool_call_start" && event.tool === "run_workflow",
    ),
  ).toHaveLength(1);
});
