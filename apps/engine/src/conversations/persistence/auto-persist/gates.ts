import { auditAwait } from "../../../audit/audit.ts";
import { AuditAction } from "../../../audit/types.ts";
import { logger } from "../../../logging/logger.ts";
import {
  chatReadonlySynthetic,
  chatRefusesIntent,
  elicitationInputKind,
  isWriteShapedConfirm,
  writeNotDispatchedSynthetic,
} from "../../core/auto-persist.ts";
import type { CommitIntent } from "../../tools/ask-user/commit-intent.ts";
import { interpretConfirmDecision } from "../../tools/ask-user/interpret-confirm.ts";
import { declineApprovalIfHuman } from "./approval.ts";
import { autoPersistActor, injectAndDispatch, recordGatedCallOutcome } from "./context.ts";
import { buildDeclineSynthetic, checkDecline } from "./synthetic.ts";
import type { AutoPersistDispatch, AutoPersistInput } from "./types.ts";

export async function dispatchWithoutIntent(p: AutoPersistInput): Promise<AutoPersistDispatch> {
  const inputKind = elicitationInputKind(p.elicitation.input);
  logger.info({
    module: "conversation_persistence",
    action: "auto_persist.skipped",
    msg: "elicitation resolved without commit_intent — no harness write dispatched",
    tenant_id: p.tenant_id,
    conversation_id: p.conversation_id,
    elicitation_id: p.elicitation.id,
    elicitation_tool_name: p.elicitation.tool_name,
    elicitation_input_kind: inputKind,
  });
  if (
    isWriteShapedConfirm(p.elicitation.tool_name, inputKind) &&
    interpretConfirmDecision(p.elicitation_output) === "confirmed"
  ) {
    const { synthetic, description } = writeNotDispatchedSynthetic(inputKind as string);
    return injectAndDispatch(p, synthetic, "confirmed", { description });
  }
  return { dispatched: false };
}

export async function dispatchDecline(
  p: AutoPersistInput,
  intent: CommitIntent,
): Promise<AutoPersistDispatch | null> {
  const declineCheck = checkDecline(p.elicitation.tool_name, p.elicitation_output);
  if (!declineCheck) return null;
  await declineApprovalIfHuman({
    db: p.db,
    tenant_id: p.tenant_id,
    conversation_id: p.conversation_id,
    elicitation_id: p.elicitation.id,
    elicitation_input: p.elicitation.input,
    actor: p.answer_actor,
  });
  return injectAndDispatch(p, buildDeclineSynthetic(intent, declineCheck), "declined", { intent });
}

export async function refuseOnReadonlyChat(
  p: AutoPersistInput,
  intent: CommitIntent,
): Promise<AutoPersistDispatch | null> {
  if (!chatRefusesIntent(p.surface, intent.kind)) return null;
  logger.warn({
    module: "conversation_persistence",
    action: "auto_persist.denied_chat_readonly",
    msg: "commit_intent refused on the read-only chat surface — no harness write dispatched",
    tenant_id: p.tenant_id,
    conversation_id: p.conversation_id,
    elicitation_id: p.elicitation.id,
    intent_kind: intent.kind,
  });
  await auditAwait(
    {
      tenant_id: p.tenant_id,
      ...autoPersistActor(p),
      action: AuditAction.POLICY_DENIED,
      resource_type: "conversation_elicitation",
      resource_id: p.elicitation.id,
      result: "denied",
      reason: "chat_readonly_commit_intent",
      metadata: { conversation_id: p.conversation_id, intent_kind: intent.kind },
    },
    p.db,
  );
  const synthetic = chatReadonlySynthetic(p.elicitation.tool_name, intent.kind);
  await recordGatedCallOutcome(p, "error");
  return injectAndDispatch(p, synthetic, "confirmed", { intent });
}
