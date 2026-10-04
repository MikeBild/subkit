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

import { and, desc, eq, isNull } from "drizzle-orm";
import { auditAwait } from "../../audit/audit.ts";
import { AuditAction } from "../../audit/types.ts";
import type { ResolvedPrincipal } from "../../auth/types.ts";
import { getConnector } from "../../connectors/service.ts";
import { getCredentialForConnector } from "../../credentials/service.ts";
import type { Db } from "../../db/client.ts";
import {
  conversationElicitations,
  conversations,
  conversationToolCalls,
} from "../../db/schema/index.ts";
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
  /** Resolved principal of the actor who answered — required for the
   *  `run_workflow` intent's RBAC gate. Absent on legacy callers. */
  principal?: ResolvedPrincipal | null;
  /**
   * WHO answered. The `human` variant is the only thing that can grant the
   * approval an engine-authored `commit_intent` names; a `relay` answer grants
   * nothing, and the claim then refuses with `approval_not_granted`. See
   * `conversations/answer-actor.ts`.
   */
  answer_actor: AnswerActor;
  /** The carrier elicitation's `output` after `resolveElicitation`. */
  elicitation_output: unknown;
  /** The persisted carrier — read from `conversation_elicitations`. */
  elicitation: {
    id: string;
    tool_name: string;
    input: unknown;
  };
  /**
   * Surface the RESUME runs on. On `"chat"` (external chat channels —
   * read-only contract) every mutating commit_intent is refused with an
   * honest synthetic result; only the two run intents (`run_workflow`,
   * `commit_held_workflow_writes`) dispatch. Without this gate the
   * harness-side auto-persist would execute writes the chat palette
   * structurally removed from the model.
   */
  surface?: "sk_headless" | "sk_interactive" | "mcp" | "web" | "chat";
  db: Db;
}

/** The only commit_intents an external chat channel may dispatch: running a
 *  saved workflow, and releasing the writes a `wf_<slug>` preview held. Every
 *  other kind mutates tenant state the read-only chat palette withholds. */
const CHAT_DISPATCHABLE_INTENTS: ReadonlySet<CommitIntentKind> = new Set([
  "run_workflow",
  "commit_held_workflow_writes",
]);

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

/**
 * Apply a PERSON's yes to the approval this elicitation carries, before anything
 * claims it. `consumeApproval` requires `granted_at IS NOT NULL`; this is the
 * only thing on the chat surface that sets it.
 *
 * A `relay` answer grants nothing and is not refused here. The claim is the
 * gate: `consumeApproval` requires a granted row, so a relayed "yes" answers
 * `approval_not_granted` and nothing runs. Leaving the refusal to the claim
 * keeps ONE denial vocabulary, produced in one place, for every surface.
 *
 * A grant that names a real approval it can no longer decide on (declined,
 * expired, already spent) is likewise left to the claim: `grantApproval` has
 * already written the APPROVAL_GRANTED/denied row, and `consumeApproval`
 * classifies the same row into the code the caller reports.
 */
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
  // Already granted is the DESIRED state, not a miss. The approval portal grants
  // inside the human's own decision request and only then enqueues the resume,
  // so by the time this runs the row is legitimately granted already.
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

