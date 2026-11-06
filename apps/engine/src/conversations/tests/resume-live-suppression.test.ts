import { afterAll, beforeAll, beforeEach, expect, test } from "bun:test";
import {
  conversationMessages,
  conversations,
  conversationToolCalls,
  workflows,
  workflowVersions,
} from "../../db/schema/index.ts";
import { getMockProvider, resetMockProvider } from "../../llm/mock-provider.ts";
import { createLlmTestCtx, type LlmTestCtx } from "../../llm/tests/setup.ts";
import { runLoop } from "../loop/index.ts";

const PREPARE_WITHOUT_LIVE_EFFECTS =
  "Bereite diesen Ablauf für den automatischen Betrieb vor. Nicht aktivieren, keine Live-Wirkungen freigeben oder ausführen. Erlaubte Prüfungen selbst übernehmen.";

let ctx: LlmTestCtx;
beforeAll(async () => {
  ctx = await createLlmTestCtx("resume_live_suppression");
});
afterAll(async () => {
  await ctx?.cleanup();
});
beforeEach(() => {
  resetMockProvider();
});

let sequence = 0;

async function savedWorkflow() {
  const slug = `resume-suppression-${++sequence}`;
  const [workflow] = await ctx.testDb.db
    .insert(workflows)
    .values({ tenant_id: ctx.tenant_id, slug, name: slug, lifecycle: "active" })
    .returning();
  if (!workflow) throw new Error("missing workflow");
  const [version] = await ctx.testDb.db
    .insert(workflowVersions)
    .values({
      tenant_id: ctx.tenant_id,
      workflow_id: workflow.id,
      version: 1,
      dag: {
        name: slug,
        slug,
        steps: [
          { id: "shape", kind: "transform", language: "javascript", expression: "return 1;" },
        ],
      },
    })
    .returning();
  if (!version) throw new Error("missing version");
  return workflow.id;
}

async function conversationWith(first: string) {
  const workflow_id = await savedWorkflow();
  const [conversation] = await ctx.testDb.db
    .insert(conversations)
    .values({ tenant_id: ctx.tenant_id, status: "active", target_workflow_id: workflow_id })
    .returning();
  if (!conversation) throw new Error("missing conversation");
  await ctx.testDb.db.insert(conversationMessages).values({
    tenant_id: ctx.tenant_id,
    conversation_id: conversation.id,
    role: "user",
    content: { text: first },
  });
  return { ...conversation, workflow_id };
}

async function resume(conversation_id: string, workflow_id: string) {
  getMockProvider().setConversePlan(conversation_id, [{ text: "Weiter." }]);
  await runLoop({
    db: ctx.testDb.db,
    tenant_id: ctx.tenant_id,
    conversation_id,
    actor_id: null,
    connector_id: null,
    workflow_id,
    user_message: null,
    turn_abort_ctrl: new AbortController(),
    surface: "chat",
    step_budget: 2,
  });
  return getMockProvider();
}

test("a resume turn keeps live runs out of the palette after a no-live-effects instruction", async () => {
  const neutral = await conversationWith(
    "Bereite diesen Ablauf für den automatischen Betrieb vor.",
  );
  const baseline = await resume(neutral.id, neutral.workflow_id);
  expect(baseline.toolPalettes[0]?.some((tool) => tool.name === "run_workflow")).toBe(true);
  resetMockProvider();
  const vetoed = await conversationWith(PREPARE_WITHOUT_LIVE_EFFECTS);
  const mock = await resume(vetoed.id, vetoed.workflow_id);
  expect(mock.toolPalettes.length).toBeGreaterThan(0);
  for (const palette of mock.toolPalettes)
    expect(palette.some((tool) => tool.name === "run_workflow")).toBe(false);
});

test("a resume turn after an answered question continues with the refused call's permitted step", async () => {
  const conversation = await conversationWith(PREPARE_WITHOUT_LIVE_EFFECTS);
  const base = new Date("2026-05-01T08:00:00.000Z").getTime();
  await ctx.testDb.db.insert(conversationToolCalls).values([
    {
      tenant_id: ctx.tenant_id,
      conversation_id: conversation.id,
      tool: "list_workflows",
      input: {},
      output: {
        ok: false,
        data: { error_code: "workflow_activation_required", next_best_actions: ["list_workflows"] },
      },
      created_at: new Date(base),
    },
    {
      tenant_id: ctx.tenant_id,
      conversation_id: conversation.id,
      tool: "run_workflow",
      input: {},
      output: {
        ok: false,
        data: {
          error_code: "workflow_activation_required",
          next_best_actions: ["list_executions"],
        },
      },
      created_at: new Date(base + 1_000),
    },
    {
      tenant_id: ctx.tenant_id,
      conversation_id: conversation.id,
      tool: "ask_user_choice",
      input: {},
      output: { ok: true, data: { status: "resolved" } },
      created_at: new Date(base + 2_000),
    },
  ]);
  const mock = await resume(conversation.id, conversation.workflow_id);
  expect(mock.toolPalettes[0]?.some((tool) => tool.name === "list_executions")).toBe(true);
  expect(JSON.stringify(mock.toolChoices[0])).toContain("required");
});
