import { logger } from "../../../logging/logger.ts";
import {
  acceptedPatchResult,
  noOpsAcceptedResult,
  readApprovedIndices,
  readPatches,
} from "../../core/auto-persist.ts";
import { partitionDiffs } from "../../json-patch-apply.ts";
import { applyWorkflowPatchToDraft } from "../../tools/edit-workflow-patch.ts";
import type { ToolResult } from "../../tools/index.ts";
import { commitWorkflowAtomic } from "../commit-workflow.ts";
import { saveConnectorAtomic } from "../save-connector.ts";
import { invalidIntent } from "./context.ts";
import { mergeFormIntoCredential } from "./credential-cache.ts";
import { maybeAutoFreshenCheckpointsForSave, maybeAutoProbeForSave } from "./dispatch.ts";
import { readEnvironment, readString } from "./helpers.ts";
import type { CommitEnv } from "./types.ts";

export async function saveConnectorDraft({ p, intent, ctx }: CommitEnv): Promise<ToolResult> {
  const credential = mergeFormIntoCredential(intent, p.elicitation_output);
  const environment = readEnvironment(intent);
  await maybeAutoProbeForSave(ctx, p.tenant_id);
  await maybeAutoFreshenCheckpointsForSave(ctx);
  const forceSave = intent.payload.force_save === true;
  return saveConnectorAtomic({
    ctx,
    environment,
    ...(credential ? { credential } : {}),
    ...(forceSave ? { forceSave: true, forceSaveApproved: true } : {}),
    reason: "auto_persist_on_confirmation",
    emitAutoPersistAudit: true,
    commitIntentKind: intent.kind,
  });
}

export async function saveWorkflowDraft({ intent, ctx }: CommitEnv): Promise<ToolResult> {
  const targetId = readString(intent.payload, "target_workflow_id");
  const forceCommit = intent.payload.force_commit === true;
  return commitWorkflowAtomic({
    ctx,
    ...(targetId ? { target_workflow_id: targetId } : {}),
    ...(forceCommit ? { forceCommit: true } : {}),
    skipPriorApprovalCheck: true,
    reason: "auto_persist_on_confirmation",
    emitAutoPersistAudit: true,
    commitIntentKind: intent.kind,
  });
}

export async function applyWorkflowPatch({ p, intent, ctx }: CommitEnv): Promise<ToolResult> {
  const patches = readPatches(intent.payload.patches);
  if (!patches) {
    return invalidIntent("apply_workflow_patch commit_intent is missing payload.patches");
  }
  const selection = readApprovedIndices(p.elicitation_output, patches.length);
  const approvedIndices = selection ?? patches.map((_, i) => i);
  const { approved, rejected } = partitionDiffs(patches, approvedIndices);
  if (approved.length === 0) return noOpsAcceptedResult(rejected);
  const applyResult = await applyWorkflowPatchToDraft(ctx, approved);
  if (applyResult.ok) {
    const partial = rejected.length > 0;
    logger.info({
      module: "conversation_persistence",
      action: "auto_persist.apply_workflow_patch",
      msg: partial
        ? "operator partially accepted a workflow-draft edit — applied a subset of ops"
        : "operator accepted a workflow-draft edit — applied all ops",
      tenant_id: p.tenant_id,
      conversation_id: p.conversation_id,
      applied_count: approved.length,
      skipped_count: rejected.length,
    });
  }
  return acceptedPatchResult(applyResult, approved, rejected);
}
