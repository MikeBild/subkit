// Atomic workflow commit — extracted from `tools/save-workflow-draft.ts` so
// both the LLM-driven tool path AND the harness-driven auto-persist
// path share one durability contract (PR11/PR12 — elicitation
// `commit_intent`).
//
// The prior-approval gate (`ask_user_confirm{kind:save_workflow_draft}`) is
// the tool's job — by the time the harness auto-persist path lands
// here, the operator has ALREADY confirmed via the carrier
// elicitation, so the gate would just re-detect the same row and
// pass. We accept an explicit `skipPriorApprovalCheck` so callers can
// document intent.

import { and, desc, eq, isNull, sql } from "drizzle-orm";
import { recordWorkflowCreated, recordWorkflowUpdated } from "../../audit/recorders/index.ts";
import { conversationElicitations, conversations, workflows } from "../../db/schema/index.ts";
import { logger } from "../../logging/logger.ts";
import { createWorkflow, updateWorkflow } from "../../workflows/service.ts";
import { getWorkflowDraft, withWorkflowPersisted } from "../authoring-state.ts";
import {
  buildGateError,
  buildPersistencePayload,
  missingFreshCheckpoints,
} from "../tools/authoring-contract.ts";
import type { ToolContext, ToolResult } from "../tools/index.ts";

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
}