/**
 * A PERSON's no, applied to the approval this elicitation carries. Terminal:
 * the row can never be granted afterwards, so the model cannot re-ask it.
 *
 * A relay's "no" declines nothing. Declining is safe in itself, but it would
 * put a refusal a machine invented into a human's mouth AND destroy a pending
 * decision a person may still be looking at. The approval simply ages out.
 */
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
    // The operator said no to a write the engine is holding. Kill the handle
    // first — an APPROVAL_DECLINED row is the audit trail's record of the
    // refusal, and a declined approval can never be claimed afterwards.
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
    });
    return { dispatched: true, synthetic_result: synthetic, synthetic_tool_call_id: callId };
  }

  // Read-only chat channel: the palette structurally removes every
  // authoring/mutating tool, and this harness-side dispatcher must not
  // become the bypass — a commit_intent that reaches a chat resume
  // (e.g. staged before the conversation ever reached chat, or a
  // mis-tagged confirm) would otherwise write at full harness
  // authority. Running a saved workflow is the channel's one action, so
  // the two run intents stay dispatchable — both carry their own RBAC
  // gate (`gateWorkflowRunRbac`) in the cases below.
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
    // Threaded so a harness-dispatched tool sees the SAME principal the chat
    // wrapper would have handed it (`run_workflow` refuses without one).
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
        // Supplying workflow input is not an execution approval. Even an
        // execute_writes flag in the form intent must use existing local
        // authority; without one the materialized writes stay durably held.
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
        await p.db
          .update(conversations)
          .set({ target_workflow_id: workflowId, updated_at: new Date() })
          .where(
            and(eq(conversations.tenant_id, p.tenant_id), eq(conversations.id, p.conversation_id)),
          );
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
        // A PERSON approved the held writes of a `wf_<slug>` chat preview. The
        // HARNESS performs them: it grants the approval on their behalf, claims
        // the single-use handle the preview minted, and replays the encrypted
        // inputs. A decline never reaches here — `checkDecline` returned above.
        //
        // WHAT RUNS IS WHAT THE APPROVAL NAMES. The claim's `tool` is a CAS
        // predicate — `wf_<slug>` for the workflow the operator previewed — and
        // the slug is read back off the claimed row, exactly as MCP reads it off
        // the `tools/call` name. Nothing in the intent payload selects a target:
        // an approval granted for a harmless preview must not be spendable on a
        // different workflow, and validating an attacker-controlled target field
        // against the approval is not the same as deriving it from one.
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
        // The person answering IS the approver. Grant before claiming —
        // `consumeApproval` refuses an ungranted row by construction, so this
        // is not bookkeeping, it is what makes the replay possible.
        await grantApprovalIfHuman({
          db: p.db,
          tenant_id: p.tenant_id,
          conversation_id: p.conversation_id,
          approval_id: approvalId,
          tool: toolName,
          actor: p.answer_actor,
        });
        // Burn the handle first: a denial after this point must not be
        // replayable, and the claim carries the args the operator approved.
        const claim = await consumeApproval({
          db: p.db,
          principal: p.principal,
          approval_id: approvalId,
          tool: toolName,
          surface: "chat",
          via: "chat",
          // No ambient environment: the persisted human-reviewed approval selects it.
        });
        if (!claim.ok) {
          result = { ok: false, error_code: claim.code, message: claim.message, data: {} };
          break;
        }
        // The approval's own tool name is the execution target.
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
          // The handle is spent and nothing ran: the workflow was renamed or
          // deleted between the preview and the approval (or the approval was
          // never granted for a saved-workflow tool at all). The audit trail
          // must record that outcome, not stop at APPROVAL_REQUESTED.
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
        // A grant can be revoked between the preview and the approval.
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
        // The writes are about to leave the perimeter. An approved external
        // write that never reached the audit log is the governance gap the log
        // exists to close — refuse rather than run unrecorded.
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
            // Replay the approved environment, even if the schedule changed since preparation.
            execution_mode: claim.execution_mode ?? "dev",
            self_healing: { enabled: false },
            tool_approval_id: claim.approval_id,
          },
        });
        await p.db
          .update(conversations)
          .set({ target_workflow_id: workflowId, updated_at: new Date() })
          .where(
            and(eq(conversations.tenant_id, p.tenant_id), eq(conversations.id, p.conversation_id)),
          );
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
        // A PERSON approved a policy-gated chat tool call. The HARNESS runs it:
        // it grants the approval on their behalf, claims the single-use handle
        // the gate minted, and replays the args it encrypted then. The model
        // never held the approval id, no wrapped tool publishes a confirm
        // marker, and a relayed answer grants nothing — so a person's answer is
        // the only thing that releases the call. A decline never reaches here;
        // `checkDecline` returned above.
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
        // Resolved in the SAME order the gate used, so the id the approval was
        // bound to is the id we claim it with (`sdk-wrap/invoke.ts`).
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
        // The person answering IS the approver — the same grant a portal click
        // makes, through the channel they actually used.
        await grantApprovalIfHuman({
          db: p.db,
          tenant_id: p.tenant_id,
          conversation_id: p.conversation_id,
          approval_id: approvalId,
          tool: gatedToolName,
          actor: p.answer_actor,
        });
        // Burn the handle first: a denial after this point must not be
        // replayable, and the claim carries the args the operator approved.
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
        // A grant can be revoked between the gate and the approval. Same
        // declarative descriptor `wrapOne` enforces, on the replayed args. The
        // handle is already burned, so the deny row anchors on the approval —
        // its terminal outcome, not a free-standing tool denial.
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
        // The write is about to happen. An approved write that never reached the
        // audit log is the governance gap the log exists to close.
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
        // `{$file: …}` refs survive the encrypted round-trip as refs; resolve
        // them here exactly as the chat wrapper does before `execute`.
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
        // A PERSON approved a policy-gated EXTERNAL MCP tool call. The harness
        // CANNOT perform it: a remote MCP invocation must be re-issued by the
        // MODEL and run in-engine (`executeExternalMcpTool` →
        // `pool.invokeRemoteTool`), not from a harness resume. So this carrier
        // GRANTS ONLY — it flips `granted_at` on the approval the external-MCP
        // gate minted and STOPS. There is no `consumeApproval`, no execution
        // here: the model's separate re-issue (carrying `__policy_confirm_id`)
        // claims the now-granted row and performs the call. A decline never
        // reaches here — `checkDecline` returned above and
        // `declineApprovalIfHuman` already killed the handle, so the re-issue
        // then refuses. A relayed (non-human) answer grants nothing, and the
        // re-issue's claim answers `approval_not_granted`.
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
        // The person answering IS the approver — the same grant a portal click
        // makes, through the channel they actually used. Grant only; the CAS in
        // `consumeApproval` (which the model's re-issue drives) still requires a
        // granted row, so this is what makes the re-issue able to proceed.
        const relayGranted = await grantApprovalIfHuman({
          db: p.db,
          tenant_id: p.tenant_id,
          conversation_id: p.conversation_id,
          approval_id: approvalId,
          tool: relayedTool,
          actor: p.answer_actor,
        });
        // Report the outcome that actually happened — never a blanket
        // `granted:true`. A relay (non-human) answer or a missed/expired grant
        // leaves the row ungranted; telling the model "approved, re-issue" would
        // send it straight into `approval_not_granted` and leave an auditor a
        // `granted:true` synthetic with no APPROVAL_GRANTED row behind it.
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
        // This is the tool's Zod boundary on this path: `intent.payload` is an
        // LLM-authored commit_intent, and `execute` no longer parses.
        toolName = "create_api_key";
        result = await createApiKeyTool.execute(ctx, CreateApiKeyInput.parse(intent.payload));
        break;
      }
      case "update_workflow_metadata": {
        // Metadata-only workflow edit. Reuse the update_workflow tool so the
        // approval auto-persists the patch directly (RBAC, Postgres-error
        // translation, and conversation rebind come for free) — the model does
        // NOT re-issue update_workflow itself. updateWorkflowMetadata writes the
        // column without rolling a version, so a description edit needs no
        // dry_run/preview.
        // Zod boundary for this path — see the create_api_key case above.
        toolName = "update_workflow";
        result = await updateWorkflowTool.execute(ctx, UpdateWorkflowInput.parse(intent.payload));
        break;
      }
      case "oauth_completed":
      case "credential_reissue_completed": {
        // G8 / H2 (runtime-logs review plan): the OAuth flow's
        // "Have you completed the authorization in your browser?"
        // elicitation carries this commit_intent. When the operator
        // confirms, the dispatcher injects a synthetic tool result
        // naming the saved credential AND — H2 enrichment — the
        // exact tool call that was blocked on the missing credential,
        // so the LLM has a deterministic next step instead of having
        // to scan chat history to figure out what to retry.
        const oauthFlow = intent.kind === "oauth_completed";
        toolName = oauthFlow ? "authenticate_oauth" : "request_connector_reauth";
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
    // pg errors carry .code / .constraint / .detail — untyped on the thrown value.
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
    // Translate Postgres errors into actionable error_codes so the
    // LLM has a concrete recovery path instead of throwing
    // `cannot_help` and dead-ending the chat (session abeefb33: a
    // 23505 unique_violation on `connectors_tenant_slug_env_key`
    // surfaced as "database error" → cannot_help → conversation
    // ended on a colon with no question for the user).
    const translated = translateAutoPersistError(err, intent.kind);
    const synthetic: SyntheticToolResult = {
      tool: intentToolName(intent),
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
  const callId = await injectSyntheticToolCall({
    db: p.db,
    tenant_id: p.tenant_id,
    conversation_id: p.conversation_id,
    synthetic,
    intent,
  });
  // A confirmed tool can itself ask the person to sign in. Attach that next
  // dialog to the persisted synthetic invocation so reloads can render it.
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
