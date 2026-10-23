import { logger } from "../../logging/logger.ts";
import { detectPlaceholderDestinations } from "../../workflows/destination-placeholders.ts";
import {
  WORKFLOW_DEF_FIELD_KEYS,
  type WorkflowDef,
  WorkflowDefSchema,
} from "../../workflows/types.ts";
import { getWorkflowDraft } from "../authoring-state.ts";
import { turnExecutionSuppression } from "../execution-suppression.ts";
import { type SaveVerificationEvidence, saveVerificationEvidence } from "../handoff-summary.ts";
import { buildGateError, missingFreshCheckpoints } from "../tools/authoring-contract.ts";
import type { ToolContext, ToolResult } from "../tools/index.ts";
import { placeholderDestinationGateResult } from "../tools/placeholder-destination-gate.ts";
import {
  SCHEMA_ONLY_NOTE,
  SENSITIVE_LIVE_VERIFICATION_HANDOFF,
} from "../tools/sensitive-envelope.ts";
import type { DraftDocument, WorkflowDraftDocument } from "../types.ts";
import { persistAuthoringWorkflowDraft } from "./persist-authoring-workflow-draft.ts";
import { classifyPreviewFailure } from "./preview-failure-class.ts";
import { findPriorSaveWorkflowApproval } from "./save-workflow-approval.ts";

export type WorkflowDefFromDraft = Partial<Omit<WorkflowDef, "name" | "steps">> & {
  name: string;
  steps: Array<Record<string, unknown>>;
  edges?: Array<{ from: string; to: string }>;
};

const PROJECTED_OPTIONAL_FIELDS: readonly string[] = [
  ...WORKFLOW_DEF_FIELD_KEYS.filter((k) => k !== "name" && k !== "steps"),
  "edges",
];

function isMeaningfulDraftValue(v: unknown): boolean {
  return v !== undefined && v !== null && v !== "";
}

export function workflowDefFromDraft(draft: WorkflowDraftDocument): WorkflowDefFromDraft {
  const src = draft as unknown as Record<string, unknown>;
  const out: Record<string, unknown> = {
    name: draft.name,
    steps: draft.steps,
  };
  for (const key of PROJECTED_OPTIONAL_FIELDS) {
    const value = src[key];
    if (key === "derived_from_skill_id") {
      if (value !== undefined) out[key] = value;
    } else if (isMeaningfulDraftValue(value)) {
      out[key] = value;
    }
  }
  return out as WorkflowDefFromDraft;
}

export type ScopeIndex = Record<
  string,
  { available_paths: string[]; shape_summary: string; primary_data_path: string | null }
>;

export interface CommitWorkflowAtomicParams {
  ctx: ToolContext;
  target_workflow_id?: string | undefined;
  skipPriorApprovalCheck?: boolean;
  forceCommit?: boolean;
  reason?: string;
  emitAutoPersistAudit?: boolean;
  commitIntentKind?: string;
  extraAuditMetadata?: Record<string, unknown>;
}

type CommitGate = { name: string; run: () => Promise<ToolResult | null> };

export function commitGateBypassedByAutoMode(p: {
  skipPriorApprovalCheck?: boolean | undefined;
  permission_mode?: string | null | undefined;
}): boolean {
  return !p.skipPriorApprovalCheck && p.permission_mode === "auto";
}

type SaveGauntletMode = "commit" | "proposal";

interface SaveGauntletFacts {
  fullDraft: DraftDocument;
  sensitiveDraft: boolean;
  forceClearsPreview: boolean;
  runtimeDataFailure: boolean;
  previewFailureClass: ReturnType<typeof classifyPreviewFailure> | null;
  verification: SaveVerificationEvidence;
}

type SaveGauntletOutcome =
  | { blocked: ToolResult; facts: null }
  | { blocked: null; facts: SaveGauntletFacts };

export async function previewsForbiddenByUser(ctx: ToolContext): Promise<boolean> {
  const suppression = await turnExecutionSuppression({
    db: ctx.db,
    tenant_id: ctx.tenant_id,
    conversation_id: ctx.conversation_id,
    recent_user_message: ctx.recentUserMessage ?? null,
  });
  return suppression.all;
}

