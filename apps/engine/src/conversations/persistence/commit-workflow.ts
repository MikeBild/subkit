// Atomic workflow commit — extracted from `tools/save-workflow-draft.ts` so
// both the LLM-driven tool path AND the harness-driven auto-persist
// path share one durability contract (via the elicitation
// `commit_intent`).
//
// The prior-approval gate (`ask_user_confirm{kind:save_workflow_draft}`) is
// the tool's job — by the time the harness auto-persist path lands
// here, the operator has ALREADY confirmed via the carrier
// elicitation, so the gate would just re-detect the same row and
// pass. We accept an explicit `skipPriorApprovalCheck` so callers can
// document intent.

import { and, eq, isNull } from "drizzle-orm";
import { recordWorkflowCreated, recordWorkflowUpdated } from "../../audit/recorders/index.ts";
import { conversations, workflows, workflowVersions } from "../../db/schema/index.ts";
import { logger } from "../../logging/logger.ts";
import { annotateRuntime } from "../../workflows/runtime-annotation.ts";
import { createWorkflow, updateWorkflow } from "../../workflows/service.ts";
import { WORKFLOW_DEF_FIELD_KEYS, type WorkflowDef } from "../../workflows/types.ts";
import { validateWorkflowDef } from "../../workflows/validator.ts";
import { isUnchangedFromCurrentVersion } from "../../workflows/version-dedup.ts";
import { persistedWorkflowResource } from "../authoring-state/summary.ts";
import { getWorkflowDraft, withWorkflowPersisted } from "../authoring-state.ts";
import {
  buildGateError,
  buildPersistencePayload,
  missingFreshCheckpoints,
} from "../tools/authoring-contract.ts";
import type { ToolContext, ToolResult } from "../tools/index.ts";
import { buildWorkflowUsage } from "../tools/usage-guidance.ts";
import type { WorkflowDraftDocument } from "../types.ts";
import { proposeAuthoringCapabilityCandidate } from "./commit-workflow-skill-candidate.ts";
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
  const gatePriorApproval = async (): Promise<ToolResult | null> => {
    const gateBypassedByAutoMode = !p.skipPriorApprovalCheck && ctx.permission_mode === "auto";
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

  const convRows = await ctx.db
    .select({ target_workflow_id: conversations.target_workflow_id })
    .from(conversations)
    .where(
      and(eq(conversations.tenant_id, ctx.tenant_id), eq(conversations.id, ctx.conversation_id)),
    )
    .limit(1);
  let targetWorkflowId = convRows[0]?.target_workflow_id ?? null;
  // Set when the same-slug adoption path claims an existing live row, so the
  // downstream audit row can distinguish an adoption-driven update from a
  // normal in-place edit ("where did this version come from?").
  let adoptedSameSlug = false;

  // Identity gate: the draft's slug is the source of truth for what
  // workflow row this commit targets. The conversation's stored
  // target_workflow_id is just remembered context — when the draft has
  // pivoted to a different slug, treating it as the upsert key would
  // silently overwrite the previously-saved workflow with the new
  // artifact's content (the bug seen on Berlin → GitHub topic
  // pivots). Explicit p.target_workflow_id is the only override —
  // that's the LLM signalling "yes, intentionally update this row"
  // (e.g. a slug rename after the user confirmed overwrite).
  if (targetWorkflowId && !p.target_workflow_id && def.slug) {
    const targetSlugRows = await ctx.db
      .select({ slug: workflows.slug })
      .from(workflows)
      .where(
        and(
          eq(workflows.tenant_id, ctx.tenant_id),
          eq(workflows.id, targetWorkflowId),
          isNull(workflows.deleted_at),
        ),
      )
      .limit(1);
    const targetSlug = targetSlugRows[0]?.slug ?? null;
    if (targetSlug !== null && targetSlug !== def.slug) {
      logger.info({
        module: "conversation",
        action: "save_workflow_draft.target_pivot_detected",
        msg: "draft slug diverged from conversation target_workflow_id — treating as new artifact",
        conversation_id: ctx.conversation_id,
        stale_target_workflow_id: targetWorkflowId,
        stale_target_slug: targetSlug,
        draft_slug: def.slug,
      });
      targetWorkflowId = null;
      await ctx.db
        .update(conversations)
        .set({ target_workflow_id: null, updated_at: new Date() })
        .where(eq(conversations.id, ctx.conversation_id));
    }
  }

  if (p.target_workflow_id) {
    const explicitRows = await ctx.db
      .select({ id: workflows.id })
      .from(workflows)
      .where(
        and(
          eq(workflows.tenant_id, ctx.tenant_id),
          eq(workflows.id, p.target_workflow_id),
          isNull(workflows.deleted_at),
        ),
      )
      .limit(1);
    if (!explicitRows[0]) {
      return {
        ok: false,
        data: buildGateError(fullDraft, {
          error_code: "target_workflow_not_found",
          message: `target_workflow_id "${p.target_workflow_id}" does not exist or is not live in this tenant`,
          recommended_mode: "workflow",
          extra: { attempted_target_workflow_id: p.target_workflow_id },
        }),
      };
    }
    targetWorkflowId = explicitRows[0].id;
    await ctx.db
      .update(conversations)
      .set({ target_workflow_id: targetWorkflowId, updated_at: new Date() })
      .where(eq(conversations.id, ctx.conversation_id));
  }

  // Bound-workflow resolution: an edit of a hydrated workflow (slug
  // unchanged) is an update-in-place — resolve the target from the
  // bound resource so the slug-conflict check below does not treat it
  // as a new artifact. A draft slug matching a different workflow has
  // a non-matching bound slug, so a genuine conflict still fires.
  if (!targetWorkflowId && def.slug && fullDraft.state) {
    const bound = persistedWorkflowResource(fullDraft.state);
    if (bound && bound.slug === def.slug) {
      const boundRows = await ctx.db
        .select({ id: workflows.id })
        .from(workflows)
        .where(
          and(
            eq(workflows.tenant_id, ctx.tenant_id),
            eq(workflows.id, bound.id),
            isNull(workflows.deleted_at),
          ),
        )
        .limit(1);
      if (boundRows[0]) {
        targetWorkflowId = boundRows[0].id;
        await ctx.db
          .update(conversations)
          .set({ target_workflow_id: targetWorkflowId, updated_at: new Date() })
          .where(eq(conversations.id, ctx.conversation_id));
      }
    }
  }

  // Per-step authoring vocabulary captured from the most recent
  // dry_run / run on this draft. Persisted next to the DAG so a
  // follow-up authoring session can call inspect_workflow /
  // suggest_jsonata_paths without re-running the workflow. Empty
  // map when no preview was recorded — never undefined, so the
  // column distinguishes "no preview" from "scope explicitly empty".
  // Declared before the idempotent check below because that check
  // feeds it into `isUnchangedFromCurrentVersion` (a fresher scope
  // index on an otherwise-unchanged def is written in place there).
  const scopeIndex: Record<
    string,
    { available_paths: string[]; shape_summary: string; primary_data_path: string | null }
  > = {};
  for (const trace of latestPreview?.step_traces ?? []) {
    if (!trace?.scope_at_step) continue;
    scopeIndex[trace.step_id] = {
      available_paths: trace.scope_at_step.available_paths ?? [],
      shape_summary: trace.scope_at_step.shape_summary ?? "unknown",
      primary_data_path: trace.scope_at_step.primary_data_path ?? null,
    };
  }
  const persistScopeIndex = Object.keys(scopeIndex).length > 0 ? scopeIndex : null;

  // Lazy + memoised validate/annotate for the idempotency comparison: it runs
  // at most once but only when actually needed. The closure can fire twice
  // (bound target + same-slug adoption) and must not re-validate; but a
  // happy-path first commit (no target, no slug conflict) never calls it, so
  // we must not pay the validation cost there either (createWorkflow validates
  // downstream). Returns null when the draft fails validation → "not idempotent".
  let idemComputed = false;
  let idemAnnotated: ReturnType<typeof annotateRuntime> | null = null;
  const idempotencyAnnotated = (): ReturnType<typeof annotateRuntime> | null => {
    if (!idemComputed) {
      idemComputed = true;
      const v = validateWorkflowDef(def);
      idemAnnotated = v.ok && v.workflow ? annotateRuntime(v.workflow) : null;
    }
    return idemAnnotated;
  };

  // Idempotent re-commit. When the target row is already resolved and
  // the draft def is byte-identical to its current version, do NOT
  // append a redundant version (which churns history and unbinds
  // schedules) and do NOT re-record an audit row reporting "Created".
  // Reuses the SAME `isUnchangedFromCurrentVersion` predicate that
  // `updateWorkflow` uses internally — fed the validated + annotated
  // def so the comparison is like-for-like with the stored dag.
  // Mirrors the `already_persisted` shortcut in save-connector-draft.ts.
  async function idempotentResultIfUnchanged(workflowId: string): Promise<ToolResult | null> {
    const wfRows = await ctx.db
      .select({
        slug: workflows.slug,
        name: workflows.name,
        current_version_id: workflows.current_version_id,
      })
      .from(workflows)
      .where(
        and(
          eq(workflows.tenant_id, ctx.tenant_id),
          eq(workflows.id, workflowId),
          isNull(workflows.deleted_at),
        ),
      )
      .limit(1);
    const wf = wfRows[0];
    if (!wf?.current_version_id) return null;
    // Validate only now that the cheap current_version_id lookup confirmed
    // there is something to compare against.
    const annotated = idempotencyAnnotated();
    if (!annotated) return null;
    const { unchanged } = await isUnchangedFromCurrentVersion({
      tx: ctx.db,
      tenant_id: ctx.tenant_id,
      workflow_id: workflowId,
      workflow_slug: wf.slug,
      current_version_id: wf.current_version_id,
      def: annotated,
      scope_index: persistScopeIndex,
    });
    if (!unchanged) return null;
    const versionRows = await ctx.db
      .select({ version: workflowVersions.version })
      .from(workflowVersions)
      .where(
        and(
          eq(workflowVersions.tenant_id, ctx.tenant_id),
          eq(workflowVersions.id, wf.current_version_id),
        ),
      )
      .limit(1);
    const version = versionRows[0]?.version ?? null;
    // Rebinding the conversation's target_workflow_id is conversation-scoped
    // bookkeeping, not a tenant-resource mutation — it is intentionally NOT
    // audited (the immutable audit log tracks workflow versions/credentials,
    // not which workflow a conversation is currently pointed at; service.ts
    // does not audit this column anywhere). The workflow itself is unchanged
    // here, so there is deliberately no WORKFLOW_* audit row on this path.
    await ctx.db
      .update(conversations)
      .set({ target_workflow_id: workflowId, updated_at: new Date() })
      .where(eq(conversations.id, ctx.conversation_id));
    logger.info({
      module: "conversation_persistence",
      action: "save_workflow_draft.already_persisted",
      msg: "workflow def unchanged from current version — skipped redundant re-commit",
      tenant_id: ctx.tenant_id,
      conversation_id: ctx.conversation_id,
      workflow_id: workflowId,
      version,
    });
    const usage = await buildWorkflowUsage(ctx.db, ctx.tenant_id, {
      id: workflowId,
      slug: wf.slug,
      name: wf.name,
      definition: annotated,
    });
    return {
      ok: true,
      data: {
        already_persisted: true,
        version_changed: false,
        workflow_id: workflowId,
        workflow_version_id: wf.current_version_id,
        version,
        slug: wf.slug,
        name: wf.name,
        usage,
        next_best_actions: ["run_workflow", "inspect_workflow"],
        next_prompt: usage.follow_up,
      },
    };
  }

  if (targetWorkflowId) {
    const idempotent = await idempotentResultIfUnchanged(targetWorkflowId);
    if (idempotent) return idempotent;
  }

  if (!targetWorkflowId && def.slug) {
    const slugRows = await ctx.db
      .select({ id: workflows.id, name: workflows.name, slug: workflows.slug })
      .from(workflows)
      .where(
        and(
          eq(workflows.tenant_id, ctx.tenant_id),
          eq(workflows.slug, def.slug),
          isNull(workflows.deleted_at),
        ),
      )
      .limit(1);
    const conflict = slugRows[0];
    if (conflict) {
      // Same-slug recreate. Adopt the existing row as an in-place update
      // ONLY when the conversation is provably bound to THIS workflow
      // (same id) — the case the slug-based bound-resolution above misses
      // when the bound ref carries a null slug (the `latest_execution`
      // fallback in `persistedWorkflowResource`). A null binding, or a
      // binding to a DIFFERENT live workflow, is a topic pivot / foreign
      // collision: silently overwriting it would destroy a workflow this
      // conversation isn't editing. subkit's contract is "never assume" —
      // return the conflict and let the operator confirm an overwrite by
      // re-committing with `target_workflow_id`. Compare by id, never slug.
      const boundWf = fullDraft.state ? persistedWorkflowResource(fullDraft.state) : null;
      const adoptInPlace = boundWf != null && boundWf.id === conflict.id;
      if (adoptInPlace) {
        logger.debug({
          module: "conversation_persistence",
          action: "save_workflow_draft.adopt_same_slug",
          msg: "draft slug matches a live workflow with no foreign-slug pivot — adopting it as an in-place update",
          tenant_id: ctx.tenant_id,
          conversation_id: ctx.conversation_id,
          workflow_id: conflict.id,
          slug: def.slug,
        });
        targetWorkflowId = conflict.id;
        adoptedSameSlug = true;
        await ctx.db
          .update(conversations)
          .set({ target_workflow_id: targetWorkflowId, updated_at: new Date() })
          .where(eq(conversations.id, ctx.conversation_id));
        // The adopted row may already hold this exact def (re-issuing
        // the same draft against the same slug) — short-circuit so the
        // adoption path is idempotent too, not just the explicit/bound
        // target paths checked above.
        const idempotent = await idempotentResultIfUnchanged(targetWorkflowId);
        if (idempotent) return idempotent;
      } else {
        return {
          ok: false,
          data: buildGateError(fullDraft, {
            error_code: "slug_conflict_with_live_workflow",
            message: `slug "${def.slug}" already belongs to workflow "${conflict.name}" (id=${conflict.id}). Ask the user whether to overwrite that workflow or pick a different slug — never assume.`,
            recommended_mode: "workflow",
            extra: {
              attempted_slug: def.slug,
              conflict: { workflow_id: conflict.id, slug: conflict.slug, name: conflict.name },
              recovery: {
                overwrite:
                  "After the user confirms in chat, call save_workflow_draft again with target_workflow_id=<conflict.workflow_id>",
                rename:
                  "Otherwise rename the draft (edit_workflow_patch / author_workflow with a fresh slug) and re-validate before committing.",
              },
            },
          }),
        };
      }
    }
  }

  let result: Awaited<ReturnType<typeof createWorkflow>>;
  try {
    if (targetWorkflowId) {
      result = await updateWorkflow(
        {
          tenant_id: ctx.tenant_id,
          id: targetWorkflowId,
          def,
          actor_id: ctx.actor_id,
          scope_index: persistScopeIndex,
        },
        ctx.db,
      );
    } else {
      result = await createWorkflow(
        {
          tenant_id: ctx.tenant_id,
          def,
          actor_id: ctx.actor_id,
          scope_index: persistScopeIndex,
        },
        ctx.db,
      );
    }
  } catch (err) {
    const msg = err instanceof Error ? err.message : String(err);
    const cause = (err as { cause?: { code?: string; constraint?: string } }).cause;
    const code = (err as { code?: string }).code ?? cause?.code;
    const constraint = (err as { constraint?: string }).constraint ?? cause?.constraint ?? "";
    const looksLikeSlugConflict =
      code === "23505" ||
      msg.includes("23505") ||
      msg.toLowerCase().includes("duplicate key") ||
      constraint.includes("workflows_tenant_slug") ||
      constraint.includes("workflows_slug") ||
      msg.includes('insert into "workflows"');
    if (looksLikeSlugConflict) {
      const attempted = def.slug ?? def.name;
      const conflictRows = await ctx.db
        .select({ id: workflows.id, slug: workflows.slug })
        .from(workflows)
        .where(
          and(
            eq(workflows.tenant_id, ctx.tenant_id),
            eq(workflows.slug, attempted),
            isNull(workflows.deleted_at),
          ),
        )
        .limit(1);
      const existing = conflictRows[0];
      return {
        ok: false,
        data: buildGateError(fullDraft, {
          error_code: "slug_conflict_with_live_workflow",
          message: `slug "${attempted}" already exists${existing ? ` (workflow id ${existing.id})` : ""}. Ask the user whether to overwrite or pick a different slug — never assume.`,
          recommended_mode: "workflow",
          extra: {
            errors: [
              {
                path: "slug",
                message: existing
                  ? `slug "${attempted}" belongs to workflow id=${existing.id}. To overwrite it, ask the user, then call save_workflow_draft with target_workflow_id="${existing.id}". Otherwise rename the draft slug.`
                  : `slug "${attempted}" already exists for this tenant — pick a different slug and call save_workflow_draft again`,
              },
            ],
            attempted_slug: attempted,
            ...(existing ? { conflict: { workflow_id: existing.id, slug: existing.slug } } : {}),
            ...(existing
              ? {
                  recovery: {
                    overwrite: `After the user confirms in chat, call save_workflow_draft again with target_workflow_id="${existing.id}"`,
                    rename:
                      "Otherwise rename the draft (edit_workflow_patch / author_workflow with a fresh slug) and re-validate before committing.",
                  },
                }
              : {}),
          },
        }),
      };
    }
    return {
      ok: false,
      data: buildGateError(fullDraft, {
        error_code: "commit_failed",
        message: msg,
        recommended_mode: "workflow",
      }),
    };
  }
  if ("errors" in result) {
    return {
      ok: false,
      data: buildGateError(fullDraft, {
        error_code: "invalid_final_draft",
        message: "workflow draft is still invalid at commit time",
        stale_checkpoints: ["workflow_validated"],
        recommended_mode: "workflow",
        extra: {
          errors: result.errors,
          step_count: def.steps.length,
        },
      }),
    };
  }
  const workflow = result.workflow;
  await ctx.db
    .update(conversations)
    .set({
      target_workflow_id: workflow.id,
      status: "committed",
      updated_at: new Date(),
    })
    .where(eq(conversations.id, ctx.conversation_id));

  // Capability Skill-Candidate (status `proposed`, NEVER an active skill).
  // The operator just authored this workflow, so we propose a workflow-keyed
  // capability summary they can approve via the human gate (best-effort).
  const candidateNotice = await proposeAuthoringCapabilityCandidate({
    db: ctx.db,
    tenant_id: ctx.tenant_id,
    conversation_id: ctx.conversation_id,
    workflow: { id: workflow.id, slug: workflow.slug, name: workflow.name },
    def,
    scope_index: scopeIndex,
  });

  // commit telemetry: record exactly what was persisted so a partial or
  // wrong commit is never silent. The step id list + present-field summary
  // makes "what did this commit actually write?" answerable from logs alone
  // (the corsica session committed a draft missing its build_email edits with
  // no log to show it). Pairs with the projection-integrity guard above.
  logger.info({
    module: "conversation_persistence",
    action: "commit.persisted",
    msg: "workflow draft committed",
    tenant_id: ctx.tenant_id,
    conversation_id: ctx.conversation_id,
    workflow_id: workflow.id,
    slug: workflow.slug,
    version: workflow.current_version,
    step_count: def.steps.length,
    step_ids: def.steps.map((s) => (typeof s.id === "string" ? s.id : null)).filter(Boolean),
    reason: p.reason ?? null,
    commit_intent_kind: p.commitIntentKind ?? null,
  });

  if (p.emitAutoPersistAudit) {
    if (targetWorkflowId) {
      await recordWorkflowUpdated({
        tenant_id: ctx.tenant_id,
        actor_id: ctx.actor_id,
        executor: ctx.db,
        workflow_id: workflow.id,
        slug: workflow.slug,
        version: workflow.current_version,
        workflow_version_id: workflow.current_version_id,
        reason: p.reason ?? "auto_persist_on_confirmation",
        source: "harness_auto_persist",
        kind: adoptedSameSlug ? "same_slug_adoption" : "auto_persist",
        ...(p.commitIntentKind ? { commit_intent_kind: p.commitIntentKind } : {}),
        ...(p.extraAuditMetadata ?? {}),
        ...(forceClearsPreview && runtimeDataFailure
          ? {
              forced_over_runtime_data: true,
              ...(previewFailureClass ? { preview_failure_class: previewFailureClass } : {}),
            }
          : {}),
      });
    } else {
      await recordWorkflowCreated({
        tenant_id: ctx.tenant_id,
        actor_id: ctx.actor_id,
        executor: ctx.db,
        workflow_id: workflow.id,
        slug: workflow.slug,
        version: workflow.current_version,
        reason: p.reason ?? "auto_persist_on_confirmation",
        source: "harness_auto_persist",
        ...(p.commitIntentKind ? { commit_intent_kind: p.commitIntentKind } : {}),
        ...(p.extraAuditMetadata ?? {}),
        ...(forceClearsPreview && runtimeDataFailure
          ? {
              forced_over_runtime_data: true,
              ...(previewFailureClass ? { preview_failure_class: previewFailureClass } : {}),
            }
          : {}),
      });
    }
  }

  const nextDraft = withWorkflowPersisted(
    fullDraft,
    {
      kind: "workflow",
      id: workflow.id,
      slug: workflow.slug,
      name: workflow.name,
      version_id: workflow.current_version_id,
      version: workflow.current_version,
      environment: null,
      saved_at: new Date().toISOString(),
    },
    "workflow_persisted",
  );
  await ctx.setDraft(nextDraft);
  // Usage guidance rides on every commit envelope so the LLM (COMMIT
  // SUMMARY rule) and the sk summary cards can show what was created
  // and every real way to run it. next_prompt is centralised here —
  // tool wrappers spread `...data` and must NOT re-stamp it.
  const usage = await buildWorkflowUsage(ctx.db, ctx.tenant_id, {
    id: workflow.id,
    slug: workflow.slug,
    name: workflow.name,
    definition: def,
  });
  return {
    ok: true,
    data: {
      ...buildPersistencePayload(nextDraft, {
        resource_kind: "workflow",
        resource_id: workflow.id,
        version_id: workflow.current_version_id,
      }),
      workflow_id: workflow.id,
      workflow_version_id: workflow.current_version_id,
      version: workflow.current_version,
      version_changed: true,
      slug: workflow.slug,
      name: workflow.name,
      usage,
      next_best_actions: ["run_workflow", "inspect_workflow"],
      next_prompt: candidateNotice ? `${usage.follow_up}\n${candidateNotice}` : usage.follow_up,
    },
    committed_workflow_id: workflow.id,
  };
}
