import { afterAll, beforeAll, expect, test } from "bun:test";
import { and, eq } from "drizzle-orm";
import { workflows } from "../../db/schema/index.ts";
import { getMockProvider } from "../../llm/mock-provider.ts";
import {
  appendMessageWithTurn,
  type ConversationTestCtx,
  createConversationTestCtx,
  createConversationWithTurn,
} from "./setup.ts";

const SLUG = "new-workflow-preview-save";

let ctx: ConversationTestCtx;
beforeAll(async () => {
  ctx = await createConversationTestCtx("new-workflow-preview-save");
});
afterAll(async () => {
  await ctx.cleanup();
});

test("a new workflow authored on the web surface reaches the held preview and save", async () => {
  const db = ctx.testDb.db;
  const conv = await createConversationWithTurn(
    { tenant_id: ctx.tenant_id, actor_id: ctx.user_id },
    db,
  );
  const mock = getMockProvider();
  mock.setConversePlan(conv.conversation.id, [
    {
      tool: "edit_workflow_patch",
      args: {
        patches: [
          { op: "replace", path: "/name", value: SLUG },
          { op: "add", path: "/slug", value: SLUG },
          { op: "add", path: "/description", value: "Greets the caller by name." },
          {
            op: "add",
            path: "/steps/-",
            value: {
              id: "greet",
              kind: "transform",
              language: "javascript",
              expression: "return { greeting: 'Hello ' + (input.input.name ?? 'there') };",
            },
          },
        ],
      },
    },
    { tool: "validate_draft", args: {} },
    { tool: "dry_run_workflow", args: { input: { name: "Ada" } } },
    { tool: "save_workflow_draft", args: {} },
    { text: "The workflow is previewed and saved." },
  ]);
  const paletteStart = mock.toolPalettes.length;
  const outcome = await appendMessageWithTurn(
    {
      tenant_id: ctx.tenant_id,
      conversation_id: conv.conversation.id,
      actor_id: ctx.user_id,
      message: "Build a new workflow that greets the caller by name.",
      surface: "web",
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
  const palettes = mock.toolPalettes.slice(paletteStart);
  for (const palette of palettes) {
    expect(palette.some((tool) => tool.name === "run_workflow")).toBe(false);
    expect(palette.some((tool) => tool.name.startsWith("wf_"))).toBe(false);
  }
  expect(palettes.some((palette) => palette.some((t) => t.name === "dry_run_workflow"))).toBe(true);
  const results = outcome.result.events.filter((event) => event.type === "tool_result");
  expect(results.find((event) => event.tool === "dry_run_workflow")?.output).toMatchObject({
    blocking_reasons: [],
  });
  expect(results.some((event) => event.tool === "save_workflow_draft")).toBe(true);
  expect(results.some((event) => event.tool === "run_workflow")).toBe(false);
  const [stored] = await db
    .select({
      lifecycle: workflows.lifecycle,
      draft_version_id: workflows.draft_version_id,
      current_version_id: workflows.current_version_id,
    })
    .from(workflows)
    .where(and(eq(workflows.tenant_id, ctx.tenant_id), eq(workflows.slug, SLUG)));
  expect(stored?.lifecycle).toBe("draft");
  expect(stored?.draft_version_id).toBeTruthy();
  expect(stored?.current_version_id).toBeNull();
});
