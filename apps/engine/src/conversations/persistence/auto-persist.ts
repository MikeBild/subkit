import { and, desc, eq, isNull, like, not } from "drizzle-orm";
import { auditAwait } from "../../audit/audit.ts";
import { AuditAction } from "../../audit/types.ts";
import type { ResolvedPrincipal } from "../../auth/types.ts";
import { getConnector } from "../../connectors/service.ts";
import { getCredentialForConnector } from "../../credentials/service.ts";
import type { Db } from "../../db/client.ts";
import { conversationElicitations, conversationToolCalls } from "../../db/schema/index.ts";
import { EngineClient } from "../../engine-client/index.ts";
import { runExecution } from "../../execution/engine.ts";
import { approvedDispatchOutcome } from "../../execution/tool-approval-dispatch.ts";
import { HELD_PREVIEW_WARNING_CODE } from "../../execution/types.ts";
import { admitWorkflowRun } from "../../execution/workflow-run-admission.ts";
import { logger } from "../../logging/logger.ts";
import {
  approvalAuditResource,
  consumeApproval,
  declineApproval,
  grantApproval,
  recordApprovalApproved,
  recordApprovalUnfulfilled,
} from "../../tools/approval.ts";
import { preparedWorkflowMatches } from "../../tools/prepared-workflow-approval.ts";
import { resolveWorkflowInputContract } from "../../workflows/input-schema-synth.ts";
import { resolveWorkflowByIdOrSlug } from "../../workflows/lookup.ts";
import { gateWorkflowRunRbac } from "../../workflows/rbac.ts";
import type { WorkflowDef } from "../../workflows/types.ts";
import type { AnswerActor } from "../answer-actor.ts";
import { resolveAttachmentSlugsInArgs, walkAndResolve } from "../attachments.ts";
import { appendSnapshot, loadDraft } from "../draft.ts";
import { partitionDiffs, type ToolDiff } from "../json-patch-apply.ts";
import {
  approvalHandleFromElicitationInput,
  type CommitIntentKind,
  describePatchOps,
} from "../tools/ask-user/commit-intent.ts";
import { interpretConfirmDecision } from "../tools/ask-user/interpret-confirm.ts";
import { WORKFLOW_TOOL_PREFIX } from "../tools/authoring-palette.ts";
import { applyWorkflowPatchToDraft } from "../tools/edit-workflow-patch.ts";
import { CreateApiKeyInput, createApiKeyTool } from "../tools/engine-api/writes/create-api-key.ts";
import {
  UpdateWorkflowInput,
  updateWorkflowTool,
} from "../tools/engine-api/writes/update-workflow.ts";
import type { ToolContext, ToolResult } from "../tools/index.ts";
import { checkToolPermission, resolveConversationPrincipal } from "../tools/permission-gate.ts";
import { normalizeWorkflowInput, workflowInputRecord } from "../tools/workflow-input-normalize.ts";
import { mergeFormIntoCredential } from "./auto-persist/credential-cache.ts";
import {
  dispatchDeleteConnector,
  dispatchDeleteWorkflow,
  dispatchRollbackSkipped,
  maybeAutoFreshenCheckpointsForSave,
  maybeAutoProbeForSave,
} from "./auto-persist/dispatch.ts";
import { translateAutoPersistError } from "./auto-persist/error-translation.ts";
import { readEnvironment, readString } from "./auto-persist/helpers.ts";
import {
  buildDeclineSynthetic,
  buildSyntheticFromResult,
  checkDecline,
  extractCommitIntent,
  injectSyntheticToolCall,
  intentToolName,
  isCompletedWorkflowPreparation,
  type SyntheticToolResult,
} from "./auto-persist/synthetic.ts";
import { commitWorkflowAtomic } from "./commit-workflow.ts";
import { saveConnectorAtomic } from "./save-connector.ts";

export {
  extractCredentialFromFormOutput,
  maybeCacheDraftCredentialFromElicitation,
} from "./auto-persist/credential-cache.ts";
export {
  type ErrorTranslationContext,
  translateAutoPersistError,
} from "./auto-persist/error-translation.ts";
export type { SyntheticToolResult } from "./auto-persist/synthetic.ts";

export interface AutoPersistInput {
  tenant_id: string;
  conversation_id: string;
  actor_id: string | null;
  principal?: ResolvedPrincipal | null;
  answer_actor: AnswerActor;
  elicitation_output: unknown;
  elicitation: {
    id: string;
    tool_name: string;
    input: unknown;
    tool_call_id?: string | null;
  };
  surface?: "sk_headless" | "sk_interactive" | "mcp" | "web" | "chat";
  db: Db;
}

async function recordGatedCallOutcome(p: AutoPersistInput, outcome: "ok" | "error"): Promise<void> {
  const gatedCallId = p.elicitation.tool_call_id;
  if (!gatedCallId) return;
  await p.db
    .update(conversationToolCalls)
    .set({ outcome })
    .where(
      and(
        eq(conversationToolCalls.tenant_id, p.tenant_id),
        eq(conversationToolCalls.id, gatedCallId),
        not(like(conversationToolCalls.tool, "ask\\_user\\_%")),
      ),
    );
}

