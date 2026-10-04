import type { Db } from "../db/client.ts";
import { errorFields, logger } from "../logging/logger.ts";
import { stageElicitationAnswer } from "./elicitations.ts";
import { markApprovalElicitationsComplete } from "./native-url-elicitation.ts";

export type ApprovalResumeEnqueuer = (p: {
  tenant_id: string;
  conversation_id: string;
  elicitation_id: string;
  approval_id: string;
  approver_user_id: string | null;
  decision: "approve" | "decline";
}) => Promise<boolean>;

export interface ApprovalCompletionResult {
  matched: number;
  resumed: number;
}

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