export async function resolveSaveVerification(
  ctx: ToolContext,
  draft: DraftDocument,
): Promise<SaveVerificationEvidence> {
  const evidence = saveVerificationEvidence(draft, false);
  if (evidence.preview !== "missing") return evidence;
  return saveVerificationEvidence(draft, await previewsForbiddenByUser(ctx));
}

export async function checkWorkflowSaveReadiness(p: {
  ctx: ToolContext;
  forceCommit?: boolean;
}): Promise<
  { ok: true; verification: SaveVerificationEvidence } | { ok: false; result: ToolResult }
> {
  const outcome = await runSaveGauntlet(
    { ctx: p.ctx, ...(p.forceCommit !== undefined ? { forceCommit: p.forceCommit } : {}) },
    "proposal",
  );
  if (outcome.blocked) {
    logger.info({
      module: "conversation_persistence",
      action: "save_proposal.refused",
      msg: "save proposal refused before any confirmation card — the draft is not ready to save",
      tenant_id: p.ctx.tenant_id,
      conversation_id: p.ctx.conversation_id,
      error_code: outcome.blocked.ok ? null : (outcome.blocked.error_code ?? null),
    });
    return { ok: false, result: outcome.blocked };
  }
  return { ok: true, verification: outcome.facts.verification };
}

export async function commitWorkflowAtomic(p: CommitWorkflowAtomicParams): Promise<ToolResult> {
  const outcome = await runSaveGauntlet(p, "commit");
  if (outcome.blocked) return outcome.blocked;
  return persistAfterGauntlet(p, outcome.facts);
}

