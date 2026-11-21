import type { ResolvedPrincipal } from "../../../auth/types.ts";
import type { Db } from "../../../db/client.ts";
import { logger } from "../../../logging/index.ts";
import { consumeApproval, declineApproval, grantApproval } from "../../../tools/approval.ts";
import type { AnswerActor } from "../../answer-actor.ts";
import { approvalHandleFromElicitationInput } from "../../tools/ask-user/commit-intent.ts";
import type { AutoPersistInput } from "./types.ts";

export async function grantApprovalIfHuman(p: {
  db: Db;
  tenant_id: string;
  conversation_id: string;
  approval_id: string;
  tool: string;
  actor: AnswerActor;
}): Promise<boolean> {
  if (p.actor.kind !== "human") {
    logger.warn({
      module: "conversation_persistence",
      action: "auto_persist.approval_not_granted_by_relay",
      msg: "an approval-bearing elicitation was answered by a non-human actor; nothing was granted and the claim will refuse unless a person granted it in the approval portal",
      tenant_id: p.tenant_id,
      conversation_id: p.conversation_id,
      approval_id: p.approval_id,
      tool: p.tool,
      relay_reason: p.actor.reason,
    });
    return false;
  }
  const granted = await grantApproval({
    db: p.db,
    approval_id: p.approval_id,
    tenant_id: p.tenant_id,
    granted_by_user_id: p.actor.user_id,
    via: p.actor.via,
  });
  if (granted.ok) return true;
  if (granted.code === "approval_already_granted") return true;
  logger.warn({
    module: "conversation_persistence",
    action: "auto_persist.approval_grant_missed",
    msg: "a person answered the approval but the grant did not land; the claim decides the outcome",
    tenant_id: p.tenant_id,
    conversation_id: p.conversation_id,
    approval_id: p.approval_id,
    tool: p.tool,
    user_id: p.actor.user_id,
    error_code: granted.code,
  });
  return false;
}

export async function declineApprovalIfHuman(p: {
  db: Db;
  tenant_id: string;
  conversation_id: string;
  elicitation_id: string;
  elicitation_input: unknown;
  actor: AnswerActor;
}): Promise<void> {
  const approvalId = approvalHandleFromElicitationInput(p.elicitation_input);
  if (!approvalId) return;
  if (p.actor.kind !== "human") {
    logger.warn({
      module: "conversation_persistence",
      action: "auto_persist.approval_not_declined_by_relay",
      msg: "an approval-bearing elicitation was declined by a non-human actor; the approval was left pending a person's decision",
      tenant_id: p.tenant_id,
      conversation_id: p.conversation_id,
      elicitation_id: p.elicitation_id,
      approval_id: approvalId,
      relay_reason: p.actor.reason,
    });
    return;
  }
  const declined = await declineApproval({
    db: p.db,
    approval_id: approvalId,
    tenant_id: p.tenant_id,
    granted_by_user_id: p.actor.user_id,
    via: p.actor.via,
  });
  logger.info({
    module: "conversation_persistence",
    action: "auto_persist.approval_declined",
    msg: "a person declined the approval this elicitation carried; nothing ran and the approval is dead",
    tenant_id: p.tenant_id,
    conversation_id: p.conversation_id,
    elicitation_id: p.elicitation_id,
    approval_id: approvalId,
    user_id: p.actor.user_id,
    decision_recorded: declined.ok,
    ...(declined.ok ? {} : { error_code: declined.code }),
  });
}

export async function grantAndClaim(
  p: AutoPersistInput,
  approvalId: string,
  tool: string,
  principal: ResolvedPrincipal,
) {
  await grantApprovalIfHuman({
    db: p.db,
    tenant_id: p.tenant_id,
    conversation_id: p.conversation_id,
    approval_id: approvalId,
    tool,
    actor: p.answer_actor,
  });
  return consumeApproval({
    db: p.db,
    principal,
    approval_id: approvalId,
    tool,
    surface: "chat",
    via: "chat",
  });
}
