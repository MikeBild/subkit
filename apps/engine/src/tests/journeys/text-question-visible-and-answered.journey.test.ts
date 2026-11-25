import { afterAll, beforeAll, describe, expect, test } from "bun:test";
import { and, eq } from "drizzle-orm";
import { createElicitation } from "../../conversations/elicitations.ts";
import { appendMessage, buildModelMessages } from "../../conversations/persistence/index.ts";
import { conversationElicitations, conversations } from "../../db/schema/index.ts";
import { getMockProvider } from "../../llm/mock-provider.ts";
import { openedElicitation } from "../../test-helpers/elicitations.ts";
import { createJourneyCtx, JOURNEY_HOOK_TIMEOUT, type JourneyCtx, journeyFetch } from "./setup.ts";

let ctx: JourneyCtx;
let conversationId = "";
let elicitationId = "";
let toolCallId = "";

const QUESTION = "Wie soll dein Workflow heißen?";
const PLACEHOLDER = "Example API Data Fetch";
const REPLY = "ich sehe hier keinen dialog";

interface Detail {
  conversation: { status: string };
  messages: Array<{ id: string; role: string; parts: Array<Record<string, unknown>> }>;
  tool_calls: Array<{ id: string; tool: string; input: Record<string, unknown>; output: unknown }>;
  resume_summary: {
    pending_approval: {
      id: string;
      tool_call_id?: string | null;
      tool_name: string;
      summary: string;
      prompt?: { question: string };
    } | null;
  } | null;
}

async function detail(id: string): Promise<Detail> {
  const res = await journeyFetch(ctx, `/v1/conversations/${id}`);
  expect(res.status).toBe(200);
  return (await res.json()) as Detail;
}

async function respond(id: string, elicitation: string, value: string) {
  const res = await journeyFetch(
    ctx,
    `/v1/conversations/${id}/elicitations/${elicitation}/respond`,
    { method: "POST", body: JSON.stringify({ output: { value } }) },
  );
  expect(res.status).toBe(200);
  return (await res.json()) as { status: string };
}

async function elicitationRow(id: string) {
  const [row] = await ctx.db
    .select()
    .from(conversationElicitations)
    .where(
      and(
        eq(conversationElicitations.id, id),
        eq(conversationElicitations.tenant_id, ctx.tenantId),
      ),
    );
  return row;
}

beforeAll(async () => {
  ctx = await createJourneyCtx("text-question");
}, JOURNEY_HOOK_TIMEOUT);

afterAll(async () => {
  if (ctx?.cleanup) await ctx.cleanup();
}, JOURNEY_HOOK_TIMEOUT);

