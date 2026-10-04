// Persist rehydration test.
//
// Regression gate for Gap #2: `buildModelMessages` must splice the
// `confirmation_state` and `interaction_log` columns into the tool
// result payload the model sees on next turn. Without this, the model
// has no way to distinguish "tested" from "applied" on a re-issued
// tool call.

import { beforeAll, describe, expect, it, test } from "bun:test";
import { and, eq } from "drizzle-orm";
import {
  conversationElicitations,
  conversationMessages,
  conversations,
  conversationToolCalls,
} from "../../db/schema/index.ts";
import { createLlmTestCtx, type LlmTestCtx } from "../../llm/tests/setup.ts";
import { buildMessages } from "../parts.ts";
import { buildModelMessages } from "../persist.ts";
import { getConversation } from "../service/get.ts";

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
  it("replays resolved ask_user_* answers from elicitation rows without leaking them into tool-call output", async () => {
    const [conv] = await ctx.testDb.db
      .insert(conversations)
      .values({ tenant_id: ctx.tenant_id, status: "active" })
      .returning({ id: conversations.id });
    const conversation_id = conv!.id;

    const [toolCall] = await ctx.testDb.db
      .insert(conversationToolCalls)
      .values({
        tenant_id: ctx.tenant_id,
        conversation_id,
        tool: "ask_user_form",
        input: {
          title: "DigitalOcean credential",
          fields: [{ key: "token", type: "password" }],
        },
        output: { ok: true, data: { status: "awaiting_input", elicitation_id: "pending-form-1" } },
      })
      .returning({ id: conversationToolCalls.id });

    await ctx.testDb.db.insert(conversationElicitations).values({
      tenant_id: ctx.tenant_id,
      conversation_id,
      tool_call_id: toolCall!.id,
      tool_name: "ask_user_form",
      summary: "Collect the API token",
      input: {
        title: "DigitalOcean credential",
        fields: [{ key: "token", type: "password" }],
      },
      output: { values: { token: "dop_v1_secret", base_url: "" } },
      status: "resolved",
      decided_at: new Date("2026-04-18T00:00:10.000Z"),
      updated_at: new Date("2026-04-18T00:00:10.000Z"),
    });

    const msgs = await buildModelMessages(ctx.testDb.db, ctx.tenant_id, conversation_id);
    const askUserResults = msgs.filter((message) => {
      if (message.role !== "tool" || !Array.isArray(message.content)) return false;
      const part = message.content[0];
      return part?.type === "tool-result" && part.toolName === "ask_user_form";
    });
    expect(askUserResults).toHaveLength(1);
    const payload = ((
      askUserResults[0] as {
        content: Array<{ output: { value: Record<string, unknown> } }>;
      }
    ).content[0]?.output.value ?? {}) as Record<string, unknown>;
    expect(payload.status).toBe("resolved");
    expect(payload.reason).toBeNull();
    expect((payload.response as { values?: { token?: string } }).values?.token).toBe(
      "dop_v1_secret",
    );
  });

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

  it("replays only the latest compaction summary and newer messages", async () => {
    const [conv] = await ctx.testDb.db
      .insert(conversations)
      .values({ tenant_id: ctx.tenant_id, status: "active" })
      .returning({ id: conversations.id });
    const conversation_id = conv!.id;

    await ctx.testDb.db.insert(conversationMessages).values([
      {
        tenant_id: ctx.tenant_id,
        conversation_id,
        role: "user",
        content: { text: "old user question" },
        created_at: new Date("2026-04-18T00:00:00.000Z"),
      },
      {
        tenant_id: ctx.tenant_id,
        conversation_id,
        role: "assistant",
        content: { text: "old assistant answer" },
        created_at: new Date("2026-04-18T00:00:01.000Z"),
      },
      {
        tenant_id: ctx.tenant_id,
        conversation_id,
        role: "system",
        content: {
          kind: "compacted",
          summary: "Compacted earlier turns about connector cleanup.",
        },
        created_at: new Date("2026-04-18T00:00:02.000Z"),
      },
      {
        tenant_id: ctx.tenant_id,
        conversation_id,
        role: "user",
        content: { text: "new request after compaction" },
        created_at: new Date("2026-04-18T00:00:03.000Z"),
      },
    ]);

    const msgs = await buildModelMessages(ctx.testDb.db, ctx.tenant_id, conversation_id);
    expect(msgs[0]).toEqual({
      role: "system",
      content: "Compacted earlier turns about connector cleanup.",
    });
    expect(JSON.stringify(msgs)).not.toContain("old user question");
    expect(JSON.stringify(msgs)).toContain("new request after compaction");
  });

  it("truncates large tool outputs before replaying them into the model", async () => {
    const [conv] = await ctx.testDb.db
      .insert(conversations)
      .values({ tenant_id: ctx.tenant_id, status: "active" })
      .returning({ id: conversations.id });
    const conversation_id = conv!.id;

    await ctx.testDb.db.insert(conversationToolCalls).values({
      tenant_id: ctx.tenant_id,
      conversation_id,
      tool: "list_workflows",
      input: {},
      output: {
        items: Array.from({ length: 30 }, (_, i) => ({
          id: `wf-${i}`,
          description: "x".repeat(500),
        })),
      },
    });

    const msgs = await buildModelMessages(ctx.testDb.db, ctx.tenant_id, conversation_id);
    const toolResult = msgs.find((m) => m.role === "tool");
    expect(toolResult).toBeDefined();
    // biome-ignore lint/suspicious/noExplicitAny: ModelMessage tool content is a union
    const payload = ((toolResult as any).content[0].output.value ?? {}) as Record<string, unknown>;
    expect(payload._truncated).toBe(true);
    expect(typeof payload._raw_ref).toBe("string");
    expect(typeof payload._note).toBe("string");
  });

  it("auto-compacts oversized replay history in memory", async () => {
    const [conv] = await ctx.testDb.db
      .insert(conversations)
      .values({ tenant_id: ctx.tenant_id, status: "active" })
      .returning({ id: conversations.id });
    const conversation_id = conv!.id;

    await ctx.testDb.db.insert(conversationMessages).values(
      Array.from({ length: 30 }, (_, i) => ({
        tenant_id: ctx.tenant_id,
        conversation_id,
        role: i % 2 === 0 ? ("user" as const) : ("assistant" as const),
        content: { text: `message-${i}` },
      })),
    );

    const msgs = await buildModelMessages(ctx.testDb.db, ctx.tenant_id, conversation_id);
    expect(msgs[0]?.role).toBe("system");
    expect(typeof msgs[0]?.content).toBe("string");
    expect(String(msgs[0]?.content)).toContain("Conversation summary: collapsed");
    expect(msgs.length).toBeLessThan(30);
  });

  // Regression: session 64861a59 produced
  //   "HTTP 503 llm_provider_unavailable — messages.0.content.0:
  //    unexpected `tool_use_id` found in `tool_result` blocks: fb0b8efb-..."
  // because a probe call's tool-result and a later orphaned ask-user
  // call were emitted without their tool_use blocks adjacent. The
  // persist replay must guarantee every `tool_use` is immediately
  // followed by a `tool_result` for the same id.
  it("pairs every tool_use with an adjacent tool_result for the same id", async () => {
    const [conv] = await ctx.testDb.db
      .insert(conversations)
      .values({ tenant_id: ctx.tenant_id, status: "active" })
      .returning({ id: conversations.id });
    const conversation_id = conv!.id;

    // Probe call (succeeded — has output) at T0.
    const [probeCall] = await ctx.testDb.db
      .insert(conversationToolCalls)
      .values({
        tenant_id: ctx.tenant_id,
        conversation_id,
        tool: "probe_connector_draft",
        input: { method: "GET", path: "/v2/account" },
        output: { ok: true, status_code: 200 },
        created_at: new Date("2026-04-26T08:00:00.000Z"),
      })
      .returning({ id: conversationToolCalls.id });

    // Assistant text turn between calls — would have separated the
    // probe's tool-call from any later tool message under the buggy
    // chronological emission.
    await ctx.testDb.db.insert(conversationMessages).values({
      tenant_id: ctx.tenant_id,
      conversation_id,
      role: "assistant",
      content: { text: "probe ok — now collecting credential" },
      created_at: new Date("2026-04-26T08:00:01.000Z"),
    });

    // Orphaned ask_user_form call — output null, elicitation
    // pending/superseded. Without the fix this emits a `tool-call`
    // with no following `tool-result`, breaking pairing.
    const [orphanCall] = await ctx.testDb.db
      .insert(conversationToolCalls)
      .values({
        tenant_id: ctx.tenant_id,
        conversation_id,
        tool: "ask_user_form",
        input: { fields: [{ key: "token", type: "password" }] },
        output: null,
        created_at: new Date("2026-04-26T08:00:02.000Z"),
      })
      .returning({ id: conversationToolCalls.id });

    const msgs = await buildModelMessages(ctx.testDb.db, ctx.tenant_id, conversation_id);

    // Walk the stream and assert: for every assistant message that
    // contains a tool-call part, the very next message is a tool
    // message whose tool-result references the same toolCallId.
    for (let i = 0; i < msgs.length; i++) {
      const m = msgs[i];
      if (m?.role !== "assistant" || !Array.isArray(m.content)) continue;
      const toolCalls = (m.content as Array<{ type: string; toolCallId?: string }>).filter(
        (part) => part.type === "tool-call",
      );
      if (toolCalls.length === 0) continue;
      const next = msgs[i + 1];
      expect(next?.role).toBe("tool");
      // biome-ignore lint/suspicious/noExplicitAny: union content
      const nextParts = (next as any).content as Array<{
        type: string;
        toolCallId: string;
      }>;
      const toolResultIds = new Set(
        nextParts.filter((p) => p.type === "tool-result").map((p) => p.toolCallId),
      );
      for (const call of toolCalls) {
        expect(toolResultIds.has(call.toolCallId!)).toBe(true);
      }
    }

    // The orphan call gets a synthetic abandoned tool-result so the
    // pair stays balanced; the probe call uses its real output.
    const orphanResult = msgs.find((m) => {
      if (m?.role !== "tool" || !Array.isArray(m.content)) return false;
      // biome-ignore lint/suspicious/noExplicitAny: union
      const part = (m.content as any)[0];
      return part?.type === "tool-result" && part.toolCallId === orphanCall!.id;
    });
    expect(orphanResult).toBeDefined();
    // biome-ignore lint/suspicious/noExplicitAny: union
    const orphanPayload = ((orphanResult as any).content[0].output.value ?? {}) as Record<
      string,
      unknown
    >;
    expect(orphanPayload.abandoned).toBe(true);
    expect(orphanPayload.reason).toBe("elicitation_superseded");

    const probeResult = msgs.find((m) => {
      if (m?.role !== "tool" || !Array.isArray(m.content)) return false;
      // biome-ignore lint/suspicious/noExplicitAny: union
      const part = (m.content as any)[0];
      return part?.type === "tool-result" && part.toolCallId === probeCall!.id;
    });
    expect(probeResult).toBeDefined();
  });
});

