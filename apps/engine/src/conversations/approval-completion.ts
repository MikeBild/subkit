// Completing the conversation half of an approval a human already decided.
//
// A policy-gated tool call parks two rows: a `tool_approvals` row holding the
// encrypted args (the capability), and a `conversation_elicitations` row holding
// the paused turn (the prompt). The human's decision lands on the FIRST one —
// the approval portal grants it inside their own browser request. Nothing used
// to advance the SECOND one.
//
// The consequence in production: an operator clicked Approve, the grant was
// recorded (`granted_via: "portal"`), the engine even stamped the elicitation
// `url_completed` — and the conversation still timed out 9 minutes later with
// "the operator did not answer the confirmation; nothing ran". Across the whole
// history of the feature, 0 of 5 approval-backed confirms ever resolved.
//
// The gap was never a missing sweep. Resuming was delegated to an MCP client
// POLL (`conversation-native-elicitation.ts` replay arm) that the hosted clients
// — the ones that cannot render an in-band form and therefore NEED the portal —
// never make. The durable reactor that did exist only ever reacted to an
// approval EXPIRING, never to one being granted.
//
// So this module makes the decision own its effect: the same request that
// grants stages the answer and enqueues the resume. Durability comes from the
// persisted pg-boss job, not from a live connection or a client coming back.
//
// It does NOT claim the approval itself. `consumeApproval`'s CAS binds
// `principal_id` and `surface` to whoever minted the row, so a background
// identity cannot claim it — the resumed turn's harness does, under the
// conversation's own principal (`persistence/auto-persist.ts`).

import type { Db } from "../db/client.ts";
import { errorFields, logger } from "../logging/logger.ts";
import { stageElicitationAnswer } from "./elicitations.ts";
import { markApprovalElicitationsComplete } from "./native-url-elicitation.ts";

/** Enqueue the conversation turn that applies a staged elicitation answer.
 *
 *  Injected rather than imported so this module stays free of the queue and MCP
 *  task layers (`queue/approval-resume.ts` supplies the real one). Returns false
 *  when the turn could not be enqueued, which leaves the row staged-but-pending
 *  for the expiry sweep's backstop to pick up. */
export type ApprovalResumeEnqueuer = (p: {
  tenant_id: string;
  conversation_id: string;
  elicitation_id: string;
  /** The approval whose args the resumed turn will claim and replay. The turn
   *  must run as the principal that OWNS this row — `consumeApproval`'s CAS binds
   *  `principal_id` — which is NOT the browser approver. */
  approval_id: string;
  approver_user_id: string | null;
  decision: "approve" | "decline";
}) => Promise<boolean>;

export interface ApprovalCompletionResult {
  /** Pending confirm rows paired with this approval. Zero is normal: a direct
   *  tool dispatch, a chat fast-path run, or a relayed external-MCP call mints
   *  an approval with no paused conversation to advance. */
  matched: number;
  /** Rows whose resume turn was enqueued. */
  resumed: number;
}

/**
 * Advance the paused conversation(s) belonging to an approval a human just
 * decided.
 *
 * Ordering is deliberate and matches the precedent in
 * `mcp/capabilities/conversations.ts`: persist first, enqueue after, never
 * inside a transaction, and record an explicit failure if the enqueue is lost
 * rather than leaving a turn that looks like it is running.
 *
 * On `decline` the answer is staged as `null`; `respondElicitation` maps that to
 * a declined resolution, and the approval itself is already terminally declined
 * on its own row.
 */
export async function completeApprovalBackedElicitation(
  p: {
    tenant_id: string;
    approval_id: string;
    decision: "approve" | "decline";
    approver_user_id: string | null;
    resume: ApprovalResumeEnqueuer;
  },
  db: Db,
): Promise<ApprovalCompletionResult> {
  const rows = await markApprovalElicitationsComplete(
    {
      tenant_id: p.tenant_id,
      approval_id: p.approval_id,
      outcome: p.decision === "approve" ? "succeeded" : "failed",
    },
    db,
  );
  if (rows.length === 0) return { matched: 0, resumed: 0 };

  let resumed = 0;
  for (const row of rows) {
    try {
      const staged = await stageElicitationAnswer(
        {
          tenant_id: p.tenant_id,
          conversation_id: row.conversation_id,
          id: row.id,
          output: p.decision === "approve" ? { confirmed: true } : null,
        },
        db,
      );
      if (staged.kind !== "staged") {
        // Another path (an MCP poll that replayed the same settled decision)
        // already answered this row. The CAS is the arbiter; nothing to do.
        logger.info({
          module: "conversation",
          action: "approval.completion_already_answered",
          msg: "approval-backed elicitation was already answered by another path",
          tenant_id: p.tenant_id,
          conversation_id: row.conversation_id,
          elicitation_id: row.id,
          approval_id: p.approval_id,
          stage_outcome: staged.kind,
        });
        continue;
      }
      const enqueued = await p.resume({
        tenant_id: p.tenant_id,
        conversation_id: row.conversation_id,
        elicitation_id: row.id,
        approval_id: p.approval_id,
        approver_user_id: p.approver_user_id,
        decision: p.decision,
      });
      if (enqueued) {
        resumed += 1;
        logger.info({
          module: "conversation",
          action: "approval.completion_resumed",
          msg: "human's approval decision staged and conversation resume enqueued",
          tenant_id: p.tenant_id,
          conversation_id: row.conversation_id,
          elicitation_id: row.id,
          approval_id: p.approval_id,
          decision: p.decision,
        });
      } else {
        logger.warn({
          module: "conversation",
          action: "approval.completion_resume_failed",
          msg: "approval decision is recorded and staged but the resume turn could not be enqueued; the expiry sweep is the backstop",
          tenant_id: p.tenant_id,
          conversation_id: row.conversation_id,
          elicitation_id: row.id,
          approval_id: p.approval_id,
        });
      }
    } catch (err) {
      // Never fail the human's decision because the follow-up stumbled. The
      // grant is already durable; the backstop reconciles the rest.
      logger.error({
        module: "conversation",
        action: "approval.completion_failed",
        msg: "completing the conversation paired with a decided approval failed",
        tenant_id: p.tenant_id,
        conversation_id: row.conversation_id,
        elicitation_id: row.id,
        approval_id: p.approval_id,
        ...errorFields(err),
      });
    }
  }
  return { matched: rows.length, resumed };
}
