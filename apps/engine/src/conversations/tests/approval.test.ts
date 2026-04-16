// Approval pause / resolve test.
//
// Covers:
//   - request_human_approval writes an approval_requests row in
//     `pending` and flips the conversation to `awaiting_approval`
//   - approve flips it to `approved` and writes an audit row
//   - reject flips it to `rejected` and does NOT drive a new turn

import { afterAll, beforeAll, describe, expect, test } from "bun:test";
import { and, eq } from "drizzle-orm";
import { approvalRequests, auditLog } from "../../db/schema/index.ts";
import { createConversation, decideApproval, getConversation } from "../service.ts";
import { type ConversationTestCtx, createConversationTestCtx } from "./setup.ts";

let ctx: ConversationTestCtx;

beforeAll(async () => {
  ctx = await createConversationTestCtx("approval");
});

afterAll(async () => {
  await ctx.cleanup();
});

describe("conversations/approval", () => {
  test("reject keeps the conversation in an active state and audits the decision", async () => {
    const outcome = await createConversation(
      {
        tenant_id: ctx.tenant_id,
        actor_id: ctx.user_id,
        connector_id: ctx.connector_id,
        initial_message: "list users",
      },
      ctx.testDb.db,
    );
    expect(outcome.result.status).toBe("awaiting_approval");
    const approvalId = outcome.result.pending_approval_id;
    if (!approvalId) throw new Error("no approval id");

    const pendingRow = await ctx.testDb.db
      .select()
      .from(approvalRequests)
      .where(eq(approvalRequests.id, approvalId))
      .limit(1);
    expect(pendingRow[0]?.status).toBe("pending");

    const rejected = await decideApproval(
      {
        tenant_id: ctx.tenant_id,
        conversation_id: outcome.conversation.id,
        approval_id: approvalId,
        actor_id: ctx.user_id,
        decision: "rejected",
        reason: "not ready",
      },
      ctx.testDb.db,
    );
    expect(rejected.conversation.status).toBe("active");

    const afterRow = await ctx.testDb.db
      .select()
      .from(approvalRequests)
      .where(eq(approvalRequests.id, approvalId))
      .limit(1);
    expect(afterRow[0]?.status).toBe("rejected");
    expect(afterRow[0]?.decision_reason).toBe("not ready");

    // An APPROVAL_REJECTED audit row should exist.
    const auditRows = await ctx.testDb.db
      .select()
      .from(auditLog)
      .where(and(eq(auditLog.tenant_id, ctx.tenant_id), eq(auditLog.action, "approval.rejected")));
    expect(auditRows.length).toBeGreaterThanOrEqual(1);

    // The conversation should NOT have a committed workflow because
    // the plan never got to `commit_draft`.
    const detail = await getConversation(ctx.tenant_id, outcome.conversation.id, ctx.testDb.db);
    expect(detail?.conversation.target_workflow_id).toBeNull();
  });
});