describe("parked prose question answers", () => {
  it("replays and displays the exact answer once, after the question, without borrowing an earlier tool call", async () => {
    const [conv] = await ctx.testDb.db
      .insert(conversations)
      .values({ tenant_id: ctx.tenant_id, status: "active" })
      .returning();
    const id = conv!.id;
    const at = (seconds: number) => new Date(Date.UTC(2026, 8, 15, 9, 0, seconds));
    await ctx.testDb.db.insert(conversationMessages).values([
      {
        tenant_id: ctx.tenant_id,
        conversation_id: id,
        role: "assistant",
        content: { text: "Which colour?" },
        created_at: at(2),
      },
      {
        tenant_id: ctx.tenant_id,
        conversation_id: id,
        role: "assistant",
        content: { text: "Colour accepted." },
        created_at: at(5),
      },
    ]);
    await ctx.testDb.db.insert(conversationToolCalls).values({
      tenant_id: ctx.tenant_id,
      conversation_id: id,
      tool: "ask_user_text",
      input: { question: "An older question" },
      output: { status: "resolved", response: { value: "older answer" } },
      created_at: at(0),
    });
    const answer = "Blau.\nBitte nur bestätigen.";
    const [elicitation] = await ctx.testDb.db
      .insert(conversationElicitations)
      .values({
        tenant_id: ctx.tenant_id,
        conversation_id: id,
        tool_name: "ask_user_text",
        tool_call_id: null,
        summary: "the assistant asked a question",
        input: { question: "Which colour?", metadata: { source: "loop.prose_question_parked" } },
        output: { value: answer },
        status: "resolved",
        created_at: at(3),
        decided_at: at(4),
        updated_at: at(4),
      })
      .returning();
    const replay = await buildModelMessages(ctx.testDb.db, ctx.tenant_id, id);
    expect(replay.filter((m) => m.role === "user" && m.content === answer)).toHaveLength(1);
    const text = replay.filter((m) => typeof m.content === "string").map((m) => m.content);
    // Provider replay intentionally drops the trailing assistant prefill.
    expect(text).toEqual(["Which colour?", answer]);
    const toolResults = JSON.stringify(replay.filter((m) => m.role === "tool"));
    expect(toolResults).toContain("older answer");
    expect(toolResults).not.toContain("Blau");
    const detail = await getConversation(ctx.tenant_id, id, ctx.testDb.db);
    expect(detail?.messages.map((m) => m.content)).toEqual([
      { text: "Which colour?" },
      { text: answer },
      { text: "Colour accepted." },
    ]);
    expect(detail?.messages[1]?.id).toBe(elicitation!.id);
    expect(
      await buildModelMessages(ctx.testDb.db, "00000000-0000-4000-8000-000000000001", id),
    ).toEqual([]);
    expect(
      await getConversation("00000000-0000-4000-8000-000000000001", id, ctx.testDb.db),
    ).toBeNull();
  });

  it("does not replay unanswered questions, cancellations, malformed outputs or structured approvals as user text", async () => {
    const [conv] = await ctx.testDb.db
      .insert(conversations)
      .values({ tenant_id: ctx.tenant_id, status: "active" })
      .returning();
    for (const patch of [
      { status: "pending" as const },
      { status: "cancelled" as const },
      { output: { confirmed: true } },
      { tool_name: "ask_user_confirm" },
    ]) {
      await ctx.testDb.db.insert(conversationElicitations).values({
        tenant_id: ctx.tenant_id,
        conversation_id: conv!.id,
        tool_name: "ask_user_text",
        summary: "question",
        input: { question: "Which colour?", metadata: { source: "loop.prose_question_parked" } },
        output: { value: "must not replay" },
        status: "resolved",
        decided_at: new Date("2026-09-15T09:00:00.000Z"),
        ...patch,
      });
    }
    expect(await buildModelMessages(ctx.testDb.db, ctx.tenant_id, conv!.id)).toEqual([]);
    const detail = await getConversation(ctx.tenant_id, conv!.id, ctx.testDb.db);
    expect(detail?.messages).toEqual([]);
  });
});

