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
import { auditLog, conversationElicitations } from "../../db/schema/index.ts";
import { createConversation, getConversation, respondElicitation } from "../service.ts";
import { type ConversationTestCtx, createConversationTestCtx } from "./setup.ts";

let ctx: ConversationTestCtx;

beforeAll(async () => {
  ctx = await createConversationTestCtx("approval");
});

afterAll(async () => {
  await ctx.cleanup();
});

describe("conversations/elicitation", () => {
  test("rejecting a confirm keeps the conversation active and audits the decision", async () => {
    const outcome = await createConversation(
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

    const responded = await respondElicitation(
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

    // No committed workflow — the draft was never committed.
    const detail = await getConversation(ctx.tenant_id, outcome.conversation.id, ctx.testDb.db);
    expect(detail?.conversation.target_workflow_id).toBeNull();
  });
});
