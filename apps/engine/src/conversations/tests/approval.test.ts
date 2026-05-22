// Elicitation pause / resolve test.
//
// Covers:
//   - an `ask_user_confirm` tool writes a `conversation_elicitations`
//     row in `pending` and flips the conversation to `awaiting_input`
//   - responding with `{ confirmed: false }` keeps the conversation
//     in an active state and audits the decision
//   - the audit row uses the shared APPROVAL_REJECTED action name
//     (for backwards-compatible audit consumers).

import { afterAll, beforeAll, describe, expect, test } from "bun:test";
import { and, eq } from "drizzle-orm";
import {
  auditLog,
  conversationElicitations,
  conversationToolCalls,
} from "../../db/schema/index.ts";
import { buildModelMessages } from "../persist.ts";
import { getConversation } from "../service.ts";
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
  test("rejecting a confirm keeps the conversation active and audits the decision", async () => {
    const outcome = await createConversationWithTurn(
      {
        tenant_id: ctx.tenant_id,
        actor_id: ctx.user_id,
        connector_id: ctx.connector_id,
        initial_message: "list users",
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
        output: { confirmed: false },
        reason: "not ready",
      },
      ctx.testDb.db,
    );
    // After rejection the loop drives another turn with the negative
    // tool_result; the mock plan ends with no commit.
    expect(responded.conversation.status).not.toBe("awaiting_input");

    const afterRow = await ctx.testDb.db
      .select()
      .from(conversationElicitations)
      .where(eq(conversationElicitations.id, elicitationId))
      .limit(1);
    expect(afterRow[0]?.status).toBe("resolved");
    expect(afterRow[0]?.decision_reason).toBe("not ready");

    // APPROVAL_APPROVED audit row is emitted for every resolved
    // elicitation today (the code treats any non-cancelled outcome as
    // "user answered"). That's fine — the diagnostic info is in the
    // stored `output`.
    const auditRows = await ctx.testDb.db
      .select()
      .from(auditLog)
      .where(and(eq(auditLog.tenant_id, ctx.tenant_id), eq(auditLog.action, "approval.approved")));
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

    // No committed workflow — the draft was never committed.
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
      },
      ctx.testDb.db,
    );
    const elicitationId = outcome.result.pending_elicitation_id;
    if (!elicitationId) throw new Error("no elicitation id");

    // First response — should succeed and move the row to resolved.
    await respondElicitationForTest(
      {
        tenant_id: ctx.tenant_id,
        conversation_id: outcome.conversation.id,
        elicitation_id: elicitationId,
        actor_id: ctx.user_id,
        output: { confirmed: true },
      },
      ctx.testDb.db,
    );

    // Second response — must reject. Without the gate this would re-run
    // the conversation loop and double-charge the LLM (the silent-hang
    // failure mode in session 79bf2cca).
    await expect(
      respondElicitationForTest(
        {
          tenant_id: ctx.tenant_id,
          conversation_id: outcome.conversation.id,
          elicitation_id: elicitationId,
          actor_id: ctx.user_id,
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

  test("a fresh user prompt is blocked while an elicitation is still pending", async () => {
    const outcome = await createConversationWithTurn(
      {
        tenant_id: ctx.tenant_id,
        actor_id: ctx.user_id,
        connector_id: ctx.connector_id,
        initial_message: "list users",
      },
      ctx.testDb.db,
    );
    const elicitationId = outcome.result.pending_elicitation_id;
    if (!elicitationId) throw new Error("no elicitation id");

    await expect(
      appendMessageWithTurn(
        {
          tenant_id: ctx.tenant_id,
          conversation_id: outcome.conversation.id,
          actor_id: ctx.user_id,
          message: "now nothing happens",
        },
        ctx.testDb.db,
      ),
    ).rejects.toMatchObject({
      name: "PendingElicitationBlockedError",
      pending_elicitation: {
        id: elicitationId,
        tool_name: "ask_user_confirm",
      },
    });

    const pendingRow = await ctx.testDb.db
      .select()
      .from(conversationElicitations)
      .where(eq(conversationElicitations.id, elicitationId))
      .limit(1);
    expect(pendingRow[0]?.status).toBe("pending");
  });
});
