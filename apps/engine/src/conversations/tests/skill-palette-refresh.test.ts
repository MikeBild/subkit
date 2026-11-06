import { afterAll, beforeAll, expect, test } from "bun:test";
import { conversations, skills } from "../../db/schema/index.ts";
import { getMockProvider } from "../../llm/mock-provider.ts";
import { createLlmTestCtx, type LlmTestCtx } from "../../llm/tests/setup.ts";
import { runLoop } from "../loop/index.ts";

let ctx: LlmTestCtx;
beforeAll(async () => {
  ctx = await createLlmTestCtx("skill_palette_refresh");
});
afterAll(async () => {
  await ctx?.cleanup();
});

test("loading a skill exposes a gated authoring tool on the very next model step", async () => {
  await ctx.testDb.db.insert(skills).values({
    tenant_id: ctx.tenant_id,
    slug: "workflow-authoring",
    title: "Workflow authoring",
    body: "Use inspect_workflow_draft to inspect the current workflow draft.",
    scope: "global",
    lifecycle: "active",
    maturity: "experimental",
    source: "template",
    activates_when: [],
  });
  const [conversation] = await ctx.testDb.db
    .insert(conversations)
    .values({ tenant_id: ctx.tenant_id, status: "active" })
    .returning();
  if (!conversation) throw new Error("missing conversation");
  const mock = getMockProvider();
  mock.setConversePlan(conversation.id, [
    { tool: "load_skill", args: { slug: "workflow-authoring" } },
    { tool: "inspect_workflow_draft", args: {} },
    { text: "The current workflow draft has no saved workflow." },
  ]);
  const result = await runLoop({
    db: ctx.testDb.db,
    tenant_id: ctx.tenant_id,
    conversation_id: conversation.id,
    actor_id: null,
    connector_id: null,
    workflow_id: null,
    user_message: "Help with a task",
    turn_abort_ctrl: new AbortController(),
    surface: "web",
    step_budget: 5,
  });
  expect(mock.toolPalettes[0]?.some((tool) => tool.name === "inspect_workflow_draft")).toBe(false);
  expect(
    mock.toolPalettes
      .slice(1)
      .some((palette) => palette.some((tool) => tool.name === "inspect_workflow_draft")),
  ).toBe(true);
  expect(
    result.events.some(
      (event) => event.type === "tool_call_start" && event.tool === "inspect_workflow_draft",
    ),
  ).toBe(true);
});