async function runSaveGauntlet(
  p: CommitWorkflowAtomicParams,
  mode: SaveGauntletMode,
): Promise<SaveGauntletOutcome> {
  const { ctx } = p;
  const fullDraft = ctx.getDraft();
  const sensitiveDraft = getWorkflowDraft(fullDraft).execution_privacy === "sensitive";
  const verification = await resolveSaveVerification(ctx, fullDraft);
  const redactedPreview = fullDraft.latest_preview?.redacted === true;
  const latestPreview = redactedPreview && !sensitiveDraft ? null : fullDraft.latest_preview;
  const latestExecution = fullDraft.state?.latest_execution ?? null;
  const latestPreviewClearedRepair =
    latestPreview?.ok === true && latestPreview.requires_repair !== true;
  const previewMissing = !latestPreview;
  const previewFailed = latestPreview?.ok === false;
  const previewFailureClass = previewFailed ? classifyPreviewFailure(latestPreview) : null;
  const runtimeDataFailure = previewFailureClass === "runtime_data";
  const forceClearsPreview = p.forceCommit === true && (previewMissing || runtimeDataFailure);

  if (sensitiveDraft && p.forceCommit === true) {
    return {
      blocked: {
        ok: false,
        error_code: "sensitive_save_override_forbidden",
        message:
          "Sensitive definitions may only be saved as inspected, validated inactive drafts. Preview overrides are forbidden; runtime verification remains unavailable in chat.",
        next_best_actions: ["inspect_workflow_draft", "validate_draft", "save_workflow_draft"],
      },
      facts: null,
    };
  }

  const gatePlayground = async (): Promise<ToolResult | null> => {
    if (fullDraft.session?.playground !== true) return null;
    logger.info({
      module: "conversation_persistence",
      action: "commit_gate.playground_no_persist",
      msg: "playground conversation — workflow commit suppressed; nothing persisted",
      tenant_id: ctx.tenant_id,
      conversation_id: ctx.conversation_id,
      reason: p.reason ?? null,
    });
    return {
      ok: false,
      error_code: "playground_no_persist",
      message:
        "This is a playground/sandbox conversation — workflow drafts are NOT persisted here. Keep experimenting with dry_run_workflow; to save a real workflow, start a normal (non-playground) conversation and rebuild it there.",
      next_best_actions: ["dry_run_workflow"],
      data: buildGateError(fullDraft, {
        error_code: "playground_no_persist",
        message: "playground/sandbox conversations do not persist workflows",
        recommended_mode: "workflow",
        next_best_actions: ["dry_run_workflow"],
      }),
    };
  };

  const gateBypassedByAutoMode = commitGateBypassedByAutoMode({
    skipPriorApprovalCheck: p.skipPriorApprovalCheck,
    permission_mode: ctx.permission_mode,
  });

  const gatePriorApproval = async (): Promise<ToolResult | null> => {
    if (gateBypassedByAutoMode) {
      logger.warn({
        module: "conversation_persistence",
        action: "commit_gate.auto_bypass",
        msg: "save_workflow_draft commit gate bypassed — permission_mode=auto",
        tenant_id: ctx.tenant_id,
        conversation_id: ctx.conversation_id,
        permission_mode: "auto",
        bypassed_prior_approval: true,
      });
    }
    if (!p.skipPriorApprovalCheck && ctx.permission_mode !== "auto") {
      const approval = await findPriorSaveWorkflowApproval(
        ctx.db,
        ctx.tenant_id,
        ctx.conversation_id,
      );
      if (!approval) {
        logger.warn({
          module: "conversation_persistence",
          action: "commit_gate.denied",
          msg: "commitWorkflowAtomic prior-approval gate denied — no resolved ask_user_confirm with commit_intent.kind:save_workflow_draft and confirmed:true found",
          tenant_id: ctx.tenant_id,
          conversation_id: ctx.conversation_id,
          permission_mode: ctx.permission_mode,
          intent_kind_expected: "save_workflow_draft",
        });
        return {
          ok: false,
          data: buildGateError(fullDraft, {
            error_code: "no_prior_approval",
            message:
              "save_workflow_draft requires a resolved ask_user_confirm whose commit_intent.kind is save_workflow_draft and whose output.confirmed is true",
            recommended_mode: "workflow",
            next_best_actions: ["ask_user_confirm"],
          }),
        };
      }
    }
    return null;
  };

  const gateInspectValidate = async (): Promise<ToolResult | null> => {
    const previewedSeq = fullDraft.state?.checkpoints?.workflow_previewed?.mutation_seq ?? -1;
    const draftSeq = fullDraft.state?.workflow_mutation_seq ?? 0;
    const previewSatisfiesInspectValidate =
      !sensitiveDraft && latestPreview?.ok === true && previewedSeq === draftSeq;
    const staleCheckpoints = previewSatisfiesInspectValidate
      ? []
      : missingFreshCheckpoints(fullDraft, ["workflow_inspected", "workflow_validated"]);
    const blocking_reasons = previewSatisfiesInspectValidate
      ? []
      : [
          ...(fullDraft.summary?.blocked_by ?? []).filter(
            (reason) =>
              reason === "inspect_workflow_draft" ||
              reason === "validate_draft" ||
              reason.startsWith("missing:"),
          ),
        ];
    if (sensitiveDraft && fullDraft.state?.checkpoints.workflow_validated?.ok !== true) {
      blocking_reasons.push("validate_draft");
    }
    if (staleCheckpoints.length > 0 || blocking_reasons.length > 0) {
      return {
        ok: false,
        error_code: "workflow_not_ready",
        message: "workflow commit is blocked until inspection and validation are fresh",
        next_best_actions: ["inspect_workflow_draft", "validate_draft"],
        data: buildGateError(fullDraft, {
          error_code: "workflow_not_ready",
          message: "workflow commit is blocked until inspection and validation are fresh",
          stale_checkpoints: staleCheckpoints,
          blocking_reasons,
          recommended_mode: "workflow",
          next_best_actions: ["inspect_workflow_draft", "validate_draft"],
          extra: {
            latest_preview: latestPreview ?? null,
          },
        }),
      };
    }
    return null;
  };

  const gatePlaceholderDestinations = async (): Promise<ToolResult | null> => {
    const parsed = WorkflowDefSchema.safeParse(workflowDefFromDraft(getWorkflowDraft(fullDraft)));
    if (!parsed.success) return null;
    const violations = detectPlaceholderDestinations(parsed.data, { tier: "all" });
    if (violations.length === 0) return null;
    logger.info({
      module: "conversation_persistence",
      action: "commit_gate.placeholder_destination",
      msg: "workflow commit refused — the draft fills destination(s) with placeholder values; the value must come from the user",
      tenant_id: ctx.tenant_id,
      conversation_id: ctx.conversation_id,
      paths: violations.map((v) => v.path),
    });
    return placeholderDestinationGateResult(fullDraft, violations, "save_workflow_draft");
  };

  const gatePartialSuccess = async (): Promise<ToolResult | null> => {
    if (
      latestExecution?.requires_repair === true &&
      !latestPreviewClearedRepair &&
      p.forceCommit !== true
    ) {
      return {
        ok: false,
        error_code: "partial_success_not_acknowledged",
        message:
          "the most recent run finished as partial_success and the latest preview has not cleared it. Repair the workflow, run dry_run_workflow again, or call save_workflow_draft with force_commit:true after the operator explicitly confirms",
        data: buildGateError(fullDraft, {
          error_code: "partial_success_not_acknowledged",
          message:
            "partial_success cannot be silently committed — repair the workflow or force the commit with operator confirmation",
          recommended_mode: "execution",
          next_best_actions: ["diagnose_latest_execution", "inspect_workflow", "dry_run_workflow"],
          extra: {
            execution_id: latestExecution.execution_id,
            warnings_count: latestExecution.warnings_count,
            force_commit_available: true,
          },
        }),
      };
    }
    return null;
  };

  const gateWarnings = async (): Promise<ToolResult | null> => {
    if (
      latestExecution?.requires_repair === true &&
      !latestPreviewClearedRepair &&
      p.forceCommit !== true
    ) {
      return {
        ok: false,
        error_code: "warnings_unacknowledged",
        message:
          "the most recent execution carries `requires_repair: true` and the latest preview has not cleared it. Re-run dry_run_workflow with the fixed expressions to confirm the repair flag is gone, or call save_workflow_draft with force_commit:true after the operator explicitly confirms",
        data: buildGateError(fullDraft, {
          error_code: "warnings_unacknowledged",
          message:
            "the run shape suggests a real bug (requires_repair: true) — repair before committing or force_commit after explicit operator confirmation",
          recommended_mode: "execution",
          next_best_actions: ["diagnose_latest_execution", "inspect_workflow", "dry_run_workflow"],
          extra: {
            execution_id: latestExecution.execution_id,
            warnings_count: latestExecution.warnings_count,
            requires_repair: true,
            force_commit_available: true,
          },
        }),
      };
    }
    return null;
  };

  const gateNoMeaningfulChange = async (): Promise<ToolResult | null> => {
    if (
      latestPreview?.ok === true &&
      Array.isArray(latestPreview.preview) &&
      (latestPreview.preview as unknown[]).length === 0 &&
      latestExecution?.warnings_count != null &&
      latestExecution.warnings_count > 0 &&
      p.forceCommit !== true
    ) {
      return {
        ok: false,
        error_code: "no_meaningful_change",
        message:
          "preview output is empty `[]` AND the most recent execution had warnings — committing would stack another broken version. Either change the workflow shape so the loop body produces rows, or call save_workflow_draft with force_commit:true after the operator explicitly confirms",
        data: buildGateError(fullDraft, {
          error_code: "no_meaningful_change",
          message:
            "preview returned an empty array and the prior execution had warnings — likely a broken loop body",
          recommended_mode: "workflow",
          next_best_actions: ["edit_workflow_patch", "dry_run_workflow"],
          extra: {
            force_commit_available: true,
          },
        }),
      };
    }
    return null;
  };

  const gateProposalPreviewFresh = async (): Promise<ToolResult | null> => {
    if (mode !== "proposal" || verification.preview !== "missing" || previewMissing) return null;
    return {
      ok: false,
      error_code: "workflow_not_ready",
      message:
        "the latest dry_run_workflow preview predates the current draft change — run dry_run_workflow on the changed draft (writes held, nothing activated) before proposing to save",
      next_best_actions: ["dry_run_workflow"],
      data: buildGateError(fullDraft, {
        error_code: "workflow_not_ready",
        message: "save proposal is blocked until the changed draft has a fresh held preview",
        stale_checkpoints: ["workflow_previewed"],
        recommended_mode: "workflow",
        next_best_actions: ["dry_run_workflow"],
        extra: {
          latest_preview: latestPreview ?? null,
          preparation_required: true,
          recommended_action: "dry_run_workflow",
          recovery_guidance:
            "Run the supported hold-writes preview of the changed draft with grounded inputs within current permissions. This is routine preparation, not a user choice. Report its outcome with the save proposal.",
        },
      }),
    };
  };

  const gatePreview = async (): Promise<ToolResult | null> => {
    if (verification.preview === "skipped_by_user") return null;
    if ((previewMissing || previewFailed) && !forceClearsPreview) {
      const configInvalid = previewFailureClass === "config_invalid";
      const sensitivePreviewFailed = sensitiveDraft && previewFailed;
      const recovery = configInvalid
        ? ["dry_run_workflow", "inspect_workflow"]
        : sensitivePreviewFailed
          ? ["dry_run_workflow", "inspect_workflow_draft", "edit_workflow_patch"]
          : previewFailed
            ? ["dry_run_workflow", "ask_user_confirm", "save_workflow_draft"]
            : ["dry_run_workflow"];
      const topMessage = configInvalid
        ? `the dry-run failed because the workflow itself is invalid (${previewFailureClass}) — force_commit cannot bypass a config-invalid failure; fix the draft (resolve the step reference / expression / cycle) and re-run dry_run_workflow`
        : sensitivePreviewFailed
          ? "the most recent sensitive metadata test run was unsuccessful — fix the draft from the step statuses and safe failure codes, then re-run dry_run_workflow; sensitive definitions cannot be force-saved"
          : previewFailed
            ? "the most recent dry-run was unsuccessful — re-run dry_run_workflow successfully, or call save_workflow_draft again with force_commit: true after the operator explicitly confirms"
            : "workflow commit is blocked until a successful dry_run_workflow has run";
      return {
        ok: false,
        error_code: previewFailed ? "preview_failed" : "workflow_not_ready",
        message: topMessage,
        next_best_actions: recovery,
        ...(latestPreview ? { details: latestPreview } : {}),
        data: buildGateError(fullDraft, {
          error_code: previewFailed ? "preview_failed" : "workflow_not_ready",
          message: configInvalid
            ? `preview failed: the workflow is invalid (${previewFailureClass}) — force_commit cannot bypass this class; fix the draft and re-run dry_run_workflow`
            : previewFailed
              ? "preview failed — re-run dry_run_workflow, or call save_workflow_draft again with force_commit: true after the operator explicitly confirms"
              : "workflow commit is blocked until dry_run_workflow has produced a fresh preview",
          stale_checkpoints: previewFailed ? [] : ["workflow_previewed"],
          recommended_mode: "workflow",
          next_best_actions: recovery,
          extra: {
            latest_preview: latestPreview ?? null,
            force_commit_available: runtimeDataFailure && !sensitiveDraft,
            preparation_required: previewMissing,
            ...(previewMissing
              ? {
                  recommended_action: "dry_run_workflow",
                  recovery_guidance:
                    "Run the supported hold-writes preview with grounded inputs within current permissions. This is routine preparation, not a user choice. Report checked and untested effects separately; do not offer bypassing the missing check.",
                }
              : {}),
            ...(previewFailureClass ? { preview_failure_class: previewFailureClass } : {}),
          },
        }),
      };
    }
    return null;
  };

  const commitGauntlet: CommitGate[] = [
    { name: "playground_no_persist", run: gatePlayground },
    ...(mode === "commit" ? [{ name: "prior_approval", run: gatePriorApproval }] : []),
    { name: "inspect_validate_fresh", run: gateInspectValidate },
    { name: "placeholder_destination", run: gatePlaceholderDestinations },
    { name: "partial_success", run: gatePartialSuccess },
    { name: "warnings_unacknowledged", run: gateWarnings },
    { name: "no_meaningful_change", run: gateNoMeaningfulChange },
    { name: "preview", run: gatePreview },
    { name: "proposal_preview_fresh", run: gateProposalPreviewFresh },
  ];
  for (const gate of commitGauntlet) {
    const blocked = await gate.run();
    if (blocked) return { blocked, facts: null };
  }
  return {
    blocked: null,
    facts: {
      fullDraft,
      sensitiveDraft,
      forceClearsPreview,
      runtimeDataFailure,
      previewFailureClass,
      verification,
    },
  };
}

