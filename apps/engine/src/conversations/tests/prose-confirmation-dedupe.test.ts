// Regression for the "ask twice" anti-pattern observed in session
// abeefb33: LLM emits prose "Shall I proceed to delete all 6
// workflows?", user replies "yes", LLM then calls delete_workflow,
// the policy gate fires AGAIN with a structured ConfirmPrompt for the
// same intent — two confirmations for one user decision. Engine-side
// dedupe in sdk-wrap.ts now detects [user-affirm immediately after
// assistant-prose-pre-confirmation referencing the same destructive
// verb + resource] and skips the policy gate.
//
// The fix is intentionally conservative: the heuristic only fires
// when BOTH (a) the prior assistant message contains a recognised
// pre-confirmation phrase + a noun matching the tool's resource
// type, AND (b) the prior user message is one of the canonical short
// affirmations. Any miss falls through to the policy gate.

import { afterAll, beforeAll, describe, expect, test } from "bun:test";
import { eq } from "drizzle-orm";
import type { Db } from "../../db/client.ts";
import { conversationMessages, conversations } from "../../db/schema/index.ts";
import { EngineClient } from "../../engine-client/index.ts";
import { createLlmTestCtx, type LlmTestCtx } from "../../llm/tests/setup.ts";
import type { ToolContext } from "../tools/index.ts";
import { type TurnSignals, wrapTools } from "../tools/sdk-wrap.ts";
import type { TurnEvent } from "../types.ts";

let ctx: LlmTestCtx;

beforeAll(async () => {
  ctx = await createLlmTestCtx("prose-conf-dedupe");
});

afterAll(async () => {
  if (ctx?.cleanup) await ctx.cleanup();
});

function freshSignals(): TurnSignals {
  return {
    step: 0,
    toolChain: Promise.resolve(),
    pendingChildToolCallIds: [],
    pendingChildElicitationIds: [],
    toolInvocationCount: new Map(),
    toolLastErrorHash: new Map(),
    totalLoopWarnings: 0,
    consecutiveFailures: 0,
    lastAssistantText: "",
  };
}

async function freshConversation(): Promise<string> {
  const [row] = await ctx.testDb.db
    .insert(conversations)
    .values({ tenant_id: ctx.tenant_id, status: "active" })
    .returning({ id: conversations.id });
  if (!row) throw new Error("seed conversation failed");
  return row.id;
}

async function seedTwoMessages(
  conversation_id: string,
  asstText: string,
  userText: string,
): Promise<void> {
  // Two messages. The order in conversation_messages is by created_at
  // (asc), but the dedupe walks DESC so newest = user, then assistant.
  // We insert assistant first, then user, with strict timestamps.
  const t = Date.now();
  await ctx.testDb.db.insert(conversationMessages).values({
    tenant_id: ctx.tenant_id,
    conversation_id,
    role: "assistant",
    content: asstText,
    created_at: new Date(t - 1000),
  });
  await ctx.testDb.db.insert(conversationMessages).values({
    tenant_id: ctx.tenant_id,
    conversation_id,
    role: "user",
    content: userText,
    created_at: new Date(t),
  });
}

function makeToolCtx(conversation_id: string): ToolContext {
  const engineClient = new EngineClient({
    tenant_id: ctx.tenant_id,
    actor_id: null,
    actor_type: "system",
    db: ctx.testDb.db as unknown as Db,
  });
  return {
    db: ctx.testDb.db as unknown as Db,
    tenant_id: ctx.tenant_id,
    conversation_id,
    actor_id: null,
    connector_id: null,
    workflow_id: null,
    engineClient,
    getDraft: () => ({ workflow: { name: "", steps: [] } }),
    setDraft: async () => {},
  };
}