test("answered text tools show the answer and a completed card after reloading", async () => {
  const [conv] = await ctx.testDb.db
    .insert(conversations)
    .values({ tenant_id: ctx.tenant_id, status: "active" })
    .returning();
  const conversation_id = conv!.id;
  const [message] = await ctx.testDb.db
    .insert(conversationMessages)
    .values({
      tenant_id: ctx.tenant_id,
      conversation_id,
      role: "assistant",
      content: { text: "Which colour?" },
    })
    .returning();
  const pendingOutput = { status: "awaiting_input", elicitation_id: "original-question" };
  const [call] = await ctx.testDb.db
    .insert(conversationToolCalls)
    .values({
      tenant_id: ctx.tenant_id,
      conversation_id,
      tool: "ask_user_text",
      parent_message_id: message!.id,
      input: { question: "Which colour?" },
      output: pendingOutput,
      outcome: "pending",
    })
    .returning();
  const [answer] = await ctx.testDb.db
    .insert(conversationElicitations)
    .values({
      tenant_id: ctx.tenant_id,
      conversation_id,
      tool_call_id: call!.id,
      tool_name: "ask_user_text",
      summary: "Which colour?",
      input: { question: "Which colour?" },
      output: { value: "Blau" },
      status: "resolved",
    })
    .returning();
  const detail = await getConversation(ctx.tenant_id, conversation_id, ctx.testDb.db);
  if (!detail) throw new Error("conversation missing");
  const ui = buildMessages(detail.messages, detail.tool_calls);
  expect(ui.filter((m) => m.role === "user").map((m) => m.parts)).toEqual([
    [{ type: "text", text: "Blau" }],
  ]);
  const result = ui.flatMap((m) => m.parts).find((p) => p.type === "tool_result");
  expect(result).toMatchObject({
    outcome: "ok",
    output: { status: "resolved", elicitation_id: answer!.id },
  });
  // The UI projection must not rewrite the original pause/audit payload.
  const [stored] = await ctx.testDb.db
    .select()
    .from(conversationToolCalls)
    .where(
      and(
        eq(conversationToolCalls.tenant_id, ctx.tenant_id),
        eq(conversationToolCalls.id, call!.id),
      ),
    );
  expect(stored?.output).toEqual(pendingOutput);
  expect(stored?.outcome).toBe("pending");
});

