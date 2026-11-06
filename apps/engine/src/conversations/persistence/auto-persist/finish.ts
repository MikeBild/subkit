import { and, eq, isNull } from "drizzle-orm";
import { auditAwait } from "../../../audit/audit.ts";
import { AuditAction } from "../../../audit/types.ts";
import { conversationElicitations } from "../../../db/schema/index.ts";
import { logger } from "../../../logging/logger.ts";
import {
  completionAudit,
  dispatchErrorSynthetic,
  errorDetail,
  gatedCallOutcome,
  pgErrorFields,
} from "../../core/auto-persist.ts";
import type { CommitIntent } from "../../tools/ask-user/commit-intent.ts";
import { autoPersistActor, injectAndDispatch, recordGatedCallOutcome } from "./context.ts";
import { translateAutoPersistError } from "./error-translation.ts";
import {
  buildSyntheticFromResult,
  intentToolName,
  isCompletedWorkflowPreparation,
} from "./synthetic.ts";
import type { AutoPersistDispatch, AutoPersistInput, CommitOutcome } from "./types.ts";

export async function finishThrown(
  p: AutoPersistInput,
  intent: CommitIntent,
  err: unknown,
): Promise<AutoPersistDispatch> {
  logger.error({
    module: "auto-persist",
    action: "dispatch.threw",
    msg: "auto-persist dispatcher threw — surfacing structured error to the LLM",
    tenant_id: p.tenant_id,
    conversation_id: p.conversation_id,
    elicitation_id: p.elicitation.id,
    commit_intent_kind: intent.kind,
    ...pgErrorFields(err),
    error: errorDetail(err),
  });
  const translated = translateAutoPersistError(err, intent.kind);
  const synthetic = dispatchErrorSynthetic(intentToolName(intent), translated);
  await recordGatedCallOutcome(p, "error");
  return injectAndDispatch(p, synthetic, "confirmed", { intent });
}

export async function finishCommitted(
  p: AutoPersistInput,
  intent: CommitIntent,
  { toolName, result }: CommitOutcome,
): Promise<AutoPersistDispatch> {
  const prepared = isCompletedWorkflowPreparation(intent.kind, result.data);
  const audit = completionAudit({
    kind: intent.kind,
    toolName,
    result,
    prepared,
    conversationId: p.conversation_id,
  });
  await auditAwait(
    {
      tenant_id: p.tenant_id,
      ...autoPersistActor(p),
      action: audit.resumed ? AuditAction.CONVERSATION_RESUMED : AuditAction.APPROVAL_APPROVED,
      resource_type: "conversation_elicitation",
      resource_id: p.elicitation.id,
      result: audit.result,
      reason: audit.reason,
      metadata: audit.metadata,
    },
    p.db,
  );
  const synthetic = buildSyntheticFromResult(toolName, result);
  await recordGatedCallOutcome(p, gatedCallOutcome(result, prepared));
  const dispatch = await injectAndDispatch(p, synthetic, "confirmed", { intent });
  if (result.pause) {
    await p.db
      .update(conversationElicitations)
      .set({ tool_call_id: dispatch.synthetic_tool_call_id })
      .where(
        and(
          eq(conversationElicitations.tenant_id, p.tenant_id),
          eq(conversationElicitations.conversation_id, p.conversation_id),
          eq(conversationElicitations.id, result.pause.elicitation_id),
          eq(conversationElicitations.status, "pending"),
          isNull(conversationElicitations.tool_call_id),
        ),
      );
  }
  return dispatch;
}