describe("a text question is visible and answered on purpose", () => {
  test("AC1: the turn waits on the question and the detail carries it", async () => {
    const created = await journeyFetch(ctx, "/v1/conversations", {
      method: "POST",
      body: JSON.stringify({}),
    });
    expect(created.status).toBe(201);
    conversationId = ((await created.json()) as { conversation: { id: string } }).conversation.id;
    getMockProvider().setConversePlan(conversationId, [
      { tool: "ask_user_text", args: { question: QUESTION, placeholder: PLACEHOLDER } },
    ]);
    const turn = await journeyFetch(ctx, `/v1/conversations/${conversationId}/messages`, {
      method: "POST",
      body: JSON.stringify({ message: "Lege einen Workflow für die Kunden-API an" }),
    });
    expect([200, 202]).toContain(turn.status);
    const outcome = (await turn.json()) as { status: string; pending_elicitation_id?: string };
    expect(outcome.status).toBe("awaiting_input");

    const body = await detail(conversationId);
    const pending = body.resume_summary?.pending_approval;
    expect(pending?.tool_name).toBe("ask_user_text");
    expect(pending?.prompt?.question).toBe(QUESTION);
    expect(pending?.summary).not.toBe(QUESTION);
    elicitationId = pending?.id ?? "";
    toolCallId = pending?.tool_call_id ?? "";
    expect(elicitationId).toBe(outcome.pending_elicitation_id ?? elicitationId);
    expect(toolCallId).not.toBe("");
    const call = body.tool_calls.find((c) => c.id === toolCallId);
    expect(call?.tool).toBe("ask_user_text");
    expect(call?.input).toMatchObject({ question: QUESTION, placeholder: PLACEHOLDER });
    const anchored = body.messages.some((m) =>
      m.parts.some((p) => p.type === "tool_call" && p.call_id === toolCallId),
    );
    expect(anchored).toBe(true);
  });

  test("AC2: the HTTP answer resolves the question with the typed value, verbatim", async () => {
    getMockProvider().setConversePlan(conversationId, []);
    const out = await respond(conversationId, elicitationId, REPLY);
    expect(out.status).not.toBe("awaiting_input");

    const row = await elicitationRow(elicitationId);
    expect(row?.status).toBe("resolved");
    expect(row?.output).toEqual({ value: REPLY });

    const body = await detail(conversationId);
    expect(body.resume_summary?.pending_approval ?? null).toBeNull();
    const answer = body.messages.find((m) => m.id === elicitationId);
    expect(answer?.role).toBe("user");
    expect(answer?.parts).toContainEqual(expect.objectContaining({ type: "text", text: REPLY }));
    const call = body.tool_calls.find((c) => c.id === toolCallId);
    expect(call?.output).toEqual({ status: "resolved", elicitation_id: elicitationId });

    const again = await journeyFetch(
      ctx,
      `/v1/conversations/${conversationId}/elicitations/${elicitationId}/respond`,
      { method: "POST", body: JSON.stringify({ output: { value: "Kundenbericht" } }) },
    );
    expect(again.status).toBe(409);
    expect((await elicitationRow(elicitationId))?.output).toEqual({ value: REPLY });
  });

  test("AC3: the model reads the reply next to the question it asked", async () => {
    const messages = await buildModelMessages(ctx.db, ctx.tenantId, conversationId);
    const callIndex = messages.findIndex(
      (m) =>
        m.role === "assistant" &&
        Array.isArray(m.content) &&
        m.content.some((part) => part.type === "tool-call" && part.toolCallId === toolCallId),
    );
    expect(callIndex).toBeGreaterThanOrEqual(0);
    const callMessage = messages[callIndex];
    const callPart = Array.isArray(callMessage?.content)
      ? callMessage.content.find((part) => part.type === "tool-call")
      : undefined;
    expect(callPart && "input" in callPart ? callPart.input : null).toMatchObject({
      question: QUESTION,
    });
    const resultMessage = messages[callIndex + 1];
    expect(resultMessage?.role).toBe("tool");
    const resultPart = Array.isArray(resultMessage?.content) ? resultMessage.content[0] : undefined;
    expect(resultPart?.type).toBe("tool-result");
    const output =
      resultPart && resultPart.type === "tool-result"
        ? (resultPart.output as { type: string; value: Record<string, unknown> })
        : null;
    expect(output?.value).toMatchObject({
      status: "resolved",
      elicitation_id: elicitationId,
      response: { value: REPLY },
    });
  });

  test("AC4: a question parked from prose is shown, answered and replayed as the user's turn", async () => {
    const created = await journeyFetch(ctx, "/v1/conversations", {
      method: "POST",
      body: JSON.stringify({}),
    });
    expect(created.status).toBe(201);
    const id = ((await created.json()) as { conversation: { id: string } }).conversation.id;
    const asked = "Welcher Endpoint soll aufgerufen werden?";
    await appendMessage(ctx.db, ctx.tenantId, id, "assistant", { text: asked });
    const parked = openedElicitation(
      await createElicitation(
        {
          tenant_id: ctx.tenantId,
          conversation_id: id,
          tool_call_id: null,
          tool_name: "ask_user_text",
          summary: "the assistant asked a question",
          input: { question: asked, metadata: { source: "loop.prose_question_parked" } },
          actor_id: ctx.userId,
        },
        ctx.db,
      ),
    );
    await ctx.db
      .update(conversations)
      .set({ status: "awaiting_input" })
      .where(and(eq(conversations.id, id), eq(conversations.tenant_id, ctx.tenantId)));

    const before = await detail(id);
    const pending = before.resume_summary?.pending_approval;
    expect(pending?.id).toBe(parked.id);
    expect(pending?.tool_call_id ?? null).toBeNull();
    expect(pending?.prompt?.question).toBe(asked);

    const reply = "/users";
    await respond(id, parked.id, reply);
    expect((await elicitationRow(parked.id))?.output).toEqual({ value: reply });

    const messages = await buildModelMessages(ctx.db, ctx.tenantId, id);
    const questionIndex = messages.findIndex((m) => m.role === "assistant" && m.content === asked);
    const replyIndex = messages.findIndex((m) => m.role === "user" && m.content === reply);
    expect(questionIndex).toBeGreaterThanOrEqual(0);
    expect(replyIndex).toBeGreaterThan(questionIndex);
  });
});
