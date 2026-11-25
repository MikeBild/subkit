import { afterAll, beforeAll, describe, expect, test } from "bun:test";
import { and, eq } from "drizzle-orm";
import {
  auditLog,
  conversationElicitations,
  conversationToolCalls,
} from "../../db/schema/index.ts";
import { openedElicitation } from "../../test-helpers/elicitations.ts";
import { decidedByFor } from "../decided-by.ts";
import { createElicitation, resolveElicitation } from "../elicitations.ts";
import { buildModelMessages } from "../persistence/index.ts";
import { createConversation, getConversation } from "../service/index.ts";
import {
  appendMessageWithTurn,
  type ConversationTestCtx,
  createConversationTestCtx,
  createConversationWithTurn,
  respondElicitationForTest,
} from "./setup.ts";

let ctx: ConversationTestCtx;

beforeAll(async () => {
  ctx = await createConversationTestCtx("approval");
});

afterAll(async () => {
  await ctx.cleanup();
});

describe("conversations/elicitation", () => {
  test("an unverified decider persists as unknown without an actor ID", async () => {
    const created = await createConversation(
      { tenant_id: ctx.tenant_id, actor_id: ctx.user_id },
      ctx.testDb.db,
    );
    const pending = openedElicitation(
      await createElicitation(
        {
          tenant_id: ctx.tenant_id,
          conversation_id: created.conversation.id,
          tool_call_id: null,
          tool_name: "ask_user_text",
          summary: "unknown decider probe",
          input: { question: "Continue?" },
          actor_id: ctx.user_id,
        },
        ctx.testDb.db,
      ),
    );
    await resolveElicitation(
      {
        tenant_id: ctx.tenant_id,
        id: pending.id,
        output: { text: "yes" },
        decided_by: decidedByFor(ctx.user_id, ctx.tenant_id, null),
      },
      ctx.testDb.db,
    );

    const [row] = await ctx.testDb.db
      .select()
      .from(conversationElicitations)
      .where(eq(conversationElicitations.id, pending.id))
      .limit(1);
    const [audit] = await ctx.testDb.db
      .select()
      .from(auditLog)
      .where(
        and(
          eq(auditLog.tenant_id, ctx.tenant_id),
          eq(auditLog.resource_type, "conversation_elicitation"),
          eq(auditLog.resource_id, pending.id),
        ),
      )
      .limit(1);

    expect(row?.decided_by).toBeNull();
    expect(row?.decided_by_kind).toBe("unknown");
    expect(audit?.actor_type).toBe("unknown");
    expect(audit?.actor_id).toBeNull();
  });

  test("rejecting a confirm keeps the conversation active and audits the decision", async () => {
    const outcome = await createConversationWithTurn(
      {
        tenant_id: ctx.tenant_id,
        actor_id: ctx.user_id,
        connector_id: ctx.connector_id,
        initial_message: "list users",
        ask_before_writing: true,
      },
      ctx.testDb.db,
    );
    expect(outcome.result.status).toBe("awaiting_input");
    const elicitationId = outcome.result.pending_elicitation_id;
    if (!elicitationId) throw new Error("no elicitation id");

    const pendingRow = await ctx.testDb.db
      .select()
      .from(conversationElicitations)
      .where(eq(conversationElicitations.id, elicitationId))
      .limit(1);
    expect(pendingRow[0]?.status).toBe("pending");

    const responded = await respondElicitationForTest(
      {
        tenant_id: ctx.tenant_id,
        conversation_id: outcome.conversation.id,
        elicitation_id: elicitationId,
        actor_id: ctx.user_id,
        ask_before_writing: true,
        output: { confirmed: false },
        reason: "not ready",
      },
      ctx.testDb.db,
    );
    expect(responded.conversation.status).toBe("awaiting_input");
    const secondElicitationId = responded.result.pending_elicitation_id;
    expect(secondElicitationId).toBeDefined();
    expect(secondElicitationId).not.toBe(elicitationId);

    const afterRow = await ctx.testDb.db
      .select()
      .from(conversationElicitations)
      .where(eq(conversationElicitations.id, elicitationId))
      .limit(1);
    expect(afterRow[0]?.status).toBe("resolved");
    expect(afterRow[0]?.decision_reason).toBe("not ready");

    const auditRows = await ctx.testDb.db
      .select()
      .from(auditLog)
      .where(and(eq(auditLog.tenant_id, ctx.tenant_id), eq(auditLog.action, "approval.rejected")));
    expect(auditRows.length).toBeGreaterThanOrEqual(1);

    const toolCalls = await ctx.testDb.db
      .select()
      .from(conversationToolCalls)
      .where(eq(conversationToolCalls.conversation_id, outcome.conversation.id));
    const resolvedAsk = toolCalls.find((row) => row.tool === "ask_user_confirm");
    expect(resolvedAsk).toBeDefined();
    expect(resolvedAsk?.output).toMatchObject({
      status: "awaiting_input",
      elicitation_id: elicitationId,
    });
    expect(JSON.stringify(resolvedAsk?.output ?? {})).not.toContain("not ready");

    const replay = await buildModelMessages(ctx.testDb.db, ctx.tenant_id, outcome.conversation.id);
    const resolvedReplay = replay.find((message) => {
      if (message.role !== "tool" || !Array.isArray(message.content)) return false;
      const part = message.content[0];
      return part?.type === "tool-result" && part.toolName === "ask_user_confirm";
    });
    expect(resolvedReplay).toBeDefined();
    const resolvedPayload = ((
      resolvedReplay as {
        content: Array<{ output: { value: Record<string, unknown> } }>;
      }
    ).content[0]?.output.value ?? {}) as Record<string, unknown>;
    expect(resolvedPayload.status).toBe("resolved");
    expect(resolvedPayload.reason).toBe("not ready");
    expect((resolvedPayload.response as { confirmed?: boolean }).confirmed).toBe(false);

    const detail = await getConversation(ctx.tenant_id, outcome.conversation.id, ctx.testDb.db);
    expect(detail?.conversation.target_workflow_id).toBeNull();
  });

  test("a duplicate /respond on an already-resolved elicitation raises ElicitationAlreadyResolvedError", async () => {
    const outcome = await createConversationWithTurn(
      {
        tenant_id: ctx.tenant_id,
        actor_id: ctx.user_id,
        connector_id: ctx.connector_id,
        initial_message: "list users",
        ask_before_writing: true,
      },
      ctx.testDb.db,
    );
    const elicitationId = outcome.result.pending_elicitation_id;
    if (!elicitationId) throw new Error("no elicitation id");

    await respondElicitationForTest(
      {
        tenant_id: ctx.tenant_id,
        conversation_id: outcome.conversation.id,
        elicitation_id: elicitationId,
        actor_id: ctx.user_id,
        ask_before_writing: true,
        output: { confirmed: true },
      },
      ctx.testDb.db,
    );

    await expect(
      respondElicitationForTest(
        {
          tenant_id: ctx.tenant_id,
          conversation_id: outcome.conversation.id,
          elicitation_id: elicitationId,
          actor_id: ctx.user_id,
          ask_before_writing: true,
          output: { confirmed: true },
        },
        ctx.testDb.db,
      ),
    ).rejects.toMatchObject({
      name: "ElicitationAlreadyResolvedError",
      elicitation_id: elicitationId,
      status: "resolved",
    });
  });

  test("a typed yes never approves a write confirmation", async () => {
    const outcome = await createConversationWithTurn(
      {
        tenant_id: ctx.tenant_id,
        actor_id: ctx.user_id,
        connector_id: ctx.connector_id,
        initial_message: "list users",
        ask_before_writing: true,
      },
      ctx.testDb.db,
    );
    const elicitationId = outcome.result.pending_elicitation_id;
    if (!elicitationId) throw new Error("no elicitation id");

    await appendMessageWithTurn(
      {
        tenant_id: ctx.tenant_id,
        conversation_id: outcome.conversation.id,
        actor_id: ctx.user_id,
        message: "yes",
      },
      ctx.testDb.db,
    );

    const [row] = await ctx.testDb.db
      .select()
      .from(conversationElicitations)
      .where(eq(conversationElicitations.id, elicitationId))
      .limit(1);
    expect(row?.status).toBe("pending");
    expect(row?.output).toBeNull();
  });

  test("any other prompt while a question is pending reaches the agent and keeps the question open", async () => {
    const outcome = await createConversationWithTurn(
      {
        tenant_id: ctx.tenant_id,
        actor_id: ctx.user_id,
        connector_id: ctx.connector_id,
        initial_message: "list users",
        ask_before_writing: true,
      },
      ctx.testDb.db,
    );
    const elicitationId = outcome.result.pending_elicitation_id;
    if (!elicitationId) throw new Error("no elicitation id");

    const next = await appendMessageWithTurn(
      {
        tenant_id: ctx.tenant_id,
        conversation_id: outcome.conversation.id,
        actor_id: ctx.user_id,
        message: "which users would that list?",
      },
      ctx.testDb.db,
    );
    expect(next.conversation.id).toBe(outcome.conversation.id);

    const [row] = await ctx.testDb.db
      .select()
      .from(conversationElicitations)
      .where(eq(conversationElicitations.id, elicitationId))
      .limit(1);
    expect(row?.status).toBe("pending");
  });
});