for (const confirmed of [true, false]) {
  test(`confirmation ${confirmed} is actionable by exact call then completed after reload`, async () => {
    const [conv] = await ctx.testDb.db
      .insert(conversations)
      .values({ tenant_id: ctx.tenant_id, status: "awaiting_input" })
      .returning();
    const conversation_id = conv!.id;
    const original = { status: "awaiting_input" };
    const [call] = await ctx.testDb.db
      .insert(conversationToolCalls)
      .values({
        tenant_id: ctx.tenant_id,
        conversation_id,
        tool: "ask_user_confirm",
        input: { question: "Save inactive draft?" },
        output: original,
        outcome: "pending",
      })
      .returning();
    const [request] = await ctx.testDb.db
      .insert(conversationElicitations)
      .values({
        tenant_id: ctx.tenant_id,
        conversation_id,
        tool_call_id: call!.id,
        tool_name: "ask_user_confirm",
        summary: "Save inactive draft?",
        input: { question: "Save inactive draft?" },
        status: "pending",
      })
      .returning();
    const pending = await getConversation(ctx.tenant_id, conversation_id, ctx.testDb.db);
    expect(pending?.resume_summary?.pending_approval).toMatchObject({
      id: request!.id,
      tool_call_id: call!.id,
    });
    expect(request!.id).not.toBe(call!.id);
    await ctx.testDb.db
      .update(conversationElicitations)
      .set({ status: "resolved", output: { confirmed } })
      .where(
        and(
          eq(conversationElicitations.tenant_id, ctx.tenant_id),
          eq(conversationElicitations.id, request!.id),
        ),
      );
    const detail = await getConversation(ctx.tenant_id, conversation_id, ctx.testDb.db);
    expect(detail?.resume_summary?.pending_approval ?? null).toBeNull();
    expect(detail?.tool_calls[0]).toMatchObject({
      outcome: confirmed ? "ok" : "denied",
      output: { status: confirmed ? "resolved" : "declined", elicitation_id: request!.id },
    });
    expect(
      await getConversation("00000000-0000-4000-8000-000000000099", conversation_id, ctx.testDb.db),
    ).toBeNull();
    const [stored] = await ctx.testDb.db
      .select()
      .from(conversationToolCalls)
      .where(
        and(
          eq(conversationToolCalls.tenant_id, ctx.tenant_id),
          eq(conversationToolCalls.id, call!.id),
        ),
      );
    expect(stored?.output).toEqual(original);
    expect(stored?.outcome).toBe("pending");
  });
}
