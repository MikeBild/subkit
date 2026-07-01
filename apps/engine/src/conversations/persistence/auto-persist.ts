// Harness-side auto-persist dispatcher.
//
// When an `ask_user_form` or `ask_user_confirm` carries a
// `commit_intent`, the harness applies the proposed write atomically
// once the operator submits. The LLM does NOT need to call the
// underlying tool (save_connector_draft / save_workflow_draft / delete_*)
// afterwards — the synthetic tool result the harness injects has
// `source: "harness_auto_persist"`, so the LLM's next turn sees the
// persistence as a normal tool-result message.
//
// Contract:
//   - This module owns the dispatch decision: which kind to run,
//     how the form values map onto the underlying call, and what the
//     synthetic tool result looks like.
//   - Atomicity lives in the underlying helpers
//     (`saveConnectorAtomic`, `commitWorkflowAtomic`, `deleteConnector`,
//     `deleteWorkflow`). This module is the orchestrator.
//   - Audit lives in two places:
//       1. The underlying helper writes its existing audit row
//          (e.g. `connector.created`) — that row stays untouched.
//       2. THIS module writes a second audit row tagged
//          `actor: <operator>, reason: auto_persist_on_confirmation,
//          commit_intent_kind: <kind>` so operators can distinguish a
//          harness-issued save from an LLM-issued one. (The atomic
//          helpers also emit a `source: "harness_auto_persist"` audit
//          when `emitAutoPersistAudit: true` is passed — together that
//          gives a full trail.)
//
// The implementation lives in `auto-persist/`:
//
//   - `auto-persist/synthetic.ts`         — synthetic tool-result
//                                            shapes + commit-intent
//                                            extraction + decline
//                                            detection + row injection
//   - `auto-persist/error-translation.ts` — translateAutoPersistError
//                                            (Postgres SQLSTATE → LLM
//                                            envelope)
//   - `auto-persist/credential-cache.ts`  — form-output → credential
//                                            extraction +
//                                            maybeCacheDraftCredentialFromElicitation
//   - `auto-persist/dispatch.ts`          — per-kind dispatchers
//                                            (delete_*, rollback,
//                                            auto-freshen / auto-probe)
//   - `auto-persist/helpers.ts`           — readString / readEnvironment
//
// External callers continue to import `maybeAutoPersistFromElicitation`,
// `extractCredentialFromFormOutput`, `maybeCacheDraftCredentialFromElicitation`,
// `translateAutoPersistError`, `ErrorTranslationContext`, and
// `SyntheticToolResult` from this barrel.

import { and, desc, eq } from "drizzle-orm";
import { auditAwait } from "../../audit/audit.ts";
import { AuditAction } from "../../audit/types.ts";
import type { ResolvedPrincipal } from "../../auth/types.ts";
import { getConnector } from "../../connectors/service.ts";
import { getCredentialForConnector } from "../../credentials/service.ts";
import type { Db } from "../../db/client.ts";
import { conversations, conversationToolCalls } from "../../db/schema/index.ts";
import { EngineClient } from "../../engine-client/index.ts";
import { runExecution } from "../../execution/engine.ts";
import { logger } from "../../logging/logger.ts";
import { resolveWorkflowInputContract } from "../../workflows/input-schema-synth.ts";
import { resolveWorkflowByIdOrSlug } from "../../workflows/lookup.ts";
import { gateWorkflowRunRbac } from "../../workflows/rbac.ts";
import type { WorkflowDef } from "../../workflows/types.ts";
import { appendSnapshot, loadDraft } from "../draft.ts";
import { partitionDiffs, type ToolDiff } from "../json-patch-apply.ts";
import { describePatchOps } from "../tools/ask-user/commit-intent.ts";
import { interpretConfirmDecision } from "../tools/ask-user/interpret-confirm.ts";
import { applyWorkflowPatchToDraft } from "../tools/edit-workflow-patch.ts";
import { createApiKeyTool } from "../tools/generated/writes/create-api-key.ts";
import { updateWorkflowTool } from "../tools/generated/writes/update-workflow.ts";
import type { ToolContext, ToolResult } from "../tools/index.ts";
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
  /** Resolved principal of the actor who answered — required for the
   *  `run_workflow` intent's RBAC gate. Absent on legacy callers. */
  principal?: ResolvedPrincipal | null;
  /** The carrier elicitation's `output` after `resolveElicitation`. */
  elicitation_output: unknown;
  /** The persisted carrier — read from `conversation_elicitations`. */
  elicitation: {
    id: string;
    tool_name: string;
    input: unknown;
  };
  db: Db;
}