test("a prose answer does not resolve or change an older text tool call", async () => {
  const created = await createConversation(
    { tenant_id: ctx.tenant_id, actor_id: ctx.user_id },
    ctx.testDb.db,
  );
  const conversation_id = created.conversation.id;
  const [oldCall] = await ctx.testDb.db
    .insert(conversationToolCalls)
    .values({
      tenant_id: ctx.tenant_id,
      conversation_id,
      tool: "ask_user_text",
      input: { question: "Older question" },
      output: { status: "resolved", response: { value: "Older answer" } },
      confirmation_state: "declined",
      interaction_log: [],
    })
    .returning();
  const pending = openedElicitation(
    await createElicitation(
      {
        tenant_id: ctx.tenant_id,
        conversation_id,
        tool_name: "ask_user_text",
        tool_call_id: null,
        summary: "the assistant asked a question",
        input: { question: "Which colour?", metadata: { source: "loop.prose_question_parked" } },
        actor_id: ctx.user_id,
      },
      ctx.testDb.db,
    ),
  );
  await respondElicitationForTest(
    {
      tenant_id: ctx.tenant_id,
      conversation_id,
      elicitation_id: pending.id,
      actor_id: ctx.user_id,
      ask_before_writing: true,
      output: { value: "Blau" },
    },
    ctx.testDb.db,
  );
  const [after] = await ctx.testDb.db
    .select()
    .from(conversationToolCalls)
    .where(
      and(
        eq(conversationToolCalls.tenant_id, ctx.tenant_id),
        eq(conversationToolCalls.id, oldCall!.id),
      ),
    );
  expect(after?.confirmation_state).toBe("declined");
  expect(after?.interaction_log).toEqual([]);
  expect(after?.output).toEqual(oldCall?.output);
  const detail = await getConversation(ctx.tenant_id, conversation_id, ctx.testDb.db);
  expect(
    detail?.messages.filter(
      (m) => m.role === "user" && (m.content as { text?: string })?.text === "Blau",
    ),
  ).toHaveLength(1);
});