export async function commitWorkflowAtomic(p: CommitWorkflowAtomicParams): Promise<ToolResult> {
  const { ctx } = p;
  // Prior-approval gate — only when the tool path requested it AND the
  // session is not in `permission_mode=auto`. The harness auto-persist
  // path bypasses this entirely (skipPriorApprovalCheck=true).
  if (!p.skipPriorApprovalCheck && ctx.permission_mode !== "auto") {
    const rows = await ctx.db
      .select()
      .from(conversationElicitations)
      .where(
        and(
          eq(conversationElicitations.tenant_id, ctx.tenant_id),
          eq(conversationElicitations.conversation_id, ctx.conversation_id),
          eq(conversationElicitations.tool_name, "ask_user_confirm"),
          sql`(${conversationElicitations.input} ->> 'kind') = 'save_workflow_draft'`,
        ),
      )
      .orderBy(desc(conversationElicitations.created_at))
      .limit(1);
    const head = rows[0];
    const confirmed =
      head?.status === "resolved" &&
      typeof head.output === "object" &&
      head.output !== null &&
      (head.output as { confirmed?: unknown }).confirmed === true;
    if (!head || !confirmed) {
      // Forensic log: the gate denied the commit. Carries enough
      // shape to distinguish "no elicitation at all" (head=null —
      // typical when the LLM skipped ask_user_confirm) from "user
      // declined" (head.confirmed=false) from "still awaiting input"
      // (head.status=pending). Pre-fix this collapsed into a single
      // "tool.failed: no_prior_approval" line which forced operators
      // to bisect three different bugs.
      logger.warn({
        module: "conversation_persistence",
        action: "commit_gate.denied",
        msg: "commitWorkflowAtomic prior-approval gate denied — no resolved ask_user_confirm{kind:save_workflow_draft, confirmed:true} found",
        tenant_id: ctx.tenant_id,
        conversation_id: ctx.conversation_id,
        permission_mode: ctx.permission_mode,
        intent_kind_expected: "save_workflow_draft",
        latest_elicitation_id: head?.id ?? null,
        latest_elicitation_status: head?.status ?? null,
        latest_elicitation_confirmed:
          head && typeof head.output === "object" && head.output !== null
            ? (head.output as { confirmed?: unknown }).confirmed === true
            : null,
      });
      return {
        ok: false,
        data: buildGateError(ctx.getDraft(), {
          error_code: "no_prior_approval",
          message:
            "save_workflow_draft requires a resolved ask_user_confirm { kind: save_workflow_draft, confirmed: true }",
          recommended_mode: "workflow",
          next_best_actions: ["ask_user_confirm"],
          extra: {
            latest_elicitation_status: head?.status ?? null,
          },
        }),
      };
    }
  }

  const fullDraft = ctx.getDraft();
  const latestPreview = fullDraft.latest_preview;
  // The structural gates (inspect + validate) are non-overridable —
  // they reflect "the draft itself is broken", which `force_commit`
  // was never intended to bypass.
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

  // Partial-success gate — a recent execution that classified itself
  // as `partial_success` (e.g. unresolved_identifier warning, or a
  // loop step body that produced no rows) blocks the commit unless
  // the operator explicitly forces. The block is bypassed when a
  // fresher preview has cleared `requires_repair` (the LLM re-ran
  // dry_run with a fix); otherwise the v1→v2→v3 broken-workflow stack
  // can land because preview returns `ok` for empty output.
  const latestExecution = fullDraft.state?.latest_execution ?? null;
  const latestPreviewClearedRepair =
    latestPreview?.ok === true && latestPreview.requires_repair !== true;
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

  // No-meaningful-change gate — when the latest preview output is
  // structurally equivalent to the prior committed version's last
  // preview output AND the workflow def is hash-equivalent, the
  // already_persisted shortcut in save-workflow-draft.ts catches it. Here we
  // additionally refuse a commit when the preview output is the
  // empty-array shape that signaled `partial_success` on the last
  // execution. The LLM otherwise commits v4, runs, hits warnings,
  // commits v5 with the same empty shape, and so on.
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
        next_best_actions: ["propose_step", "dry_run_workflow"],
        extra: {
          force_commit_available: true,
        },
      }),
    };
  }

  // Preview gate — a missing or failed dry-run blocks the commit
  // UNLESS the operator explicitly forces it. Mirrors the connector
  // probe-failed contract.
  const previewMissing = !latestPreview;
  const previewFailed = latestPreview?.ok === false;
  if ((previewMissing || previewFailed) && p.forceCommit !== true) {
    return {
      ok: false,
      error_code: previewFailed ? "preview_failed" : "workflow_not_ready",
      message: previewFailed
        ? "the most recent dry-run was unsuccessful — re-run dry_run_workflow successfully, or call save_workflow_draft again with force_commit: true after the operator explicitly confirms"
        : "workflow commit is blocked until a successful dry_run_workflow has run",
      next_best_actions: previewFailed
        ? ["dry_run_workflow", "ask_user_confirm", "save_workflow_draft"]
        : ["dry_run_workflow"],
      ...(latestPreview ? { details: latestPreview } : {}),
      data: buildGateError(fullDraft, {
        error_code: previewFailed ? "preview_failed" : "workflow_not_ready",
        message: previewFailed
          ? "preview failed — re-run dry_run_workflow, or call save_workflow_draft again with force_commit: true after the operator explicitly confirms"
          : "workflow commit is blocked until dry_run_workflow has produced a fresh preview",
        stale_checkpoints: previewFailed ? [] : ["workflow_previewed"],
        recommended_mode: "workflow",
        next_best_actions: previewFailed
          ? ["dry_run_workflow", "ask_user_confirm", "save_workflow_draft"]
          : ["dry_run_workflow"],
        extra: {
          latest_preview: latestPreview ?? null,
          force_commit_available: previewFailed === true,
        },
      }),
    };
  }

  const draft = getWorkflowDraft(fullDraft);
  const def = {
    name: draft.name,
    ...(draft.slug ? { slug: draft.slug } : {}),
    ...(draft.description ? { description: draft.description } : {}),
    ...(draft.input_schema ? { input_schema: draft.input_schema } : {}),
    ...(draft.output_schema ? { output_schema: draft.output_schema } : {}),
    steps: draft.steps,
  };

  // tenant-filter:exempt — tenant-scoped via conversation_id parent FK
  const convRows = await ctx.db
    .select({ target_workflow_id: conversations.target_workflow_id })
    .from(conversations)
    .where(eq(conversations.id, ctx.conversation_id))
    .limit(1);
  let targetWorkflowId = convRows[0]?.target_workflow_id ?? null;

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
                "Otherwise rename the draft (update_param / build_workflow with a fresh slug) and re-validate before committing.",
            },
          },
        }),
      };
    }
  }

  // Per-step authoring vocabulary captured from the most recent
  // dry_run / run on this draft. Persisted next to the DAG so a
  // follow-up authoring session can call inspect_workflow /
  // suggest_jsonata_paths without re-running the workflow. Empty
  // map when no preview was recorded — never undefined, so the
  // column distinguishes "no preview" from "scope explicitly empty".
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
                      "Otherwise rename the draft (update_param / build_workflow with a fresh slug) and re-validate before committing.",
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
        kind: "auto_persist",
        ...(p.commitIntentKind ? { commit_intent_kind: p.commitIntentKind } : {}),
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
      slug: workflow.slug,
      name: workflow.name,
    },
    committed_workflow_id: workflow.id,
  };
}