async function persistAfterGauntlet(
  p: CommitWorkflowAtomicParams,
  facts: SaveGauntletFacts,
): Promise<ToolResult> {
  const { ctx } = p;
  const {
    fullDraft,
    sensitiveDraft,
    forceClearsPreview,
    runtimeDataFailure,
    previewFailureClass,
    verification,
  } = facts;
  const previewSkippedByUser = verification.preview === "skipped_by_user";
  const schemaOnlyVerified = sensitiveDraft && verification.preview === "passed_schema_only";

  if (forceClearsPreview && runtimeDataFailure) {
    logger.info({
      module: "conversation_persistence",
      action: "commit_gate.runtime_data_force",
      msg: "committing over a runtime/data dry-run failure with force_commit — draft is structurally valid",
      tenant_id: ctx.tenant_id,
      conversation_id: ctx.conversation_id,
      preview_failure_class: previewFailureClass,
    });
  }

  const draft = getWorkflowDraft(fullDraft);
  const def = workflowDefFromDraft(draft);

  {
    const draftRecord = draft as unknown as Record<string, unknown>;
    const defRecord = def as unknown as Record<string, unknown>;
    const droppedFields = PROJECTED_OPTIONAL_FIELDS.filter(
      (k) => isMeaningfulDraftValue(draftRecord[k]) && !isMeaningfulDraftValue(defRecord[k]),
    );
    if (droppedFields.length > 0) {
      logger.error({
        module: "conversation_persistence",
        action: "commit.projection_dropped_field",
        msg: "commit would silently drop draft fields — workflowDefFromDraft projection is incomplete",
        tenant_id: ctx.tenant_id,
        conversation_id: ctx.conversation_id,
        dropped_fields: droppedFields,
      });
      return {
        ok: false,
        data: buildGateError(fullDraft, {
          error_code: "commit_projection_incomplete",
          message: `commit would silently drop draft field(s): ${droppedFields.join(", ")} — the workflowDefFromDraft projection is missing them. This is an engine bug, not an authoring mistake; do not retry blindly.`,
          recommended_mode: "workflow",
          extra: { dropped_fields: droppedFields },
        }),
      };
    }
  }

  const result = await persistAuthoringWorkflowDraft({
    ctx,
    fullDraft,
    def,
    auditMetadata: {
      ...p.extraAuditMetadata,
      reason: p.reason ?? "authoring_draft_saved",
      source: p.emitAutoPersistAudit ? "harness_auto_persist" : "tool_call",
      ...(previewSkippedByUser
        ? { runtime_verification: "not_performed" }
        : schemaOnlyVerified
          ? { runtime_verification: "schema_only" }
          : sensitiveDraft
            ? { runtime_verification: "metadata_only" }
            : {}),
      ...(previewSkippedByUser ? { preview_skipped: "explicit_no_run" } : {}),
      ...(p.commitIntentKind ? { commit_intent_kind: p.commitIntentKind } : {}),
      ...(forceClearsPreview && runtimeDataFailure
        ? { forced_over_runtime_data: true, preview_failure_class: previewFailureClass }
        : {}),
    },
    ...(p.target_workflow_id ? { explicitTarget: p.target_workflow_id } : {}),
  });
  if (!result.ok) return result;
  if (previewSkippedByUser && !sensitiveDraft) {
    return {
      ...result,
      data: {
        ...(typeof result.data === "object" && result.data !== null ? result.data : {}),
        runtime_verification: "not_performed",
        verification_guidance:
          "Only the inactive definition was saved. The user excluded test runs, so no held preview ran; verify it with dry_run_workflow once the user allows a test run.",
      },
    };
  }
  if (!sensitiveDraft) return result;
  return {
    ...result,
    data: {
      ...(typeof result.data === "object" && result.data !== null ? result.data : {}),
      runtime_verification: previewSkippedByUser
        ? "not_performed"
        : schemaOnlyVerified
          ? "schema_only"
          : "metadata_only",
      verification_guidance: schemaOnlyVerified
        ? `Only the inactive sensitive definition was saved. ${SCHEMA_ONLY_NOTE} No request was dispatched and no data was read. ${SENSITIVE_LIVE_VERIFICATION_HANDOFF}`
        : previewSkippedByUser
          ? "Only the inactive sensitive definition was saved. The user excluded test runs, so no test run ran; once the user allows one, dry_run_workflow returns metadata only. Use the permitted execution/result API with the original caller for separately authorized live verification."
          : "Only the inactive sensitive definition was saved. Its test run returned metadata only; values stay withheld from chat. Use the permitted execution/result API with the original caller for separately authorized live verification.",
    },
  };
}