test("a choice is validated, resolved once, and rehydrated as answered without rewriting tool evidence", async () => {
  const created = await createConversation(
    { tenant_id: ctx.tenant_id, actor_id: ctx.user_id },
    ctx.testDb.db,
  );
  const conversation_id = created.conversation.id;
  const input = {
    question: "Next step?",
    options: [
      { value: "preview", label: "Vorschau prüfen" },
      { value: "cancel", label: "Abbrechen" },
    ],
  };
  const [call] = await ctx.testDb.db
    .insert(conversationToolCalls)
    .values({
      tenant_id: ctx.tenant_id,
      conversation_id,
      tool: "ask_user_choice",
      input,
      output: { status: "awaiting_input" },
      outcome: "pending",
    })
    .returning();
  const pending = openedElicitation(
    await createElicitation(
      {
        tenant_id: ctx.tenant_id,
        conversation_id,
        tool_name: "ask_user_choice",
        tool_call_id: call!.id,
        summary: input.question,
        input,
        actor_id: ctx.user_id,
      },
      ctx.testDb.db,
    ),
  );
  const params = {
    tenant_id: ctx.tenant_id,
    conversation_id,
    elicitation_id: pending.id,
    actor_id: ctx.user_id,
  };
  await expect(
    respondElicitationForTest({ ...params, output: { value: "invented" } }, ctx.testDb.db),
  ).rejects.toThrow();
  expect(
    (await getConversation(ctx.tenant_id, conversation_id, ctx.testDb.db))?.resume_summary
      ?.pending_approval?.id,
  ).toBe(pending.id);
  await respondElicitationForTest({ ...params, output: { value: "preview" } }, ctx.testDb.db);
  await expect(
    respondElicitationForTest({ ...params, output: { value: "cancel" } }, ctx.testDb.db),
  ).rejects.toThrow();
  const detail = await getConversation(ctx.tenant_id, conversation_id, ctx.testDb.db);
  expect(detail?.tool_calls.find((item) => item.id === call!.id)?.output).toEqual({
    status: "resolved",
    elicitation_id: pending.id,
  });
  expect(detail?.tool_calls.find((item) => item.id === call!.id)?.outcome).toBe("ok");
  expect(
    detail?.messages.filter(
      (message) =>
        message.role === "user" &&
        (message.content as { text?: string }).text === "Vorschau prüfen",
    ),
  ).toHaveLength(1);
  expect(detail?.resume_summary?.pending_approval?.id).not.toBe(pending.id);
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
  expect(stored?.output).toEqual({ status: "awaiting_input" });
});

