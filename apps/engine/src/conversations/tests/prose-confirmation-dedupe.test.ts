// Deterministic confirm-gate behavior for destructive writes.
//
// History: sessions once tried to skip the policy gate when a prior
// assistant prose line ("Shall I proceed to delete all 6 workflows?")
// was followed by a user "yes". That fuzzy natural-language heuristic
// was DELETED — guessing at operator intent over a security-critical
// write is exactly the drift the unified `decideConfirm` rule exists to
// prevent. The deterministic rule now is:
//
//   - a write in `confirm_before_execution` mode PAUSES unless a durable,
//     fresh, matching prior approval the ENGINE verified is present.
//   - prose "yes" alone NEVER skips the gate — no message-scanning,
//     no affirmation regex.
//   - nothing the MODEL puts in its own tool call skips the gate either. No
//     wrapped tool publishes a confirm marker, and the gate reads none off
//     the args — a boolean the model can set is a hole, not an approval.
//
// These tests pin that rule for `delete_workflow` / `delete_connector`: the
// destructive write pauses regardless of what the prior prose said, and
// regardless of a `__policy_confirmed` flag the model volunteers.

import { afterAll, beforeAll, describe, expect, test } from "bun:test";
import { eq } from "drizzle-orm";
import type { Db } from "../../db/client.ts";
import { conversationMessages, conversations } from "../../db/schema/index.ts";
import { EngineClient } from "../../engine-client/index.ts";
import { createLlmTestCtx, type LlmTestCtx } from "../../llm/tests/setup.ts";
import { getTestNow } from "../../test-helpers/determinism/clock.ts";
import type { ToolContext } from "../tools/index.ts";
import { type TurnSignals, wrapTools } from "../tools/sdk-wrap.ts";
import type { TurnEvent } from "../types.ts";

const TEST_NOW_MS = getTestNow();

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
    toolArgsRepeat: new Map(),
    toolValidationFingerprint: new Map(),
    toolErrorCodeRepeat: new Map(),
    totalLoopWarnings: 0,
    consecutiveFailures: 0,
    lastAssistantText: "",
    lastExecutionSuccess: null,
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
  const t = TEST_NOW_MS;
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

describe("policy gate · deterministic destructive-write confirm rule", () => {
  test("delete_workflow PAUSES even after prior prose 'shall I delete?' + user 'yes' (prose alone no longer skips)", async () => {
    const conversation_id = await freshConversation();
    await seedTwoMessages(
      conversation_id,
      "I'll be deleting your 6 workflows. This is a destructive action and cannot be undone. Shall I proceed to delete all 6 workflows?",
      "yes",
    );
    const signals = freshSignals();
    const events: TurnEvent[] = [];
    const wrapped = await wrapTools(
      makeToolCtx(conversation_id),
      signals,
      events,
      ctx.testDb.db as unknown as Db,
      ["workflow-authoring"],
      {},
    );
    const tool = wrapped.delete_workflow;
    expect(tool).toBeDefined();
    // NO structured marker → the deterministic gate MUST pause. The
    // prior prose+yes is irrelevant; the heuristic that once read it is
    // gone.
    // biome-ignore lint/suspicious/noExplicitAny: Tool.execute is generic
    const result = await (tool!.execute as any)(
      { id: "00000000-0000-0000-0000-000000000abc" },
      { toolCallId: "t-del-1", messages: [] },
    );
    expect(result.pause).toBeDefined();
    expect(result.pause?.tool_name).toBe("ask_user_confirm");
    expect(events.find((e) => e.type === "elicit_request")).toBeDefined();
  });

  test("delete_workflow with a model-supplied __policy_confirmed marker STILL pauses", async () => {
    const conversation_id = await freshConversation();
    const signals = freshSignals();
    const events: TurnEvent[] = [];
    const wrapped = await wrapTools(
      makeToolCtx(conversation_id),
      signals,
      events,
      ctx.testDb.db as unknown as Db,
      ["workflow-authoring"],
      {},
    );
    const tool = wrapped.delete_workflow;
    expect(tool).toBeDefined();
    // The marker is inert: the gate reads no confirm flag off the args, and the
    // published schema declares none. A model that volunteers one gets the same
    // confirmation card as one that does not — the operator decides, and the
    // harness performs the delete once they answer.
    // biome-ignore lint/suspicious/noExplicitAny: Tool.execute is generic
    const result = await (tool!.execute as any)(
      { id: "00000000-0000-0000-0000-000000000abc", __policy_confirmed: true },
      { toolCallId: "t-del-marker", messages: [] },
    );
    expect(result.pause).toBeDefined();
    expect(result.pause?.tool_name).toBe("ask_user_confirm");
    expect(events.find((e) => e.type === "elicit_request")).toBeDefined();
  });

  test("delete_connector with a model-supplied __policy_confirmed marker STILL pauses", async () => {
    const conversation_id = await freshConversation();
    const signals = freshSignals();
    const events: TurnEvent[] = [];
    const wrapped = await wrapTools(
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
      { id: "00000000-0000-0000-0000-000000000def", __policy_confirmed: true },
      { toolCallId: "t-del-c-marker", messages: [] },
    );
    expect(result.pause).toBeDefined();
    expect(result.pause?.tool_name).toBe("ask_user_confirm");
    expect(events.find((e) => e.type === "elicit_request")).toBeDefined();
  });

  test("delete_connector PAUSES without a marker (prior unrelated prose+yes does not proceed)", async () => {
    const conversation_id = await freshConversation();
    await seedTwoMessages(
      conversation_id,
      "Your DigitalOcean connector is configured. Shall I proceed to fetch your projects?",
      "yes",
    );
    const signals = freshSignals();
    const events: TurnEvent[] = [];
    const wrapped = await wrapTools(
      makeToolCtx(conversation_id),
      signals,
      events,
      ctx.testDb.db as unknown as Db,
      [],
      {},
    );
    // biome-ignore lint/suspicious/noExplicitAny: Tool.execute is generic
    const result = await (wrapped.delete_connector!.execute as any)(
      { id: "00000000-0000-0000-0000-000000000fff" },
      { toolCallId: "t-mismatch", messages: [] },
    );
    expect(result.pause).toBeDefined();
    expect(result.pause?.tool_name).toBe("ask_user_confirm");
  });

  test("delete_workflow PAUSES when the conversation has no prior messages", async () => {
    const conversation_id = await freshConversation();
    const signals = freshSignals();
    const events: TurnEvent[] = [];
    const wrapped = await wrapTools(
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
test("deterministic confirm-gate tests left clean message rows", async () => {
  const rows = await ctx.testDb.db
    .select()
    .from(conversationMessages)
    .where(eq(conversationMessages.tenant_id, ctx.tenant_id));
  expect(rows.length).toBeGreaterThan(0);
});
