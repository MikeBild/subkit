import { logger } from "../../../../logging/index.ts";
import { listWorkflowsUsingConnector } from "../../../../workflows/connector-refs.ts";
import { confirmQuestion, policyPauseNote } from "../../../core/tool-invoke.ts";
import { createElicitation } from "../../../elicitations.ts";
import { saveEvidenceLabel } from "../../../handoff-summary.ts";
import { resolveSaveVerification } from "../../../persistence/commit-workflow.ts";
import { updateToolCallOutput } from "../../../persistence/index.ts";
import { withApprovalHandle, withoutApprovalHandle } from "../../ask-user/commit-intent.ts";
import type { GateSubject } from "../gate-subjects.ts";
import {
  buildConfirmedToolCallIntent,
  buildPolicyGateCommitIntent,
  confirmationMetadataForTool,
  topLevelElicitationKindForTool,
} from "../policy-helpers.ts";
import { describeToolEffect } from "../pregate.ts";
import type { WrappedToolOutput } from "../state.ts";
import {
  elicitationActor,
  type InvokeCall,
  type InvokeEnv,
  pushToolResult,
  recordCall,
} from "./env.ts";
import type { Gate, PreparedGate } from "./gate.ts";

type NeedsConfirm = Extract<Gate, { kind: "needs_confirm" }>;

async function connectorDependents(
  env: InvokeEnv,
  rawArgs: Record<string, unknown>,
): Promise<Array<{ id: string; slug: string; name: string }>> {
  if (env.inner.name !== "delete_connector") return [];
  const connectorId = typeof rawArgs.id === "string" ? rawArgs.id : null;
  if (!connectorId) return [];
  return listWorkflowsUsingConnector(env.ctx.tenant_id, connectorId, env.db);
}