for (const status of ["timeout", "cancelled"] as const) {
  test(`a ${status} choice rehydrates as closed instead of waiting`, async () => {
    const created = await createConversation(
      { tenant_id: ctx.tenant_id, actor_id: ctx.user_id },
      ctx.testDb.db,
    );
    const conversation_id = created.conversation.id;
    const input = {
      question: "Choose",
      options: [
        { value: "a", label: "A" },
        { value: "b", label: "B" },
      ],
    };
    const [call] = await ctx.testDb.db
      .insert(conversationToolCalls)
      .values({
        tenant_id: ctx.tenant_id,
        conversation_id,
        tool: "ask_user_choice",
        input,
        output: { status: "awaiting_input" },
        outcome: "pending",
      })
      .returning();
    const pending = openedElicitation(
      await createElicitation(
        {
          tenant_id: ctx.tenant_id,
          conversation_id,
          tool_name: "ask_user_choice",
          tool_call_id: call!.id,
          summary: "Choose",
          input,
          actor_id: ctx.user_id,
        },
        ctx.testDb.db,
      ),
    );
    await resolveElicitation(
      {
        tenant_id: ctx.tenant_id,
        id: pending.id,
        output: null,
        status,
        decided_by: { kind: "user", id: ctx.user_id },
      },
      ctx.testDb.db,
    );
    const detail = await getConversation(ctx.tenant_id, conversation_id, ctx.testDb.db);
    expect(detail?.tool_calls.find((item) => item.id === call!.id)?.output).toEqual({
      status,
      elicitation_id: pending.id,
    });
    expect(detail?.tool_calls.find((item) => item.id === call!.id)?.outcome).toBe("denied");
    expect(detail?.resume_summary?.pending_approval ?? null).toBeNull();
  });
}

for (const [answer, action] of [
  [{ confirmed: false }, "approval.rejected"],
  [{ confirmed: true }, "approval.approved"],
] as const) {
  test(`an answered confirmation is audited as ${action} when the answer is ${JSON.stringify(answer)}`, async () => {
    const created = await createConversation(
      { tenant_id: ctx.tenant_id, actor_id: ctx.user_id },
      ctx.testDb.db,
    );
    const conversation_id = created.conversation.id;
    const input = { question: "Delete the workflow?" };
    const [call] = await ctx.testDb.db
      .insert(conversationToolCalls)
      .values({
        tenant_id: ctx.tenant_id,
        conversation_id,
        tool: "ask_user_confirm",
        input,
        output: { status: "awaiting_input" },
        outcome: "pending",
      })
      .returning();
    const pending = openedElicitation(
      await createElicitation(
        {
          tenant_id: ctx.tenant_id,
          conversation_id,
          tool_name: "ask_user_confirm",
          tool_call_id: call!.id,
          summary: "Confirm",
          input,
          actor_id: ctx.user_id,
        },
        ctx.testDb.db,
      ),
    );
    await resolveElicitation(
      {
        tenant_id: ctx.tenant_id,
        id: pending.id,
        output: answer,
        decided_by: { kind: "user", id: ctx.user_id },
      },
      ctx.testDb.db,
    );
    const rows = await ctx.testDb.db
      .select({ action: auditLog.action })
      .from(auditLog)
      .where(and(eq(auditLog.tenant_id, ctx.tenant_id), eq(auditLog.resource_id, pending.id)));
    expect(rows.map((r) => r.action)).toContain(action);
    expect(rows.map((r) => r.action)).not.toContain(
      action === "approval.rejected" ? "approval.approved" : "approval.rejected",
    );
  });
}
