// Authoring persistence creates an inert draft. Activation is a separate boundary.
import { logger } from "../../logging/logger.ts";
import { WORKFLOW_DEF_FIELD_KEYS, type WorkflowDef } from "../../workflows/types.ts";
import { getWorkflowDraft } from "../authoring-state.ts";
import { buildGateError, missingFreshCheckpoints } from "../tools/authoring-contract.ts";
import type { ToolContext, ToolResult } from "../tools/index.ts";
import type { WorkflowDraftDocument } from "../types.ts";
import { persistAuthoringWorkflowDraft } from "./persist-authoring-workflow-draft.ts";
import { classifyPreviewFailure } from "./preview-failure-class.ts";
import { findPriorSaveWorkflowApproval } from "./save-workflow-approval.ts";

/**
 * The `WorkflowDef`-shaped object the workflows service accepts, projected
 * from the conversation's working draft. Structurally a `WorkflowDef` with
 * `name` + `steps` required and every other field optional, plus the
 * draft-only `edges` ordering hint (see below).
 */
export type WorkflowDefFromDraft = Partial<Omit<WorkflowDef, "name" | "steps">> & {
  name: string;
  steps: Array<Record<string, unknown>>;
  /**
   * Draft-only step-ordering hint. NOT a `WorkflowDef` schema field —
   * `WorkflowDefSchema` strips it at validate time — but carried through the
   * projection for draft display (`inspect_workflow_draft`) and pinned by
   * the projection contract test.
   */
  edges?: Array<{ from: string; to: string }>;
};

/**
 * The single persistable-field allowlist. Sourced from `WORKFLOW_DEF_FIELD_KEYS`
 * (the `WorkflowDef` schema shape) so this projection and its drop-detection
 * guard iterate ONE authoritative roster — a new persistable field added to
 * the schema is projected automatically and can never silently drop on commit.
 * `name` + `steps` are always present (required by `WorkflowDef`), so the
 * optional roster excludes them; `edges` is the one draft-only passthrough.
 */
const PROJECTED_OPTIONAL_FIELDS: readonly string[] = [
  ...WORKFLOW_DEF_FIELD_KEYS.filter((k) => k !== "name" && k !== "steps"),
  "edges",
];

/**
 * Whether a draft field value is meaningful enough to persist: present and
 * non-empty. The projection copy predicate and the drop-detection guard both
 * use this, so the two can never disagree about what "carried" means.
 */
function isMeaningfulDraftValue(v: unknown): boolean {
  return v !== undefined && v !== null && v !== "";
}

/**
 * Build the `WorkflowDef`-shaped commit payload from the conversation's
 * working draft. Iterates the single `PROJECTED_OPTIONAL_FIELDS` allowlist
 * rather than a hand-maintained field-by-field spread, so a persistable field
 * present on the draft is never silently dropped. The contract test in
 * `tests/commit-workflow-def-from-draft.test.ts` pins the field behaviour.
 */
