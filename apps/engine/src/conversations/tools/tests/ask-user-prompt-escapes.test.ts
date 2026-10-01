// Boundary test: an `ask_user_*` call whose arguments carry a literal
// `ß` (the model double-encoded non-ASCII) is stored readable — both in
// the tool-call row the cockpit renders options and placeholders from, and in
// the elicitation row every surface renders the question from. The answer the
// user types is stored as given.
//
// The call goes through the SDK wrapper, the one place model arguments enter;
// calling the tool's own `execute` would skip that layer.

import { afterAll, beforeAll, describe, expect, test } from "bun:test";
import { eq } from "drizzle-orm";
import type { Db } from "../../../db/client.ts";
import {
  conversationElicitations,
  conversations,
  conversationToolCalls,
} from "../../../db/schema/index.ts";
import { EngineClient } from "../../../engine-client/index.ts";
import { createLlmTestCtx, type LlmTestCtx } from "../../../llm/tests/setup.ts";
import { resolveElicitation } from "../../elicitations.ts";
import type { TurnEvent } from "../../types.ts";
import type { ToolContext } from "../index.ts";
import { type TurnSignals, wrapTools } from "../sdk-wrap.ts";

let ctx: LlmTestCtx;
let conversation_id: string;

beforeAll(async () => {
  ctx = await createLlmTestCtx("ask-user-prompt-escapes");
  const [row] = await ctx.testDb.db
    .insert(conversations)
    .values({ tenant_id: ctx.tenant_id, status: "active" })
    .returning({ id: conversations.id });
  conversation_id = row!.id;
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

describe("ask_user_text with a double-encoded question", () => {
  test("persists the readable question and keeps the answer as typed", async () => {
    const db = ctx.testDb.db as unknown as Db;
    const toolCtx: ToolContext = {
      db,
      tenant_id: ctx.tenant_id,
      conversation_id,
      actor_id: null,
      connector_id: null,
      workflow_id: null,
      engineClient: new EngineClient({
        tenant_id: ctx.tenant_id,
        actor_id: null,
        actor_type: "system",
        db,
      }),
      getDraft: () => ({ workflow: { name: "", steps: [] } }),
      setDraft: async () => {},
    };
    const events: TurnEvent[] = [];
    const wrapped = await wrapTools(toolCtx, freshSignals(), events, db, [], {});
    const askText = wrapped.ask_user_text;
    expect(askText).toBeDefined();

    // biome-ignore lint/suspicious/noExplicitAny: Tool.execute is generic
    await (askText!.execute as any)(
      {
        question:
          "Wie soll dein Workflow hei\\u00dfen? (z.B. \\u201cExample API Daten abrufen\\u201d)",
        placeholder: "Stra\\u00dfe",
      },
      { toolCallId: "t1", messages: [] },
    );

    const readable = "Wie soll dein Workflow heißen? (z.B. “Example API Daten abrufen”)";
    const [call] = await ctx.testDb.db
      .select({ input: conversationToolCalls.input })
      .from(conversationToolCalls)
      .where(eq(conversationToolCalls.conversation_id, conversation_id));
    expect(call?.input).toMatchObject({ question: readable, placeholder: "Straße" });

    const [row] = await ctx.testDb.db
      .select()
      .from(conversationElicitations)
      .where(eq(conversationElicitations.conversation_id, conversation_id));
    expect(row?.input).toMatchObject({ question: readable, placeholder: "Straße" });

    // The answer is the user's own text: an escape they type stays literal.
    const answer = "Gr\\u00fc\\u00dfe";
    await resolveElicitation(
      {
        tenant_id: ctx.tenant_id,
        id: row!.id,
        output: { value: answer },
        decided_by: null,
      },
      ctx.testDb.db as unknown as Db,
    );
    const [resolved] = await ctx.testDb.db
      .select({ output: conversationElicitations.output })
      .from(conversationElicitations)
      .where(eq(conversationElicitations.id, row!.id));
    expect(resolved?.output).toEqual({ value: answer });
  });
});
