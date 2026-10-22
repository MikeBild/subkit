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

const PREPARE_WITHOUT_LIVE_EFFECTS =
  "Bereite diesen Ablauf für den automatischen Betrieb vor. Nicht aktivieren, keine Live-Wirkungen freigeben oder ausführen. Erlaubte Prüfungen selbst übernehmen.";

let ctx: ConversationTestCtx;
beforeAll(async () => {
  ctx = await createConversationTestCtx("prepare-without-live-effects");
});
afterAll(async () => {
  await ctx.cleanup();
});

async function inactiveDraft(slug: string) {
  const db = ctx.testDb.db;
  const [workflow] = await db
    .insert(workflows)
    .values({ tenant_id: ctx.tenant_id, slug, name: slug, lifecycle: "draft" })
    .returning();
  if (!workflow) throw new Error("missing workflow");
  const [version] = await db
    .insert(workflowVersions)
    .values({
      tenant_id: ctx.tenant_id,
      workflow_id: workflow.id,
      version: 1,
      dag: {
        name: slug,
        slug,
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
  if (!version) throw new Error("missing version");
  await db
    .update(workflows)
    .set({ draft_version_id: version.id })
    .where(and(eq(workflows.tenant_id, ctx.tenant_id), eq(workflows.id, workflow.id)));
  return workflow.id;
}

test("preparing an inactive draft without live effects previews it with held writes on the first turn and never runs or activates it", async () => {
  const db = ctx.testDb.db;
  const workflow_id = await inactiveDraft("prepare-without-live-effects");
  const conv = await createConversationWithTurn(
    { tenant_id: ctx.tenant_id, actor_id: ctx.user_id, workflow_id },
    db,
  );
  const mock = getMockProvider();
  mock.setConversePlan(conv.conversation.id, [
    { tool: "run_workflow", args: { workflow: workflow_id, input: {} } },
    { text: "Nichts wurde aktiviert oder live ausgeführt." },
  ]);
  const paletteStart = mock.toolPalettes.length;
  const choiceStart = mock.toolChoices.length;
  const outcome = await appendMessageWithTurn(
    {
      tenant_id: ctx.tenant_id,
      conversation_id: conv.conversation.id,
      actor_id: ctx.user_id,
      message: PREPARE_WITHOUT_LIVE_EFFECTS,
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
  expect(palettes.length).toBeGreaterThan(0);
  for (const palette of palettes) {
    expect(palette.some((tool) => tool.name === "run_workflow")).toBe(false);
    expect(palette.some((tool) => tool.name.startsWith("wf_"))).toBe(false);
  }
  expect(palettes[0]?.some((tool) => tool.name === "dry_run_workflow")).toBe(true);
  expect(
    mock.toolChoices
      .slice(choiceStart)
      .some((choice) => choice?.type === "tool" && choice.toolName === "run_workflow"),
  ).toBe(false);
  const results = outcome.result.events.filter((event) => event.type === "tool_result");
  expect(results.some((event) => event.tool === "run_workflow")).toBe(false);
  expect(results.find((event) => event.tool === "dry_run_workflow")?.output).toMatchObject({
    auto_committed: false,
  });
  const [stored] = await db
    .select({ lifecycle: workflows.lifecycle, current_version_id: workflows.current_version_id })
    .from(workflows)
    .where(and(eq(workflows.tenant_id, ctx.tenant_id), eq(workflows.id, workflow_id)));
  expect(stored).toEqual({ lifecycle: "draft", current_version_id: null });
});