export async function pauseForConfirmation(
  env: InvokeEnv,
  call: InvokeCall,
  gate: NeedsConfirm,
  preparedGate: PreparedGate,
): Promise<WrappedToolOutput> {
  const { inner, ctx, signals, events, db } = env;
  const { rawArgs, perCallCtx, toolCallId, assistantMessageId } = call;
  const resolvedMode = gate.record.mode;
  const gatedEffect = gate.effect;
  const pendingOutput = preparedGate.pending_output;
  const saveVerification =
    inner.name === "save_workflow_draft"
      ? await resolveSaveVerification(perCallCtx, ctx.getDraft())
      : null;
  const buildPolicyGateSummary = (): string => {
    if (saveVerification) {
      const draft = ctx.getDraft();
      const wfName = draft.summary?.active_target?.name ?? draft.workflow?.name ?? "(unnamed)";
      return `Save inactive draft "${wfName}" · test run without effect: ${saveEvidenceLabel(saveVerification)}`;
    }
    if (inner.name === "run_workflow") {
      const draft = ctx.getDraft();
      const explicitWorkflow =
        typeof rawArgs.workflow === "string"
          ? rawArgs.workflow
          : typeof rawArgs.workflow_id === "string"
            ? rawArgs.workflow_id
            : null;
      const wfName =
        explicitWorkflow ??
        draft.summary?.active_target?.name ??
        draft.workflow?.name ??
        "(unnamed)";
      const environment =
        (rawArgs &&
          typeof rawArgs === "object" &&
          (rawArgs as { environment?: string }).environment) ??
        "dev";
      const lastPreview = draft.latest_preview;
      const previewBit = lastPreview?.summary
        ? ` · last preview: ${lastPreview.summary.slice(0, 80)}`
        : "";
      return `Run workflow "${wfName}" in ${environment}${previewBit}`;
    }
    if (inner.name === "apply_package_import") {
      const [subject] = Array.isArray(pendingOutput?.subjects)
        ? (pendingOutput.subjects as GateSubject[])
        : [];
      const label = ctx.locale === "en" ? "Import package" : "Paket importieren";
      return subject?.title ? `${label}: ${subject.title}` : label;
    }
    if (gatedEffect) return describeToolEffect(gatedEffect);
    return `Confirm ${inner.name} (policy: ${resolvedMode})`;
  };
  const policyGateSummary = buildPolicyGateSummary();
  const topLevelKind = topLevelElicitationKindForTool(inner.name);
  let policyCommitIntent = buildPolicyGateCommitIntent(inner.name, rawArgs);
  const policyApprovalUrl = gate.approval_url;
  if (gate.approval_id) {
    policyCommitIntent = policyCommitIntent
      ? withApprovalHandle(policyCommitIntent, gate.approval_id)
      : buildConfirmedToolCallIntent(inner.name, gate.approval_id);
  }
  const connectorDeleteDependents = await connectorDependents(env, rawArgs);
  const hasConnectorDeleteDependents = connectorDeleteDependents.length > 0;
  const elicitationInput: Record<string, unknown> = {
    kind: topLevelKind,
    question: confirmQuestion(
      inner.name,
      connectorDeleteDependents,
      gatedEffect ? describeToolEffect(gatedEffect) : null,
    ),
    target: { tool: inner.name, args: rawArgs },
    ...(gatedEffect ? { effect: gatedEffect } : {}),
    ...(saveVerification ? { verification: saveVerification } : {}),
    ...confirmationMetadataForTool(inner.name, rawArgs),
    ...(pendingOutput ? { pending_output: pendingOutput } : {}),
    ...(call.policyRecord
      ? {
          bound_action: call.policyRecord.bound_action,
          ask_reason: call.policyRecord.ask_reason,
        }
      : {}),
    ...(policyCommitIntent ? { commit_intent: policyCommitIntent } : {}),
    ...(policyApprovalUrl ? { approval_url: policyApprovalUrl } : {}),
    ...(hasConnectorDeleteDependents
      ? {
          dependents: connectorDeleteDependents,
          next_best_actions: ["edit_workflow_patch"],
        }
      : {}),
  };
  const elicitation = await createElicitation(
    {
      tenant_id: ctx.tenant_id,
      conversation_id: ctx.conversation_id,
      tool_call_id: toolCallId,
      parent_message_id: assistantMessageId,
      tool_name: "ask_user_confirm",
      summary: policyGateSummary,
      input: elicitationInput,
      ...elicitationActor(ctx),
    },
    db,
  );
  signals.pendingChildElicitationIds.push(elicitation.id);
  const operatorInput = withoutApprovalHandle(elicitationInput);
  logger.info({
    module: "conversation_tool",
    action: "policy.gate_paused",
    msg: "policy gate paused tool execution and emitted ask_user_confirm",
    tenant_id: ctx.tenant_id,
    conversation_id: ctx.conversation_id,
    tool: inner.name,
    category: inner.category,
    elicitation_id: elicitation.id,
    tool_call_id: toolCallId,
    elicitation_kind: topLevelKind,
    has_commit_intent: policyCommitIntent !== null,
    ...(policyCommitIntent ? { commit_intent_kind: policyCommitIntent.kind as string } : {}),
  });
  const output = {
    pending: true,
    status: "awaiting_confirmation" as const,
    policy_mode: resolvedMode,
    elicitation_id: elicitation.id,
    ...(policyApprovalUrl ? { approval_url: policyApprovalUrl } : {}),
    note: policyPauseNote(inner.name, Boolean(policyCommitIntent), policyApprovalUrl),
  };
  await updateToolCallOutput(db, toolCallId, output, "pending");
  pushToolResult(env, call, output);
  events.push({
    type: "elicit_request",
    elicitation_id: elicitation.id,
    tool_call_id: toolCallId,
    tool_name: "ask_user_confirm",
    summary: elicitation.summary,
    input: operatorInput,
    parent_message_id: assistantMessageId,
    ...(pendingOutput ? { pending_output: pendingOutput } : {}),
  });
  signals.pendingElicitation = {
    elicitation_id: elicitation.id,
    tool_name: "ask_user_confirm",
    kind: topLevelKind,
    summary: policyGateSummary,
    input: operatorInput,
  };
  recordCall(env, call, "denied");
  return {
    ok: false,
    data: output,
    pause: {
      elicitation_id: elicitation.id,
      tool_name: "ask_user_confirm",
      summary: policyGateSummary,
      kind: topLevelKind,
      input: operatorInput,
    },
  };
}