export interface AutoPersistDispatch {
  /** True if a `commit_intent` was found and dispatched. */
  dispatched: boolean;
  /** When dispatched, the synthetic tool result we injected. */
  synthetic_result?: SyntheticToolResult;
  /** When dispatched, the conversation_tool_calls row id we wrote. */
  synthetic_tool_call_id?: string;
}

/**
 * Inspect a resumed elicitation; if the carrier `input.commit_intent`
 * is set, dispatch the corresponding internal write, audit it, and
 * inject a synthetic tool-call row + tool-result row + tool message
 * into the conversation timeline. Returns `{dispatched: false}` when
 * there is no commit_intent, or when the operator declined / submitted
 * an empty form (we still inject a synthetic decline result so the
 * LLM's next turn carries the signal).
 */
/** Read the submitted {name: value} map from an ask_user_form answer.
 *  The portal sends `{ values: {...} }`; the MCP bridge resolves the
 *  flat map. */
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

/**
 * Read the operator's per-op selection from a `partial_diff_approval`
 * confirm answer (D3). Returns:
 *   - `null`   → no explicit selection on this surface (accept-all). The
 *                MCP-native boolean-confirm bridge cannot express a subset,
 *                so a bare `confirmed: true` accepts every op.
 *   - `[...]`  → the accepted op indices, de-duped, in-range, sorted. An
 *                explicit empty array means "none accepted" (honest no-op).
 */
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