const CHAT_DISPATCHABLE_INTENTS: ReadonlySet<CommitIntentKind> = new Set([
  "run_workflow",
  "commit_held_workflow_writes",
]);

export interface AutoPersistDispatch {
  dispatched: boolean;
  synthetic_result?: SyntheticToolResult;
  synthetic_tool_call_id?: string;
}

function readFormValues(output: unknown): Record<string, unknown> {
  if (!output || typeof output !== "object" || Array.isArray(output)) return {};
  const obj = output as Record<string, unknown>;
  const wrapped = obj.values;
  if (wrapped && typeof wrapped === "object" && !Array.isArray(wrapped)) {
    return wrapped as Record<string, unknown>;
  }
  return obj;
}

function readSubmittedWorkflowInput(toolName: string, output: unknown): Record<string, unknown> {
  return toolName === "ask_user_form" ? readFormValues(output) : {};
}

function readApprovedIndices(output: unknown, total: number): number[] | null {
  const o = output && typeof output === "object" ? (output as Record<string, unknown>) : null;
  const raw = o?.approved_indices;
  if (!Array.isArray(raw)) return null;
  const seen = new Set<number>();
  for (const n of raw) {
    if (typeof n === "number" && Number.isInteger(n) && n >= 0 && n < total) seen.add(n);
  }
  return [...seen].sort((a, b) => a - b);
}

