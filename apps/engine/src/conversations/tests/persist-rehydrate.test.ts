// Persist rehydration test.
//
// Regression gate for Gap #2: `buildModelMessages` must splice the
// `confirmation_state` and `interaction_log` columns into the tool
// result payload the model sees on next turn. Without this, the model
// has no way to distinguish "tested" from "applied" on a re-issued
// tool call.

import { beforeAll, describe, expect, it } from "bun:test";
import { conversations, conversationToolCalls } from "../../db/schema/index.ts";
import { createLlmTestCtx, type LlmTestCtx } from "../../llm/tests/setup.ts";
import { buildModelMessages } from "../persist.ts";

let ctx: LlmTestCtx;
let conversation_id: string;
let tool_call_id: string;

beforeAll(async () => {
  ctx = await createLlmTestCtx("persist-rehydrate");
  // Seed a conversation + one tool_call row with a real confirmation
  // state and interaction_log entries.
  const [conv] = await ctx.testDb.db
    .insert(conversations)
    .values({ tenant_id: ctx.tenant_id, status: "active" })
    .returning({ id: conversations.id });
  conversation_id = conv!.id;
  const [tc] = await ctx.testDb.db
    .insert(conversationToolCalls)
    .values({
      tenant_id: ctx.tenant_id,
      conversation_id,
      tool: "run_workflow",
      input: { workflow_id: "abc", environment: "prod" },
      output: { ok: true, execution_id: "exec-1" },
      confirmation_state: "partial",
      interaction_log: [
        { type: "user_proposed", ts: "2026-04-18T00:00:00Z" },
        { type: "user_partial", ts: "2026-04-18T00:00:10Z", meta: { applied: ["X"] } },
      ],
    })
    .returning({ id: conversationToolCalls.id });
  tool_call_id = tc!.id;
});

describe("buildModelMessages — interaction_log rehydration", () => {
  it("splices confirmation_state + interaction_log into the tool-result payload", async () => {
    const msgs = await buildModelMessages(ctx.testDb.db, ctx.tenant_id, conversation_id);
    // Find the tool-result message.
    const toolResult = msgs.find((m) => {
      if (m.role !== "tool") return false;
      // biome-ignore lint/suspicious/noExplicitAny: ModelMessage content shape is a union
      const content = m.content as any;
      return Array.isArray(content) && content[0]?.type === "tool-result";
    });
    expect(toolResult).toBeDefined();
    // biome-ignore lint/suspicious/noExplicitAny: content is a union; cast for inspection
    const parts = (toolResult as any).content as Array<{
      output: { value: Record<string, unknown> };
    }>;
    const payload = parts[0]!.output.value;
    expect(payload.confirmationState).toBe("partial");
    expect(Array.isArray(payload.interactionLog)).toBe(true);
    const log = payload.interactionLog as Array<{ type: string }>;
    expect(log.map((e) => e.type)).toEqual(["user_proposed", "user_partial"]);
    // Original tool output stays readable.
    expect(payload.ok).toBe(true);
    expect(payload.execution_id).toBe("exec-1");
    // Reference to the tool_call_id is unchanged.
    const call = parts[0] as { toolCallId?: string };
    expect(call.toolCallId).toBe(tool_call_id);
  });
});