describe("policy gate · prose-confirmation dedupe (skip on prior prose+yes)", () => {
  test("delete_workflow skips the gate when prior turn was 'Shall I proceed to delete all workflows?' + user 'yes'", async () => {
    const conversation_id = await freshConversation();
    await seedTwoMessages(
      conversation_id,
      "I'll be deleting your 6 workflows. This is a destructive action and cannot be undone. Shall I proceed to delete all 6 workflows?",
      "yes",
    );
    const signals = freshSignals();
    const events: TurnEvent[] = [];
    const wrapped = wrapTools(
      makeToolCtx(conversation_id),
      signals,
      events,
      ctx.testDb.db as unknown as Db,
      ["workflow-authoring"],
      {},
    );
    const tool = wrapped.delete_workflow;
    expect(tool).toBeDefined();
    // Without the dedupe this would pause with kind=external_write +
    // emit a second confirmation card. With the dedupe the gate is
    // skipped — the tool runs (and fails on workflow_not_found in this
    // unit test, but importantly the failure is NOT
    // "policy_confirm_required").
    // biome-ignore lint/suspicious/noExplicitAny: Tool.execute is generic
    const result = await (tool!.execute as any)(
      { id: "00000000-0000-0000-0000-000000000abc" },
      { toolCallId: "t-del-1", messages: [] },
    );
    expect(result.pause).toBeUndefined();
    // No elicit_request was emitted by the gate.
    expect(events.find((e) => e.type === "elicit_request")).toBeUndefined();
  });

  test("delete_connector with prose 'do you want me to remove the connector?' + user 'go ahead' also dedupes", async () => {
    const conversation_id = await freshConversation();
    await seedTwoMessages(
      conversation_id,
      "I see one matching connector. Do you want me to remove the connector permanently?",
      "go ahead",
    );
    const signals = freshSignals();
    const events: TurnEvent[] = [];
    const wrapped = wrapTools(
      makeToolCtx(conversation_id),
      signals,
      events,
      ctx.testDb.db as unknown as Db,
      [],
      {},
    );
    const tool = wrapped.delete_connector;
    expect(tool).toBeDefined();
    // biome-ignore lint/suspicious/noExplicitAny: Tool.execute is generic
    const result = await (tool!.execute as any)(
      { id: "00000000-0000-0000-0000-000000000def" },
      { toolCallId: "t-del-c-1", messages: [] },
    );
    expect(result.pause).toBeUndefined();
    expect(events.find((e) => e.type === "elicit_request")).toBeUndefined();
  });

  test("does NOT dedupe when prior prose is unrelated (asks about something else)", async () => {
    const conversation_id = await freshConversation();
    await seedTwoMessages(
      conversation_id,
      "Your DigitalOcean connector is configured. Shall I proceed to fetch your projects?",
      "yes",
    );
    const signals = freshSignals();
    const events: TurnEvent[] = [];
    const wrapped = wrapTools(
      makeToolCtx(conversation_id),
      signals,
      events,
      ctx.testDb.db as unknown as Db,
      [],
      {},
    );
    // Now the LLM tries to delete a connector even though the user's
    // "yes" was for a fetch operation. The dedupe MUST NOT fire — the
    // gate must still pause for explicit destructive confirmation.
    // biome-ignore lint/suspicious/noExplicitAny: Tool.execute is generic
    const result = await (wrapped.delete_connector!.execute as any)(
      { id: "00000000-0000-0000-0000-000000000fff" },
      { toolCallId: "t-mismatch", messages: [] },
    );
    expect(result.pause).toBeDefined();
    expect(result.pause?.tool_name).toBe("ask_user_confirm");
  });

  test("does NOT dedupe when user's reply is not a clear affirmation", async () => {
    const conversation_id = await freshConversation();
    await seedTwoMessages(
      conversation_id,
      "Shall I proceed to delete the workflow?",
      "what's the impact of deleting it?",
    );
    const signals = freshSignals();
    const events: TurnEvent[] = [];
    const wrapped = wrapTools(
      makeToolCtx(conversation_id),
      signals,
      events,
      ctx.testDb.db as unknown as Db,
      [],
      {},
    );
    // biome-ignore lint/suspicious/noExplicitAny: Tool.execute is generic
    const result = await (wrapped.delete_workflow!.execute as any)(
      { id: "00000000-0000-0000-0000-000000000aaa" },
      { toolCallId: "t-no-aff", messages: [] },
    );
    expect(result.pause).toBeDefined();
  });

  test("does NOT dedupe when the conversation has no prior messages", async () => {
    const conversation_id = await freshConversation();
    const signals = freshSignals();
    const events: TurnEvent[] = [];
    const wrapped = wrapTools(
      makeToolCtx(conversation_id),
      signals,
      events,
      ctx.testDb.db as unknown as Db,
      [],
      {},
    );
    // biome-ignore lint/suspicious/noExplicitAny: Tool.execute is generic
    const result = await (wrapped.delete_workflow!.execute as any)(
      { id: "00000000-0000-0000-0000-000000000bbb" },
      { toolCallId: "t-empty", messages: [] },
    );
    expect(result.pause).toBeDefined();
  });
});

// Cleanup: nothing persisted globally, every test seeds its own
// conversation row. Just verify the messages table didn't blow up.
test("prose-confirmation tests left clean message rows", async () => {
  const rows = await ctx.testDb.db
    .select()
    .from(conversationMessages)
    .where(eq(conversationMessages.tenant_id, ctx.tenant_id));
  expect(rows.length).toBeGreaterThan(0);
});