async function grantApprovalIfHuman(p: {
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

async function declineApprovalIfHuman(p: {
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

export async function maybeAutoPersistFromElicitation(
  p: AutoPersistInput,
): Promise<AutoPersistDispatch> {
  const intent = extractCommitIntent(p.elicitation.input);
  if (!intent) {
    const elicitationInputKind =
      p.elicitation.input && typeof p.elicitation.input === "object" && p.elicitation.input !== null
        ? ((p.elicitation.input as { kind?: unknown }).kind ?? null)
        : null;
    const inputKind = typeof elicitationInputKind === "string" ? elicitationInputKind : null;
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

    const isWriteShapedConfirm =
      p.elicitation.tool_name === "ask_user_confirm" &&
      (inputKind === "external_write" || inputKind === "save_workflow_draft");
    if (isWriteShapedConfirm && interpretConfirmDecision(p.elicitation_output) === "confirmed") {
      const synthetic: SyntheticToolResult = {
        tool: "ask_user_confirm",
        ok: false,
        error_code: "write_not_dispatched",
        message: `You approved a write confirmation (kind=${inputKind}) but it carried no commit_intent, so the harness performed NO write — nothing was persisted or executed. Do NOT report success. To actually perform it, re-issue ask_user_confirm with a commit_intent (e.g. {kind: "save_workflow_draft"} for a workflow step edit, {kind: "update_workflow_metadata", payload:{id,description}} for a metadata/description edit, {kind: "run_workflow", payload:{workflow_id,…}} for a run), OR call the underlying write tool now and confirm its result before telling the user it succeeded.`,
        next_best_actions:
          inputKind === "external_write"
            ? ["run_workflow", "ask_user_confirm"]
            : ["ask_user_confirm", "save_workflow_draft"],
        source: "harness_auto_persist",
      };
      const callId = await injectSyntheticToolCall({
        db: p.db,
        tenant_id: p.tenant_id,
        conversation_id: p.conversation_id,
        synthetic,
        description: `write confirmation approved without commit_intent (kind=${inputKind})`,
        decision: "confirmed",
      });
      return { dispatched: true, synthetic_result: synthetic, synthetic_tool_call_id: callId };
    }
    return { dispatched: false };
  }

  const declineCheck = checkDecline(p.elicitation.tool_name, p.elicitation_output);
  if (declineCheck) {
    await declineApprovalIfHuman({
      db: p.db,
      tenant_id: p.tenant_id,
      conversation_id: p.conversation_id,
      elicitation_id: p.elicitation.id,
      elicitation_input: p.elicitation.input,
      actor: p.answer_actor,
    });
    const synthetic = buildDeclineSynthetic(intent, declineCheck);
    const callId = await injectSyntheticToolCall({
      db: p.db,
      tenant_id: p.tenant_id,
      conversation_id: p.conversation_id,
      synthetic,
      intent,
      decision: "declined",
    });
    return { dispatched: true, synthetic_result: synthetic, synthetic_tool_call_id: callId };
  }

  if (p.surface === "chat" && !CHAT_DISPATCHABLE_INTENTS.has(intent.kind)) {
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
        actor_type: p.actor_id ? "user" : "system",
        actor_id: p.actor_id,
        action: AuditAction.POLICY_DENIED,
        resource_type: "conversation_elicitation",
        resource_id: p.elicitation.id,
        result: "denied",
        reason: "chat_readonly_commit_intent",
        metadata: { conversation_id: p.conversation_id, intent_kind: intent.kind },
      },
      p.db,
    );
    const synthetic: SyntheticToolResult = {
      tool: p.elicitation.tool_name,
      ok: false,
      error_code: "chat_readonly_channel",
      message: `This chat channel is read-only: the approved ${intent.kind} was NOT performed — nothing was persisted or deleted. Do NOT report success. Tell the user to make this change via the sk CLI or the web portal.`,
      next_best_actions: ["cannot_help"],
      source: "harness_auto_persist",
    };
    await recordGatedCallOutcome(p, "error");
    const callId = await injectSyntheticToolCall({
      db: p.db,
      tenant_id: p.tenant_id,
      conversation_id: p.conversation_id,
      synthetic,
      intent,
      decision: "confirmed",
    });
    return { dispatched: true, synthetic_result: synthetic, synthetic_tool_call_id: callId };
  }

  const draft = await loadDraft(p.tenant_id, p.conversation_id, p.db);
  let liveDraft = draft;
  const ctx: ToolContext = {
    db: p.db,
    tenant_id: p.tenant_id,
    conversation_id: p.conversation_id,
    actor_id: p.actor_id,
    ...(p.principal ? { principal: p.principal } : {}),
    connector_id: null,
    workflow_id: null,
    permission_mode: null,
    engineClient: new EngineClient({
      tenant_id: p.tenant_id,
      actor_id: p.actor_id,
      actor_type: p.actor_id ? "user" : "system",
      db: p.db,
    }),
    getDraft: () => liveDraft,
    setDraft: async (next) => {
      liveDraft = next;
      await appendSnapshot(p.tenant_id, p.conversation_id, next, p.db);
    },
  };

  let result: ToolResult;
  let toolName: string;
  try {
    switch (intent.kind) {
      case "save_connector_draft": {
        toolName = "save_connector_draft";
        const credential = mergeFormIntoCredential(intent, p.elicitation_output);
        const environment = readEnvironment(intent);
        await maybeAutoProbeForSave(ctx, p.tenant_id);
        await maybeAutoFreshenCheckpointsForSave(ctx);
        const forceSave = intent.payload.force_save === true;
        result = await saveConnectorAtomic({
          ctx,
          environment,
          ...(credential ? { credential } : {}),
          ...(forceSave ? { forceSave: true, forceSaveApproved: true } : {}),
          reason: "auto_persist_on_confirmation",
          emitAutoPersistAudit: true,
          commitIntentKind: intent.kind,
        });
        break;
      }
      case "save_workflow_draft": {
        toolName = "save_workflow_draft";
        const targetId = readString(intent.payload, "target_workflow_id");
        const forceCommit = intent.payload.force_commit === true;
        result = await commitWorkflowAtomic({
          ctx,
          ...(targetId ? { target_workflow_id: targetId } : {}),
          ...(forceCommit ? { forceCommit: true } : {}),
          skipPriorApprovalCheck: true,
          reason: "auto_persist_on_confirmation",
          emitAutoPersistAudit: true,
          commitIntentKind: intent.kind,
        });
        break;
      }
      case "apply_workflow_patch": {
        toolName = "edit_workflow_patch";
        const rawPatches = intent.payload.patches;
        const patches = Array.isArray(rawPatches) ? (rawPatches as ToolDiff[]) : null;
        if (!patches || patches.length === 0) {
          result = {
            ok: false,
            error_code: "invalid_commit_intent",
            message: "apply_workflow_patch commit_intent is missing payload.patches",
            data: {},
          };
          break;
        }
        const selection = readApprovedIndices(p.elicitation_output, patches.length);
        const approvedIndices = selection ?? patches.map((_, i) => i);
        const { approved, rejected } = partitionDiffs(patches, approvedIndices);
        if (approved.length === 0) {
          result = {
            ok: false,
            error_code: "no_ops_accepted",
            message:
              "no patch ops were accepted — the draft was left unchanged. Re-propose the edit or accept at least one op.",
            data: {
              applied_count: 0,
              skipped_count: rejected.length,
              skipped_ops: describePatchOps(rejected),
            },
          };
          break;
        }
        const applyResult = await applyWorkflowPatchToDraft(ctx, approved);
        if (applyResult.ok) {
          const partial = rejected.length > 0;
          const baseData =
            applyResult.data && typeof applyResult.data === "object"
              ? (applyResult.data as Record<string, unknown>)
              : {};
          result = {
            ...applyResult,
            data: {
              ...baseData,
              partial,
              applied_count: approved.length,
              skipped_count: rejected.length,
              applied_ops: describePatchOps(approved),
              ...(partial ? { skipped_ops: describePatchOps(rejected) } : {}),
            },
          };
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
        } else {
          result = applyResult;
        }
        break;
      }
      case "delete_connector": {
        toolName = "delete_connector";
        result = await dispatchDeleteConnector(ctx, intent);
        break;
      }
      case "delete_workflow": {
        toolName = "delete_workflow";
        result = await dispatchDeleteWorkflow(ctx, intent);
        break;
      }
      case "rollback_after_execute": {
        toolName = "rollback_after_execute";
        result = await dispatchRollbackSkipped(ctx, intent);
        break;
      }
      case "run_workflow": {
        toolName = "run_workflow";
        const workflowRef =
          readString(intent.payload, "workflow_id") ?? readString(intent.payload, "workflow");
        if (!workflowRef) {
          result = {
            ok: false,
            error_code: "invalid_commit_intent",
            message:
              "run_workflow commit_intent is missing payload.workflow_id or payload.workflow",
            data: {},
          };
          break;
        }
        const resolved = await resolveWorkflowByIdOrSlug(p.db, p.tenant_id, workflowRef, {
          require_published: true,
        });
        if (!resolved) {
          result = {
            ok: false,
            error_code: "workflow_not_found",
            message: `no workflow matched the reference '${workflowRef}'`,
            data: { workflow: workflowRef },
          };
          break;
        }
        const workflowId = resolved.id;
        const workflowSlug = readString(intent.payload, "workflow_slug") ?? resolved.slug;
        if (!p.principal) {
          result = {
            ok: false,
            error_code: "principal_required",
            message:
              "run_workflow auto-dispatch needs the answering actor's principal for RBAC — re-issue run_workflow in the conversation instead.",
            data: { workflow_id: workflowId },
          };
          break;
        }
        const rbac = await gateWorkflowRunRbac({
          db: p.db,
          principal: p.principal,
          workflow_id: workflowId,
          workflow_slug: workflowSlug,
          request_source: "auto_persist",
          tool: "run_workflow",
        });
        if (!rbac.allow) {
          result = {
            ok: false,
            error_code: "permission_denied",
            message: rbac.error_message,
            data: { workflow_id: workflowId },
          };
          break;
        }
        const normalizedPartial = normalizeWorkflowInput(intent.payload.input_partial);
        const partial = workflowInputRecord(normalizedPartial);
        const hasStructuredInput = normalizedPartial !== undefined && normalizedPartial !== null;
        const answers = readSubmittedWorkflowInput(p.elicitation.tool_name, p.elicitation_output);
        const input =
          hasStructuredInput &&
          (typeof normalizedPartial !== "object" || Array.isArray(normalizedPartial))
            ? normalizedPartial
            : { ...partial, ...answers };
        const inputIsObject = input !== null && typeof input === "object" && !Array.isArray(input);
        if (inputIsObject) {
          const wfForContract = await ctx.engineClient.workflows.get(workflowId);
          const contract = wfForContract?.definition
            ? resolveWorkflowInputContract(wfForContract.definition as WorkflowDef)
            : null;
          if (contract && contract.required.length > 0) {
            const inputMap = workflowInputRecord(input);
            const missing = contract.required.filter((k) => {
              const v = inputMap[k];
              return v === undefined || v === null || (typeof v === "string" && v.trim() === "");
            });
            if (missing.length > 0) {
              const fmt = (keys: string[]) => keys.map((k) => `\`${k}\``).join(", ");
              result = {
                ok: false,
                error_code: "missing_workflow_input",
                message: `Workflow "${workflowSlug}" cannot run: required input ${
                  missing.length === 1 ? "field" : "fields"
                } ${fmt(missing)} ${
                  missing.length === 1 ? "is" : "are"
                } missing from the submitted input. Re-issue run_workflow so it pauses with an ask_user_form that collects EVERY required field (${fmt(
                  contract.required,
                )}) — do NOT use a single ask_user_text; the harness runs the workflow with the submitted form values.`,
                data: {
                  workflow_id: workflowId,
                  workflow_slug: workflowSlug,
                  missing_fields: missing,
                  required_fields: contract.required,
                },
              };
              logger.info({
                module: "conversation_persistence",
                action: "auto_persist.run_workflow.missing_input",
                msg: "run_workflow auto-dispatch blocked before dispatch: required input fields unbound",
                tenant_id: p.tenant_id,
                conversation_id: p.conversation_id,
                workflow_id: workflowId,
                missing_fields: missing,
              });
              break;
            }
          }
        }
        const environment = readEnvironment(intent);
        const admitted = await admitWorkflowRun(
          {
            tenant_id: p.tenant_id,
            workflow_id: workflowId,
            workflow_version_id: resolved.current_version_id ?? undefined,
            execution_environment: environment,
            request_source: "chat",
            input,
            ...(intent.payload.execute_writes === false ? { hold_writes: true } : {}),
          },
          p.db,
          p.principal,
          rbac.workflow_permission,
        );
        const run = await runExecution({
          db: p.db,
          tenant_id: p.tenant_id,
          source: {
            kind: "saved",
            workflow_id: workflowId,
            version_id: admitted.workflow_version_id,
          },
          input: admitted.input,
          options: {
            request_source: "chat",
            trace_id: null,
            principal: p.principal,
            execution_mode: environment,
            existing_execution_id: admitted.execution_id,
            hold_writes: admitted.hold_writes,
          },
        });
        const heldPreview = run.warnings?.find(
          (warning) => warning.code === HELD_PREVIEW_WARNING_CODE,
        );
        result = {
          ok: run.status === "succeeded" && !heldPreview,
          data: {
            status: run.status,
            execution_id: run.execution_id,
            workflow_id: workflowId,
            workflow_slug: workflowSlug,
            input,
            output: run.output,
            execute_writes: !admitted.hold_writes,
            hold_writes: admitted.hold_writes,
            workflow_version_id: admitted.workflow_version_id,
            execution_authority_id: admitted.execution_authority_id,
            ...(heldPreview
              ? {
                  preview: true,
                  writes_held: true,
                  message:
                    "Nothing was written. The supplied input does not authorize external effects.",
                }
              : {}),
            ...(run.warnings && run.warnings.length > 0 ? { warnings: run.warnings } : {}),
          },
        };
        break;
      }
      case "commit_held_workflow_writes": {
        toolName = intentToolName(intent);
        const approvalId = readString(intent.payload, "approval_id");
        if (!approvalId) {
          result = {
            ok: false,
            error_code: "invalid_commit_intent",
            message:
              "commit_held_workflow_writes commit_intent is missing payload.approval_id — nothing was written.",
            data: {},
          };
          break;
        }
        if (!p.principal) {
          result = {
            ok: false,
            error_code: "principal_required",
            message:
              "releasing held workflow writes needs the approving actor's principal for RBAC — nothing was written.",
            data: {},
          };
          break;
        }
        await grantApprovalIfHuman({
          db: p.db,
          tenant_id: p.tenant_id,
          conversation_id: p.conversation_id,
          approval_id: approvalId,
          tool: toolName,
          actor: p.answer_actor,
        });
        const claim = await consumeApproval({
          db: p.db,
          principal: p.principal,
          approval_id: approvalId,
          tool: toolName,
          surface: "chat",
          via: "chat",
        });
        if (!claim.ok) {
          result = { ok: false, error_code: claim.code, message: claim.message, data: {} };
          break;
        }
        const approvedTool = claim.tool;
        const workflowSlug = approvedTool.startsWith(WORKFLOW_TOOL_PREFIX)
          ? approvedTool.slice(WORKFLOW_TOOL_PREFIX.length)
          : null;
        const resolved = workflowSlug
          ? await resolveWorkflowByIdOrSlug(p.db, p.tenant_id, workflowSlug, {
              require_published: true,
            })
          : null;
        if (!resolved) {
          await recordApprovalUnfulfilled({
            db: p.db,
            principal: p.principal,
            claim,
            tool: approvedTool,
            via: "chat",
            reason: workflowSlug ? "workflow_not_found" : "not_a_workflow_tool",
          });
          result = {
            ok: false,
            error_code: workflowSlug ? "workflow_not_found" : "invalid_approval_target",
            message: workflowSlug
              ? `No saved workflow matches "${workflowSlug}" — it may have been renamed or deleted since the preview, so nothing was written. Re-run it to obtain a fresh preview.`
              : `Approval ${claim.approval_id} was granted for ${approvedTool}, which is not a saved-workflow tool — nothing was written.`,
            data: workflowSlug ? { workflow_slug: workflowSlug } : {},
            next_best_actions: ["find_workflow", "list_workflows"],
          };
          break;
        }
        const workflowId = resolved.id;
        const binding = claim.prepared_workflow;
        if (
          !preparedWorkflowMatches(binding, {
            workflow_id: workflowId,
            workflow_version_id: resolved.current_version_id,
            execution_mode: claim.execution_mode,
            args: claim.args,
          })
        ) {
          await recordApprovalUnfulfilled({
            db: p.db,
            principal: p.principal,
            claim,
            tool: approvedTool,
            via: "chat",
            reason: "prepared_workflow_changed",
          });
          result = {
            ok: false,
            error_code: "prepared_workflow_changed",
            message:
              "The reviewed workflow version or input is missing or changed. Create a fresh preview and obtain a new decision; nothing was written by this attempt.",
            data: { workflow_id: workflowId },
          };
          break;
        }
        const rbac = await gateWorkflowRunRbac({
          db: p.db,
          principal: p.principal,
          workflow_id: workflowId,
          workflow_slug: resolved.slug,
          request_source: "auto_persist",
          tool: approvedTool,
          approval: approvalAuditResource(claim),
        });
        if (!rbac.allow) {
          result = {
            ok: false,
            error_code: "permission_denied",
            message: rbac.error_message,
            data: { workflow_id: workflowId },
          };
          break;
        }
        const recorded = await recordApprovalApproved({
          db: p.db,
          principal: p.principal,
          claim,
          tool: approvedTool,
          via: "chat",
        });
        if (!recorded) {
          result = {
            ok: false,
            error_code: "approval_audit_failed",
            message: `Approval ${claim.approval_id} could not be recorded in the audit log; ${approvedTool} did not run. Re-issue ${approvedTool} to obtain a fresh preview.`,
            data: { workflow_id: workflowId },
          };
          break;
        }
        const replayInput = Object.keys(claim.args).length > 0 ? claim.args : null;
        const heldRun = await runExecution({
          db: p.db,
          tenant_id: p.tenant_id,
          source: {
            kind: "saved",
            workflow_id: workflowId,
            version_id: binding.workflow_version_id,
          },
          input: replayInput,
          options: {
            request_source: "chat",
            trace_id: null,
            principal: p.principal,
            execution_mode: claim.execution_mode ?? "dev",
            self_healing: { enabled: false },
            tool_approval_id: claim.approval_id,
          },
        });
        result = {
          ok: heldRun.status === "succeeded",
          data: {
            status: heldRun.status,
            execution_id: heldRun.execution_id,
            workflow_id: workflowId,
            workflow_slug: resolved.slug,
            output: heldRun.output,
            ...(await approvedDispatchOutcome(p.db, p.tenant_id, heldRun.execution_id)),
            ...(heldRun.warnings && heldRun.warnings.length > 0
              ? { warnings: heldRun.warnings }
              : {}),
          },
        };
        break;
      }
      case "execute_confirmed_tool_call": {
        const gatedToolName = readString(intent.payload, "tool");
        const approvalId = readString(intent.payload, "approval_id");
        toolName = gatedToolName ?? intentToolName(intent);
        if (!gatedToolName || !approvalId) {
          result = {
            ok: false,
            error_code: "invalid_commit_intent",
            message:
              "execute_confirmed_tool_call commit_intent is missing payload.tool or payload.approval_id — nothing ran.",
            data: {},
          };
          break;
        }
        const { getTool } = await import("../tools/index.ts");
        const gatedTool = getTool(gatedToolName);
        if (!gatedTool) {
          result = {
            ok: false,
            error_code: "unknown_tool",
            message: `no conversation tool named '${gatedToolName}' — nothing ran.`,
            data: {},
          };
          break;
        }
        const approver = p.principal ?? (await resolveConversationPrincipal(ctx));
        if (!approver) {
          result = {
            ok: false,
            error_code: "principal_required",
            message: `releasing the approved ${gatedToolName} call needs the approving actor's principal for RBAC — nothing ran.`,
            data: {},
          };
          break;
        }
        await grantApprovalIfHuman({
          db: p.db,
          tenant_id: p.tenant_id,
          conversation_id: p.conversation_id,
          approval_id: approvalId,
          tool: gatedToolName,
          actor: p.answer_actor,
        });
        const claim = await consumeApproval({
          db: p.db,
          principal: approver,
          approval_id: approvalId,
          tool: gatedToolName,
          surface: "chat",
          via: "chat",
        });
        if (!claim.ok) {
          result = { ok: false, error_code: claim.code, message: claim.message, data: {} };
          break;
        }
        if (gatedTool.permission) {
          const perm = await checkToolPermission(
            ctx,
            gatedTool.permission,
            claim.args,
            approvalAuditResource(claim),
          );
          if (!perm.allow) {
            result = gatedTool.permission.denyResult?.(perm.permission, perm.reason) ?? {
              ok: false,
              error_code: "permission_denied",
              message: perm.reason,
              data: { permission: perm.permission },
            };
            break;
          }
        }
        const recordedApproval = await recordApprovalApproved({
          db: p.db,
          principal: approver,
          claim,
          tool: gatedToolName,
          via: "chat",
        });
        if (!recordedApproval) {
          result = {
            ok: false,
            error_code: "approval_audit_failed",
            message: `Approval ${claim.approval_id} could not be recorded in the audit log; ${gatedToolName} did not run. Re-issue it to obtain a fresh confirmation.`,
            data: {},
          };
          break;
        }
        const replayArgs = await walkAndResolve(
          await resolveAttachmentSlugsInArgs(claim.args, {
            db: p.db,
            tenant_id: p.tenant_id,
            conversation_id: p.conversation_id,
            principal: approver,
          }),
          { db: p.db, tenant_id: p.tenant_id },
          new Map(),
        );
        result = await gatedTool.execute(
          {
            ...ctx,
            principal: approver,
            ...(claim.tool === "call_connector" || claim.tool === "probe_connector"
              ? {
                  direct_connector_approval: {
                    approval_id: claim.approval_id,
                    surface: claim.surface,
                    tool: claim.tool,
                    binding: claim.direct_connector ?? null,
                  },
                }
              : {}),
          },
          replayArgs,
        );
        break;
      }
      case "grant_relayed_tool_call": {
        const relayedTool = readString(intent.payload, "tool");
        const approvalId = readString(intent.payload, "approval_id");
        toolName = relayedTool ?? intentToolName(intent);
        if (!relayedTool || !approvalId) {
          result = {
            ok: false,
            error_code: "invalid_commit_intent",
            message:
              "grant_relayed_tool_call commit_intent is missing payload.tool or payload.approval_id — nothing was granted.",
            data: {},
          };
          break;
        }
        const relayGranted = await grantApprovalIfHuman({
          db: p.db,
          tenant_id: p.tenant_id,
          conversation_id: p.conversation_id,
          approval_id: approvalId,
          tool: relayedTool,
          actor: p.answer_actor,
        });
        result = relayGranted
          ? {
              ok: true,
              data: {
                status: "approved",
                granted: true,
                tool: relayedTool,
                note: `The operator approved ${relayedTool}. It has NOT run yet — the engine cannot perform an external MCP call for you. Re-issue ${relayedTool} with __policy_confirmed: true and __policy_confirm_id set to the confirm_id you were given; the engine replays the arguments it already holds.`,
              },
            }
          : {
              ok: false,
              error_code: "approval_not_granted",
              message: `${relayedTool} was not granted (the answer did not come from a person, or the approval expired). Nothing ran and nothing will — a person must approve it before ${relayedTool} can be re-issued.`,
              data: { status: "not_granted", granted: false, tool: relayedTool },
            };
        break;
      }
      case "create_api_key": {
        toolName = "create_api_key";
        result = await createApiKeyTool.execute(ctx, CreateApiKeyInput.parse(intent.payload));
        break;
      }
      case "update_workflow_metadata": {
        toolName = "update_workflow";
        result = await updateWorkflowTool.execute(ctx, UpdateWorkflowInput.parse(intent.payload));
        break;
      }
      case "oauth_completed":
      case "credential_reissue_completed": {
        const oauthFlow = intent.kind === "oauth_completed";
        toolName = oauthFlow ? "authenticate_oauth" : "request_connector_reauth";
        const connectorId =
          typeof intent.payload.connector_id === "string" ? intent.payload.connector_id : null;
        const connectorSlug =
          typeof intent.payload.connector_slug === "string" ? intent.payload.connector_slug : null;
        let blockedCallToRetry: { tool: string; input: unknown } | null = null;
        if (connectorId) {
          try {
            const recent = await p.db
              .select({
                tool: conversationToolCalls.tool,
                input: conversationToolCalls.input,
                output: conversationToolCalls.output,
              })
              .from(conversationToolCalls)
              .where(
                and(
                  eq(conversationToolCalls.tenant_id, p.tenant_id),
                  eq(conversationToolCalls.conversation_id, p.conversation_id),
                ),
              )
              .orderBy(desc(conversationToolCalls.created_at))
              .limit(25);
            const RETRYABLE_TOOLS = new Set([
              "call_connector",
              "dry_run_workflow",
              "run_workflow",
              "probe_connector",
              "test_connector",
            ]);
            for (const row of recent) {
              if (!RETRYABLE_TOOLS.has(row.tool)) continue;
              const inputObj =
                row.input && typeof row.input === "object"
                  ? (row.input as Record<string, unknown>)
                  : null;
              const sameConnector = inputObj?.connector_id === connectorId;
              const outputObj =
                row.output && typeof row.output === "object"
                  ? (row.output as Record<string, unknown>)
                  : null;
              const errorCode = outputObj?.error_code;
              const status = outputObj?.status;
              const isAuthFailure =
                (typeof errorCode === "string" &&
                  /^(?:auth_failed|credential_(?:missing|invalid|expired))$/.test(errorCode)) ||
                status === "auth_failed";
              if (sameConnector && isAuthFailure) {
                blockedCallToRetry = { tool: row.tool, input: row.input };
                break;
              }
            }
          } catch (err) {
            logger.warn({
              module: "auto-persist",
              action: "oauth_completed.blocked_call_lookup_failed",
              msg: "could not scan tool calls for blocked retry target; falling back to generic note",
              tenant_id: p.tenant_id,
              conversation_id: p.conversation_id,
              error: err instanceof Error ? err.message : String(err),
            });
          }
        }
        let credentialPresent = false;
        if (connectorId) {
          try {
            const conn = await getConnector(p.tenant_id, connectorId, p.db);
            const env: "dev" | "prod" = conn?.environment === "prod" ? "prod" : "dev";
            credentialPresent = Boolean(
              await getCredentialForConnector(p.tenant_id, connectorId, env, p.db),
            );
          } catch (err) {
            logger.warn({
              module: "auto-persist",
              action: "oauth_completed.credential_check_failed",
              msg: "could not verify oauth credential after confirmation; treating as not authenticated",
              tenant_id: p.tenant_id,
              conversation_id: p.conversation_id,
              connector_id: connectorId,
              error: err instanceof Error ? err.message : String(err),
            });
          }
        }
        result = credentialPresent
          ? {
              ok: true,
              data: {
                ...(oauthFlow ? { authenticated: true } : { reconnected: true }),
                ...(connectorId ? { connector_id: connectorId } : {}),
                ...(connectorSlug ? { connector_slug: connectorSlug } : {}),
                ...(blockedCallToRetry
                  ? {
                      blocked_call_to_retry: blockedCallToRetry,
                      note: `${oauthFlow ? "OAuth flow" : "Credential re-issue"} completed. The saved credential is now active. Retry the call that was blocked on this connector: ${blockedCallToRetry.tool}(...). The same input shape is in blocked_call_to_retry.input — re-issue verbatim.`,
                    }
                  : {
                      note: `${oauthFlow ? "OAuth flow" : "Credential re-issue"} completed. The saved credential is now active; retry the call_connector / dry_run_workflow / run_workflow that was blocked on this connector.`,
                    }),
              },
            }
          : {
              ok: false,
              error_code: oauthFlow ? "oauth_not_completed" : "credential_reissue_not_completed",
              message: oauthFlow
                ? "No OAuth credential was minted for this connector — the provider never completed the authorization callback, so the connector is NOT authenticated. Do NOT retry the connector or report success. Causes: the authorization URL was not actually completed in the browser, or the provider rejected it (the redirect URI is not registered in the provider app, or a requested scope is not approved). Have the operator open the authorization URL, finish the consent so the provider redirects back to the engine callback, THEN call authenticate_oauth again to resume waiting for the token."
                : "No replacement credential is stored for this connector. The credential-setup flow was not completed, so the connector is NOT reconnected. Do not retry the connector or report success; run request_connector_reauth again and complete the URL elicitation.",
              data: {
                ...(oauthFlow ? { authenticated: false } : { reconnected: false }),
                ...(connectorId ? { connector_id: connectorId } : {}),
                ...(connectorSlug ? { connector_slug: connectorSlug } : {}),
              },
              next_best_actions: [oauthFlow ? "authenticate_oauth" : "request_connector_reauth"],
            };
        break;
      }
    }
  } catch (err) {
    const msg = err instanceof Error ? err.message : String(err);
    const pgErr = err as { code?: unknown; constraint?: unknown; detail?: unknown } | null;
    logger.error({
      module: "auto-persist",
      action: "dispatch.threw",
      msg: "auto-persist dispatcher threw — surfacing structured error to the LLM",
      tenant_id: p.tenant_id,
      conversation_id: p.conversation_id,
      elicitation_id: p.elicitation.id,
      commit_intent_kind: intent.kind,
      pg_code: pgErr?.code ?? null,
      pg_constraint: pgErr?.constraint ?? null,
      pg_detail: pgErr?.detail ?? null,
      error: msg,
    });
    const translated = translateAutoPersistError(err, intent.kind);
    const synthetic: SyntheticToolResult = {
      tool: intentToolName(intent),
      ok: false,
      error_code: translated.error_code,
      message: translated.message,
      next_best_actions: translated.next_best_actions,
      source: "harness_auto_persist",
    };
    await recordGatedCallOutcome(p, "error");
    const callId = await injectSyntheticToolCall({
      db: p.db,
      tenant_id: p.tenant_id,
      conversation_id: p.conversation_id,
      synthetic,
      intent,
      decision: "confirmed",
    });
    return { dispatched: true, synthetic_result: synthetic, synthetic_tool_call_id: callId };
  }

  const prepared = isCompletedWorkflowPreparation(intent.kind, result.data);
  await auditAwait(
    {
      tenant_id: p.tenant_id,
      actor_type: p.actor_id ? "user" : "system",
      actor_id: p.actor_id,
      action:
        intent.kind === "run_workflow"
          ? AuditAction.CONVERSATION_RESUMED
          : AuditAction.APPROVAL_APPROVED,
      resource_type: "conversation_elicitation",
      resource_id: p.elicitation.id,
      result: result.ok || prepared ? "success" : "error",
      reason:
        intent.kind === "run_workflow"
          ? "workflow_input_submitted"
          : "auto_persist_on_confirmation",
      metadata: {
        commit_intent_kind: intent.kind,
        tool: toolName,
        ok: result.ok,
        ...(result.pause ? { follow_up_elicitation_id: result.pause.elicitation_id } : {}),
        ...(prepared ? { preparation: true } : {}),
        conversation_id: p.conversation_id,
        ...(result.ok || prepared ? {} : { error_code: result.error_code ?? null }),
      },
    },
    p.db,
  );

  const synthetic = buildSyntheticFromResult(toolName, result);
  await recordGatedCallOutcome(p, result.ok || prepared ? "ok" : "error");
  const callId = await injectSyntheticToolCall({
    db: p.db,
    tenant_id: p.tenant_id,
    conversation_id: p.conversation_id,
    synthetic,
    intent,
    decision: "confirmed",
  });
  if (result.pause) {
    await p.db
      .update(conversationElicitations)
      .set({ tool_call_id: callId })
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
  return { dispatched: true, synthetic_result: synthetic, synthetic_tool_call_id: callId };
}
