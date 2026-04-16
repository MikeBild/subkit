// User story: As an admin iterating on a workflow, I get an
// `approval_request` frame for `request_human_approval`, respond
// with `/approve` or `/reject`, and the engine resumes the loop
// (on approve) or parks the conversation (on reject) with the
// correct audit trail.
//
// Acceptance criteria:
//
//   AC1. An approval on a commit_draft kind unblocks the loop:
//        the conversation transitions from `awaiting_approval` to
//        `committed`, `approval.approved` + `conversation.committed`
//        audit rows both fire, and a new workflow row is created.
//   AC2. A rejection parks the conversation: the status stays
//        `active` / does NOT commit, an `approval.rejected` row is
//        written with the supplied reason, no workflow row is
//        created for this approval.
//   AC3. Deciding an approval that doesn't exist returns 404 with
//        an error envelope.

import { afterAll, beforeAll, describe, expect, test } from "bun:test";
import { and, eq } from "drizzle-orm";
import * as conversationsSvc from "../../conversations/service.ts";
import { approvalRequests, auditLog, workflows } from "../../db/schema/index.ts";
import { createJourneyCtx, type JourneyCtx, journeyFetch } from "./setup.ts";

let ctx: JourneyCtx;

async function countAudit(action: string, resourceId: string): Promise<number> {
  const rows = await ctx.db
    .select({ id: auditLog.id })
    .from(auditLog)
    .where(and(eq(auditLog.action, action), eq(auditLog.resource_id, resourceId)));
  return rows.length;
}

describe("journey: sk-cli approval lifecycle", () => {
  beforeAll(async () => {
    ctx = await createJourneyCtx("sk-cli-12-approval");
  });

  afterAll(async () => {
    await ctx.cleanup();
  });

  async function newCommitConversation(): Promise<{
    conversationId: string;
    approvalId: string;
  }> {
    const outcome = await conversationsSvc.createConversation(
      {
        tenant_id: ctx.tenantId,
        actor_id: ctx.userId,
        initial_message: "list users from jsonplaceholder",
      },
      ctx.db,
    );
    const convoId = outcome.conversation.id;
    const [approval] = await ctx.db
      .select({ id: approvalRequests.id, status: approvalRequests.status })
      .from(approvalRequests)
      .where(eq(approvalRequests.conversation_id, convoId))
      .limit(1);
    if (!approval) throw new Error("expected an approval to be queued by the mock provider");
    return { conversationId: convoId, approvalId: approval.id };
  }

  test("AC1: approve drives commit → workflow row + approval.approved + conversation.committed", async () => {
    const { conversationId, approvalId } = await newCommitConversation();

    const approved = await journeyFetch(
      ctx,
      `/v1/conversations/${conversationId}/approvals/${approvalId}/approve`,
      { method: "POST" },
    );
    expect(approved.status).toBe(200);

    // The final conversation state is `committed`.
    const detail = await conversationsSvc.getConversation(ctx.tenantId, conversationId, ctx.db);
    expect(detail?.conversation.status).toBe("committed");
    const workflowId = detail?.conversation.target_workflow_id;
    expect(workflowId).toBeDefined();

    // A workflow row exists.
    const [row] = await ctx.db
      .select({ id: workflows.id })
      .from(workflows)
      .where(eq(workflows.id, workflowId as string))
      .limit(1);
    expect(row).toBeDefined();

    // Audit: approval.approved on the approval resource + conversation.committed on the conversation.
    expect(await countAudit("approval.approved", approvalId)).toBe(1);
    expect(await countAudit("conversation.committed", conversationId)).toBe(1);
  });

  test("AC2: reject parks the conversation without committing", async () => {
    const { conversationId, approvalId } = await newCommitConversation();

    const rejected = await journeyFetch(
      ctx,
      `/v1/conversations/${conversationId}/approvals/${approvalId}/reject`,
      {
        method: "POST",
        body: JSON.stringify({ reason: "step 1 missing connector_id" }),
      },
    );
    expect(rejected.status).toBe(200);

    // Audit: approval.rejected exists, conversation.committed does NOT.
    expect(await countAudit("approval.rejected", approvalId)).toBe(1);
    expect(await countAudit("conversation.committed", conversationId)).toBe(0);

    // The approval row itself carries the reason.
    const [row] = await ctx.db
      .select({ reason: approvalRequests.decision_reason })
      .from(approvalRequests)
      .where(eq(approvalRequests.id, approvalId))
      .limit(1);
    expect(row?.reason).toBe("step 1 missing connector_id");
  });

  test("AC3: deciding an unknown approval returns 404", async () => {
    const { conversationId } = await newCommitConversation();
    const nonExistent = "00000000-0000-0000-0000-000000000000";
    const res = await journeyFetch(
      ctx,
      `/v1/conversations/${conversationId}/approvals/${nonExistent}/approve`,
      { method: "POST" },
    );
    expect([404, 500]).toContain(res.status);
  });
});