export async function maybeAutoPersistFromElicitation(
  p: AutoPersistInput,
): Promise<AutoPersistDispatch> {
  const intent = extractCommitIntent(p.elicitation.input);
  if (!intent) {
    // Forensic log: the elicitation resolved but carried no
    // commit_intent so the harness has nothing to dispatch. Pre-fix
    // this branch was completely silent — operators triaging "I
    // approved but nothing got saved" had to grep for the absence
    // of a workflow.created row to even notice the harness no-op.
    // We surface the elicitation kind so the next investigation can
    // immediately tell whether the LLM forgot to attach commit_intent
    // (kind=external_write/generic) or whether we were called with
    // an unrelated elicitation type (kind=ask_user_text/etc).
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

    // Honest-failure signal. An `ask_user_confirm` whose `kind` declares a
    // WRITE (external_write / save_workflow_draft) that the operator
    // APPROVED, yet carries no commit_intent the harness can dispatch, is
    // the "reported ≠ written" trap: the harness writes nothing, and pre-
    // fix the LLM got no signal back, so it narrated success it never
    // achieved (render-upload-slides session: the model tagged a
    // description-edit confirm `kind:external_write` after drifting, the
    // approval no-op'd, and the description stayed unchanged while chat
    // claimed it was updated). The drift itself is fixed by the
    // DATA-NOT-INSTRUCTIONS rule; this is the durable safety net for any
    // future mis-tagged write-confirm. Inject a synthetic tool result so
    // the model's next turn MUST acknowledge nothing was written and
    // either attach a commit_intent or call the real write tool. Plain
    // `generic` confirms (yes/no questions) and declined/ambiguous
    // answers keep the silent skip — only an approved write-shaped confirm
    // is a write the operator expected to happen.
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
      });
      return { dispatched: true, synthetic_result: synthetic, synthetic_tool_call_id: callId };
    }
    return { dispatched: false };
  }

  const declineCheck = checkDecline(p.elicitation.tool_name, p.elicitation_output);
  if (declineCheck) {
    const synthetic = buildDeclineSynthetic(intent, declineCheck);
    const callId = await injectSyntheticToolCall({
      db: p.db,
      tenant_id: p.tenant_id,
      conversation_id: p.conversation_id,
      synthetic,
      intent,
    });
    return { dispatched: true, synthetic_result: synthetic, synthetic_tool_call_id: callId };
  }

  // Build a tool context the underlying atomic helpers can use.
  const draft = await loadDraft(p.tenant_id, p.conversation_id, p.db);
  let liveDraft = draft;
  const ctx: ToolContext = {
    db: p.db,
    tenant_id: p.tenant_id,
    conversation_id: p.conversation_id,
    actor_id: p.actor_id,
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
        // Probe-then-save: when the connector hasn't been probed yet
        // and its template declares a probe_endpoint, run the probe
        // before the save so the form-submit acts as one transactional
        // approval. Without this the save bounces off the probe gate
        // (`save-connector.ts:probeFailed`) and the LLM has to retry
        // through a second `ask_user_confirm`. The credential cache
        // was populated by `maybeCacheDraftCredentialFromElicitation`
        // before this dispatcher ran, so the probe sees auth.
        await maybeAutoProbeForSave(ctx, p.tenant_id);
        await maybeAutoFreshenCheckpointsForSave(ctx);
        // Honour `force_save` from the commit_intent payload so a single
        // operator confirmation overrides the failed-probe / cooldown
        // gates symmetric to `save_workflow_draft.force_commit`. Without
        // this, the LLM had to bounce through a second `save_connector_draft`
        // tool call — the "approve twice" symptom on the connector path.
        const forceSave = intent.payload.force_save === true;
        // This dispatcher only runs on a RESOLVED, non-declined
        // elicitation (checkDecline returned above), so a force_save
        // here carries an explicit operator approval — it bypasses the
        // fresh-probe cooldown that gates the bare LLM tool path.
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
        // The LLM declares force_commit in the commit_intent payload
        // when proposing to commit despite a failed preview. Honour it
        // here so a single operator confirmation suffices — without
        // this, the preview gate in commitWorkflowAtomic blocks the
        // auto-persist and the LLM has to retry through a separate
        // save_workflow_draft call (the "approve twice" symptom).
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
        // D3 — partial-accept of a workflow-draft edit. The commit_intent
        // carries the full RFC-6902 patch array; the operator's per-op
        // selection rides on `output.approved_indices`. Apply ONLY the
        // accepted subset to the draft (via the SAME apply core the
        // edit_workflow_patch tool uses, so every gate is identical), then
        // report exactly which ops landed vs were skipped. The draft was
        // never mutated before this point, so a decline (caught by
        // checkDecline above) is a true no-op — nothing to roll back.
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
          // The partial card sends `confirmed: false` when nothing is
          // accepted (a decline, already handled by checkDecline). Reaching
          // here means an explicit empty selection slipped through — honest
          // no-op, NEVER a silent apply-all.
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
        // run_workflow's missing-input auto-form: merge the submitted
        // values over input_partial and execute directly — the LLM is
        // NOT trusted to re-issue the call with the answers (observed
        // live on 6.14.1: it re-called with empty input and looped).
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
        // Missing-required guard. Resolve the workflow's effective input
        // contract (declared input_schema OR the schema synthesized from
        // `${input.*}` placeholders) and, when the merged form input is
        // still missing a REQUIRED field, return a DIRECTIVE error naming
        // the unbound fields + how to supply them — instead of letting the
        // driver throw the opaque `input_schema_violation` at runtime (the
        // `dispatch.threw` symptom: a {markdown, filename} workflow whose
        // form collected only one field reached the driver and failed with
        // "required field '<k>' is missing"). Only checked for the
        // field-merge path (object input); a raw scalar/array passthrough
        // is dispatched verbatim.
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
        const executeWrites = intent.payload.execute_writes === true;
        const run = await runExecution({
          db: p.db,
          tenant_id: p.tenant_id,
          source: { kind: "saved", workflow_id: workflowId },
          input,
          options: {
            request_source: "chat",
            trace_id: null,
            principal: p.principal,
            execution_mode: environment,
            ...(executeWrites ? {} : { hold_writes: true }),
          },
        });
        await p.db
          .update(conversations)
          .set({ target_workflow_id: workflowId, updated_at: new Date() })
          .where(eq(conversations.id, p.conversation_id));
        result = {
          ok: run.status === "succeeded",
          data: {
            status: run.status,
            execution_id: run.execution_id,
            workflow_id: workflowId,
            workflow_slug: workflowSlug,
            input,
            output: run.output,
            execute_writes: executeWrites,
            ...(run.warnings && run.warnings.length > 0 ? { warnings: run.warnings } : {}),
          },
        };
        break;
      }
      case "create_api_key": {
        toolName = "create_api_key";
        result = await createApiKeyTool.execute(ctx, intent.payload);
        break;
      }
      case "update_workflow_metadata": {
        // Metadata-only workflow edit. Reuse the update_workflow tool so the
        // approval auto-persists the patch directly (RBAC, Postgres-error
        // translation, and conversation rebind come for free) — the model does
        // NOT re-issue update_workflow itself. updateWorkflowMetadata writes the
        // column without rolling a version, so a description edit needs no
        // dry_run/preview.
        toolName = "update_workflow";
        result = await updateWorkflowTool.execute(ctx, intent.payload);
        break;
      }
      case "oauth_completed": {
        // G8 / H2 (runtime-logs review plan): the OAuth flow's
        // "Have you completed the authorization in your browser?"
        // elicitation carries this commit_intent. When the operator
        // confirms, the dispatcher injects a synthetic tool result
        // naming the saved credential AND — H2 enrichment — the
        // exact tool call that was blocked on the missing credential,
        // so the LLM has a deterministic next step instead of having
        // to scan chat history to figure out what to retry.
        toolName = "authenticate_oauth";
        const connectorId =
          typeof intent.payload.connector_id === "string" ? intent.payload.connector_id : null;
        const connectorSlug =
          typeof intent.payload.connector_slug === "string" ? intent.payload.connector_slug : null;
        // H2: find the most recent tool call in this conversation
        // that targeted this connector AND returned an auth-failed
        // envelope. Best-effort: a DB blip or no match returns no
        // `blocked_call_to_retry` field; the existing free-text note
        // remains the fallback. We scan only the recent 25 rows to
        // bound query cost and to avoid pulling in a stale failure
        // from much earlier in the conversation.
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
              // Auth-failure signals we accept as "this call was
              // blocked on the OAuth credential":
              //   - structured error_code mentions auth/credential
              //   - the result envelope status === "auth_failed"
              //     (run_workflow / dry_run_workflow surface this)
              //   - HTTP 401 surfaced via the typed G10 enum
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
        // Verify a credential ACTUALLY landed before telling the LLM the
        // connector is authenticated. The operator confirming "I finished
        // authorizing" does NOT mean the provider called back: if the
        // browser consent was abandoned, or the provider rejected at its
        // consent screen (redirect_uri not allowlisted / scope not
        // approved), no token was minted and there is no credential row.
        // Pre-fix this path optimistically reported `authenticated: true`,
        // so the LLM immediately retried the connector and hit an auth
        // failure — and the operator was told the credential was "active"
        // when it never existed (LinkedIn session d462743a: zero
        // oauth.callback hits, zero credential.created, yet the flow
        // reported success). getCredentialForConnector returns null when
        // no primary credential exists (the oauth2_client identity slot is
        // excluded), which is exactly the pre-token state.
        let oauthCredentialPresent = false;
        if (connectorId) {
          try {
            const conn = await getConnector(p.tenant_id, connectorId, p.db);
            const env: "dev" | "prod" = conn?.environment === "prod" ? "prod" : "dev";
            oauthCredentialPresent = Boolean(
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
        result = oauthCredentialPresent
          ? {
              ok: true,
              data: {
                authenticated: true,
                ...(connectorId ? { connector_id: connectorId } : {}),
                ...(connectorSlug ? { connector_slug: connectorSlug } : {}),
                ...(blockedCallToRetry
                  ? {
                      blocked_call_to_retry: blockedCallToRetry,
                      note: `OAuth flow completed. The saved credential is now active. Retry the call that was blocked on this connector: ${blockedCallToRetry.tool}(...). The same input shape is in blocked_call_to_retry.input — re-issue verbatim.`,
                    }
                  : {
                      note: "OAuth flow completed. The saved credential is now active; retry the call_connector / dry_run_workflow / run_workflow that was blocked on this connector.",
                    }),
              },
            }
          : {
              ok: false,
              error_code: "oauth_not_completed",
              message:
                "No OAuth credential was minted for this connector — the provider never completed the authorization callback, so the connector is NOT authenticated. Do NOT retry the connector or report success. Causes: the authorization URL was not actually completed in the browser, or the provider rejected it (the redirect URI is not registered in the provider app, or a requested scope is not approved). Have the operator open the authorization URL, finish the consent so the provider redirects back to the engine callback, THEN call authenticate_oauth again to resume waiting for the token.",
              data: {
                authenticated: false,
                ...(connectorId ? { connector_id: connectorId } : {}),
                ...(connectorSlug ? { connector_slug: connectorSlug } : {}),
              },
              next_best_actions: ["authenticate_oauth"],
            };
        break;
      }
    }
  } catch (err) {
    const msg = err instanceof Error ? err.message : String(err);
    // biome-ignore lint/suspicious/noExplicitAny: pg errors carry .code / .constraint
    const pgErr = err as any;
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
    // Translate Postgres errors into actionable error_codes so the
    // LLM has a concrete recovery path instead of throwing
    // `cannot_help` and dead-ending the chat (session abeefb33: a
    // 23505 unique_violation on `connectors_tenant_slug_env_key`
    // surfaced as "database error" → cannot_help → conversation
    // ended on a colon with no question for the user).
    const translated = translateAutoPersistError(err, intent.kind);
    const synthetic: SyntheticToolResult = {
      tool: intentToolName(intent.kind),
      ok: false,
      error_code: translated.error_code,
      message: translated.message,
      next_best_actions: translated.next_best_actions,
      source: "harness_auto_persist",
    };
    const callId = await injectSyntheticToolCall({
      db: p.db,
      tenant_id: p.tenant_id,
      conversation_id: p.conversation_id,
      synthetic,
      intent,
    });
    return { dispatched: true, synthetic_result: synthetic, synthetic_tool_call_id: callId };
  }

  // Audit the write itself. The atomic helper already wrote the
  // canonical resource audit row (e.g. `connector.created`); this
  // second row tags the dispatch path so operators can filter on
  // `reason: auto_persist_on_confirmation`.
  //
  // `result: "error"` for non-ok outcomes — the operator approved the
  // form, the dispatcher refused (e.g. credential gate, probe gate).
  // Using `"denied"` here would conflate dispatcher failures with
  // operator declines (the genuine `"denied"` path lives in
  // buildDeclineSynthetic / approval.declined).
  await auditAwait(
    {
      tenant_id: p.tenant_id,
      actor_type: p.actor_id ? "user" : "system",
      actor_id: p.actor_id,
      action: AuditAction.APPROVAL_APPROVED,
      resource_type: "conversation_elicitation",
      resource_id: p.elicitation.id,
      result: result.ok ? "success" : "error",
      reason: "auto_persist_on_confirmation",
      metadata: {
        commit_intent_kind: intent.kind,
        tool: toolName,
        ok: result.ok,
        conversation_id: p.conversation_id,
        ...(result.ok ? {} : { error_code: result.error_code ?? null }),
      },
    },
    p.db,
  );

  const synthetic = buildSyntheticFromResult(toolName, result);
  const callId = await injectSyntheticToolCall({
    db: p.db,
    tenant_id: p.tenant_id,
    conversation_id: p.conversation_id,
    synthetic,
    intent,
  });
  return { dispatched: true, synthetic_result: synthetic, synthetic_tool_call_id: callId };
}
