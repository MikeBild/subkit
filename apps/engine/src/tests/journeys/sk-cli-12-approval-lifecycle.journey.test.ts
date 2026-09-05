// User story: As an admin iterating on a workflow, I get an
// `elicit_request` frame for `ask_user_confirm`, respond with the
// POST /elicitations/:id/respond endpoint, and the engine resumes
// the loop (on confirmed) or parks the conversation (on rejected)
// with the correct audit trail.
//
// Acceptance criteria:
//
//   AC1. Confirming a save_workflow_draft elicitation unblocks the loop:
//        the conversation transitions from `awaiting_input` to
//        `active`, an `approval.approved` audit row fires, and a new
//        inert workflow draft is created without a committed audit event.
//   AC2. Rejecting the elicitation drives a new turn with the
//        negative result; the conversation does NOT commit, the
//        stored output carries `{ confirmed: false }`, and the
//        reason is persisted on the elicitation row.
//   AC3. Responding to an unknown elicitation returns 4xx/5xx.

import { afterAll, beforeAll, describe, expect, test } from "bun:test";
import { and, eq, isNull } from "drizzle-orm";
import * as conversationsSvc from "../../conversations/service.ts";
import { createConversationWithTurn } from "../../conversations/tests/setup.ts";
import { auditLog, conversationElicitations, workflows } from "../../db/schema/index.ts";
import { createJourneyCtx, JOURNEY_HOOK_TIMEOUT, type JourneyCtx, journeyFetch } from "./setup.ts";

let ctx: JourneyCtx;

async function countAudit(action: string, resourceId: string): Promise<number> {
  // The harness emits a SECOND `approval.approved` row tagged with
  // `reason: "auto_persist_on_confirmation"` after the canonical user-side
  // approval. For the journey-level lifecycle assertions we only care
  // about the canonical row (reason=null) — the dual-audit pattern is
  // already covered by the unit tests in audit-trail.test.ts.
  const rows = await ctx.db
    .select({ id: auditLog.id })
    .from(auditLog)
    .where(
      and(
        eq(auditLog.tenant_id, ctx.tenantId),
        eq(auditLog.action, action),
        eq(auditLog.resource_id, resourceId),
        isNull(auditLog.reason),
      ),
    );
  return rows.length;
}

describe("journey: sk-cli elicitation lifecycle", () => {
  beforeAll(async () => {
    ctx = await createJourneyCtx("sk-cli-12-approval");
  }, JOURNEY_HOOK_TIMEOUT);

  afterAll(async () => {
    await ctx.cleanup();
  }, JOURNEY_HOOK_TIMEOUT);

  async function newCommitConversation(): Promise<{
    conversationId: string;
    elicitationId: string;
  }> {
    // createConversation is insert-only; the turn runs via
    // runConversationTurn. createConversationWithTurn composes both so
    // the mock provider's queued elicitation actually lands.
    const outcome = await createConversationWithTurn(
      {
        tenant_id: ctx.tenantId,
        actor_id: ctx.userId,
        initial_message: "list users from jsonplaceholder",
      },
      ctx.db,
    );
    const convoId = outcome.conversation.id;
    const [elicit] = await ctx.db
      .select({ id: conversationElicitations.id })
      .from(conversationElicitations)
      .where(eq(conversationElicitations.conversation_id, convoId))
      .limit(1);
    if (!elicit) throw new Error("expected an elicitation to be queued by the mock provider");
    return { conversationId: convoId, elicitationId: elicit.id };
  }

  test("AC1: manual confirmation saves an inert workflow draft with an approval audit", async () => {
    const { conversationId, elicitationId } = await newCommitConversation();

    const res = await journeyFetch(
      ctx,
      `/v1/conversations/${conversationId}/elicitations/${elicitationId}/respond`,
      { method: "POST", body: JSON.stringify({ output: { confirmed: true } }) },
    );
    expect(res.status).toBe(200);

    const detail = await conversationsSvc.getConversation(ctx.tenantId, conversationId, ctx.db);
    expect(detail?.conversation.status).toBe("active");
    const workflowId = detail?.conversation.target_workflow_id;
    expect(workflowId).toBeDefined();

    const [row] = await ctx.db
      .select({
        id: workflows.id,
        draft: workflows.draft_version_id,
        active: workflows.current_version_id,
      })
      .from(workflows)
      .where(and(eq(workflows.id, workflowId as string), eq(workflows.tenant_id, ctx.tenantId)))
      .limit(1);
    expect(row).toBeDefined();
    expect(row?.draft).toBeTruthy();
    expect(row?.active).toBeNull();

    expect(await countAudit("approval.approved", elicitationId)).toBe(1);
    expect(await countAudit("conversation.committed", conversationId)).toBe(0);
  });

  test("AC2: reject records the reason and does not commit", async () => {
    const { conversationId, elicitationId } = await newCommitConversation();

    const res = await journeyFetch(
      ctx,
      `/v1/conversations/${conversationId}/elicitations/${elicitationId}/respond`,
      {
        method: "POST",
        body: JSON.stringify({
          output: { confirmed: false },
          reason: "step 1 missing connector_id",
        }),
      },
    );
    expect(res.status).toBe(200);

    expect(await countAudit("conversation.committed", conversationId)).toBe(0);

    const [row] = await ctx.db
      .select({
        reason: conversationElicitations.decision_reason,
        output: conversationElicitations.output,
      })
      .from(conversationElicitations)
      .where(eq(conversationElicitations.id, elicitationId))
      .limit(1);
    expect(row?.reason).toBe("step 1 missing connector_id");
    expect((row!.output as { confirmed?: boolean } | null)?.confirmed).toBe(false);
  });

  test("AC3: responding to an unknown elicitation returns 4xx/5xx", async () => {
    const { conversationId } = await newCommitConversation();
    const nonExistent = "00000000-0000-0000-0000-000000000000";
    const res = await journeyFetch(
      ctx,
      `/v1/conversations/${conversationId}/elicitations/${nonExistent}/respond`,
      { method: "POST", body: JSON.stringify({ output: { confirmed: true } }) },
    );
    expect([400, 404, 500]).toContain(res.status);
  });
});