export function workflowDefFromDraft(draft: WorkflowDraftDocument): WorkflowDefFromDraft {
  const src = draft as unknown as Record<string, unknown>;
  const out: Record<string, unknown> = {
    name: draft.name,
    steps: draft.steps,
  };
  for (const key of PROJECTED_OPTIONAL_FIELDS) {
    const value = src[key];
    if (key === "derived_from_skill_id") {
      // Nullable — an explicit `null` ("authored from scratch") is a
      // meaningful signal the workflow validator reads, so carry it through
      // on merely-defined, not just truthy.
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
  /** Optional explicit target — set after the user confirmed slug-overwrite. */
  target_workflow_id?: string | undefined;
  /**
   * Skip the prior-approval gate. The tool path always passes false
   * (or omits, which defaults to false). The harness auto-persist
   * path passes true because the operator already confirmed via the
   * carrier elicitation that drove the dispatch.
   */
  skipPriorApprovalCheck?: boolean;
  /**
   * Persist even if the most recent dry-run failed. Operator-confirmed
   * escape hatch; matches the `force_commit` arg on the tool wrapper.
   * Defaults to false — a failed (or missing) preview returns a
   * structured `workflow_not_ready` envelope so the LLM can re-issue
   * with the operator's blessing.
   */
  forceCommit?: boolean;
  reason?: string;
  emitAutoPersistAudit?: boolean;
  commitIntentKind?: string;
  /** Extra keys folded into the auto-persist audit metadata — the
   *  governance record of WHY the commit happened (e.g. the preview
   *  judge's verdict that permitted a green auto-commit). */
  extraAuditMetadata?: Record<string, unknown>;
}

/**
 * One commit gate. Inspects the draft / preview / execution state and
 * returns a blocked-envelope `ToolResult` to STOP the commit, or `null` to
 * fall through to the next gate. Kept as a named unit so the ordered
 * `commitGauntlet` array below reads as the exact gate sequence — a gate
 * can never be silently reordered or dropped.
 */
type CommitGate = { name: string; run: () => Promise<ToolResult | null> };

/**
 * The prior-approval gate is skipped when the session runs in
 * `permission_mode=auto`. Exported so the audit row written on the tool path
 * can state that with the SAME rule the gate applies — two copies of this
 * predicate would drift, and then the audit log would say "manually re-issued"
 * about a commit nobody approved.
 */
export function commitGateBypassedByAutoMode(p: {
  skipPriorApprovalCheck?: boolean | undefined;
  permission_mode?: string | null | undefined;
}): boolean {
  return !p.skipPriorApprovalCheck && p.permission_mode === "auto";
}

export async function commitWorkflowAtomic(p: CommitWorkflowAtomicParams): Promise<ToolResult> {
  const { ctx } = p;
  const fullDraft = ctx.getDraft();
  // ── Shared derived signals ───────────────────────────────────────────
  // Computed once and read by BOTH the gates and the post-gauntlet
  // audit/projection flow, so a gate and the downstream force-commit audit
  // can never disagree about the same fact.
  const latestPreview = fullDraft.latest_preview;
  const latestExecution = fullDraft.state?.latest_execution ?? null;
  // A fresher preview that cleared `requires_repair` (the LLM re-ran
  // dry_run with a fix). Reused by the partial_success + warnings gates —
  // same predicate, different error_code.
  const latestPreviewClearedRepair =
    latestPreview?.ok === true && latestPreview.requires_repair !== true;
  const previewMissing = !latestPreview;
  const previewFailed = latestPreview?.ok === false;
  const previewFailureClass = previewFailed ? classifyPreviewFailure(latestPreview) : null;
  // `runtime_data` is the only failed-preview class a force_commit may
  // clear. config_invalid/unknown stay non-overridable.
  const runtimeDataFailure = previewFailureClass === "runtime_data";
  const forceClearsPreview = p.forceCommit === true && (previewMissing || runtimeDataFailure);

  // ── The commit gauntlet ──────────────────────────────────────────────
  // Each gate below is a named function returning a blocked envelope or
  // `null`. The `commitGauntlet` array is the single source of truth for
  // gate ORDER — pinned by the commit-workflow gate tests. The gate bodies
  // + envelopes are unchanged from the prior inline chain; this is a
  // readability/structure refactor only.

  // Playground/sandbox short-circuit. A playground conversation is a
  // scratch surface (durable `draft.session.playground`) — dry-runs work
  // for experimentation, but a commit persists NOTHING. Both the LLM tool
  // path (save_workflow_draft) and the harness auto-persist path route
  // through here, so this single gate makes the whole surface
  // consequence-free. Return an honest, non-ok envelope — never a silent
  // success — so the model cannot claim a workflow was saved.
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

  // Prior-approval gate — only when the tool path requested it AND the
  // session is not in `permission_mode=auto`. The harness auto-persist
  // path bypasses this entirely (skipPriorApprovalCheck=true).
  //
  // Authorization is resolved via the SHARED `findPriorSaveWorkflowApproval`
  // predicate — keyed on `input.commit_intent.kind === "save_workflow_draft"`,
  // the authoritative field, NOT the cosmetic top-level `input.kind`.
  // The policy gate in `tools/sdk-wrap/invoke.ts` imports the SAME
  // predicate, so the two gates can never disagree again.
  // Computed once at function scope: the gate reads it to decide whether to
  // run, and the audit row below reads it to say so. One value, one truth.
  const gateBypassedByAutoMode = commitGateBypassedByAutoMode({
    skipPriorApprovalCheck: p.skipPriorApprovalCheck,
    permission_mode: ctx.permission_mode,
  });

  const gatePriorApproval = async (): Promise<ToolResult | null> => {
    if (gateBypassedByAutoMode) {
      // FIX 6 / BUG-6: forensic audit so "did anyone approve this commit?"
      // is answerable from logs. Mirrors `tool.executed_yolo`.
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
        // Forensic log: the gate denied the commit. Pre-fix this
        // collapsed into a single "tool.failed: no_prior_approval" line
        // which forced operators to bisect three different bugs.
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

  // Inspect + validate freshness gate. These structural gates are
  // non-overridable — they reflect "the draft itself is broken", which
  // `force_commit` was never intended to bypass.
  //
  // Exception: when a fresh `workflow_previewed` checkpoint exists
  // AND the preview was successful, we treat that as subsuming
  // `workflow_inspected` + `workflow_validated`. Reason: a successful
  // dry_run necessarily walked + validated the draft and produced a
  // real shape per step. Without this exemption, the auto-persist
  // path failed the very first commit (session a128deba 15:18:31.506)
  // because the LLM dry-ran but never explicitly inspected/validated,
  // so the operator's approval click did nothing and they had to
  // approve a SECOND time.
  const gateInspectValidate = async (): Promise<ToolResult | null> => {
    const previewedSeq = fullDraft.state?.checkpoints?.workflow_previewed?.mutation_seq ?? -1;
    const draftSeq = fullDraft.state?.workflow_mutation_seq ?? 0;
    const previewSatisfiesInspectValidate = latestPreview?.ok === true && previewedSeq === draftSeq;
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

  // Partial-success gate — a recent execution that classified itself
  // as `partial_success` (e.g. unresolved_identifier warning, or a
  // loop step body that produced no rows) blocks the commit unless
  // the operator explicitly forces. The block is bypassed when a
  // fresher preview has cleared `requires_repair` (the LLM re-ran
  // dry_run with a fix); otherwise the v1→v2→v3 broken-workflow stack
  // can land because preview returns `ok` for empty output.
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

  // Warnings-unacknowledged gate — even when the engine did not flag
  // The gate fires only when the most recent execution carries the
  // `requires_repair` flag — the engine sets this when the run shape
  // suggests a real bug (empty extraction over non-empty source, loop
  // body never executed, unresolved_identifier fired). Informational
  // warnings (e.g. `transform_dropped_fields` for an intentional
  // projection) do not carry `requires_repair: true` and therefore do
  // not block commit. This matches the documented contract in
  // workflow-authoring.md — "read requires_repair, not the warning
  // count" — and unblocks auto-persist for runs that are correct but
  // happen to surface informational warnings. The check is bypassed
  // when forceCommit is set, or when a fresher preview has cleared the
  // repair flag (the LLM has re-run dry_run after the offending
  // execution). Reuses `latestPreviewClearedRepair` computed above for
  // the partial_success gate — same predicate, different error_code.
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

  // No-meaningful-change gate — when the latest preview output is
  // structurally equivalent to the prior committed version's last
  // preview output AND the workflow def is hash-equivalent, the
  // already_persisted shortcut in save-workflow-draft.ts catches it. Here we
  // additionally refuse a commit when the preview output is the
  // empty-array shape that signaled `partial_success` on the last
  // execution. The LLM otherwise commits v4, runs, hits warnings,
  // commits v5 with the same empty shape, and so on.
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

  // Preview gate — a missing or failed dry-run blocks the commit
  // UNLESS the operator explicitly forces it. Mirrors the connector
  // probe-failed contract.
  //
  // A failed preview is classified so the gate reacts proportionally:
  //   - `config_invalid` / `unknown` → the draft is broken (or the
  //     failure could not be attributed to the remote world). Block
  //     even when `force_commit` is set — persisting a known-broken DAG
  //     is never what the operator means.
  //   - `runtime_data` → the draft is structurally sound but the dry-run
  //     hit a data/permission error (404/410 on a deleted record, 401/403
  //     on an un-granted scope, a remote 5xx). Downgrade to a warning and
  //     allow a `force_commit:true` clean commit; the structural
  //     inspect/validate gates above still apply. Reads the hoisted
  //     `previewMissing` / `previewFailureClass` / `forceClearsPreview`.
  const gatePreview = async (): Promise<ToolResult | null> => {
    if ((previewMissing || previewFailed) && !forceClearsPreview) {
      // A config-invalid failure is NOT forceable (persisting a broken DAG is
      // never the operator's intent). Say so explicitly in the message and drop
      // save_workflow_draft from the recovery actions, so a future agent does
      // not keep retrying force_commit against an unresolved reference / bad
      // expression / cycle. Runtime/data failures and missing previews stay
      // forceable and keep the force_commit hint.
      const configInvalid = previewFailureClass === "config_invalid";
      const recovery = configInvalid
        ? ["dry_run_workflow", "inspect_workflow"]
        : previewFailed
          ? ["dry_run_workflow", "ask_user_confirm", "save_workflow_draft"]
          : ["dry_run_workflow"];
      const topMessage = configInvalid
        ? `the dry-run failed because the workflow itself is invalid (${previewFailureClass}) — force_commit cannot bypass a config-invalid failure; fix the draft (resolve the step reference / expression / cycle) and re-run dry_run_workflow`
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
            force_commit_available: previewMissing || runtimeDataFailure,
            ...(previewFailureClass ? { preview_failure_class: previewFailureClass } : {}),
          },
        }),
      };
    }
    return null;
  };

  // Run the gauntlet in order — first blocked envelope wins. The array
  // IS the contract: the sequence is visible at a glance and pinned by the
  // commit-workflow gate tests.
  const commitGauntlet: CommitGate[] = [
    { name: "playground_no_persist", run: gatePlayground },
    { name: "prior_approval", run: gatePriorApproval },
    { name: "inspect_validate_fresh", run: gateInspectValidate },
    { name: "partial_success", run: gatePartialSuccess },
    { name: "warnings_unacknowledged", run: gateWarnings },
    { name: "no_meaningful_change", run: gateNoMeaningfulChange },
    { name: "preview", run: gatePreview },
  ];
  for (const gate of commitGauntlet) {
    const blocked = await gate.run();
    if (blocked) return blocked;
  }

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

  // projection-integrity guard — defense-in-depth over the single-source
  // `workflowDefFromDraft`. The projection now iterates the ONE
  // `PROJECTED_OPTIONAL_FIELDS` allowlist (derived from the WorkflowDef schema
  // shape), so a persistable field can no longer be silently omitted by a
  // forgotten hand-spread — the regression class that broke chat-authored
  // schedules end-to-end (a saved workflow that lost its trigger). This guard
  // stays as a loud-fail assertion at the commit boundary: it re-checks that
  // every meaningful draft value in the same allowlist actually reached the
  // projected def, so any future divergence between the projection predicate
  // and this list fails HERE, not in production logs. Reuses the module-level
  // list + `isMeaningfulDraftValue`, so the two can never drift.
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

  return persistAuthoringWorkflowDraft({
    ctx,
    fullDraft,
    def,
    auditMetadata: {
      ...p.extraAuditMetadata,
      reason: p.reason ?? "authoring_draft_saved",
      source: p.emitAutoPersistAudit ? "harness_auto_persist" : "tool_call",
      ...(p.commitIntentKind ? { commit_intent_kind: p.commitIntentKind } : {}),
      ...(forceClearsPreview && runtimeDataFailure
        ? { forced_over_runtime_data: true, preview_failure_class: previewFailureClass }
        : {}),
    },
    ...(p.target_workflow_id ? { explicitTarget: p.target_workflow_id } : {}),
  });
}
