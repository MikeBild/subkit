// Atomic workflow commit — extracted from `tools/commit-draft.ts` so
// both the LLM-driven tool path AND the harness-driven auto-persist
// path share one durability contract (PR11/PR12 — elicitation
// `commit_intent`).
//
// The prior-approval gate (`ask_user_confirm{kind:commit_draft}`) is
// the tool's job — by the time the harness auto-persist path lands
// here, the operator has ALREADY confirmed via the carrier
// elicitation, so the gate would just re-detect the same row and
// pass. We accept an explicit `skipPriorApprovalCheck` so callers can
// document intent.

import { and, desc, eq, isNull, sql } from "drizzle-orm";
import { recordWorkflowCreated, recordWorkflowUpdated } from "../../audit/recorders/index.ts";
import { conversationElicitations, conversations, workflows } from "../../db/schema/index.ts";
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
          sql`(${conversationElicitations.input} ->> 'kind') = 'commit_draft'`,
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
      return {
        ok: false,
        data: buildGateError(ctx.getDraft(), {
          error_code: "no_prior_approval",
          message:
            "commit_draft requires a resolved ask_user_confirm { kind: commit_draft, confirmed: true }",
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
  const staleCheckpoints = missingFreshCheckpoints(fullDraft, [
    "workflow_inspected",
    "workflow_validated",
  ]);
  const blocking_reasons = [
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
        ? "the most recent dry-run was unsuccessful — re-run dry_run_workflow successfully, or call commit_draft again with force_commit: true after the operator explicitly confirms"
        : "workflow commit is blocked until a successful dry_run_workflow has run",
      next_best_actions: previewFailed
        ? ["dry_run_workflow", "ask_user_confirm", "commit_draft"]
        : ["dry_run_workflow"],
      ...(latestPreview ? { details: latestPreview } : {}),
      data: buildGateError(fullDraft, {
        error_code: previewFailed ? "preview_failed" : "workflow_not_ready",
        message: previewFailed
          ? "preview failed — re-run dry_run_workflow, or call commit_draft again with force_commit: true after the operator explicitly confirms"
          : "workflow commit is blocked until dry_run_workflow has produced a fresh preview",
        stale_checkpoints: previewFailed ? [] : ["workflow_previewed"],
        recommended_mode: "workflow",
        next_best_actions: previewFailed
          ? ["dry_run_workflow", "ask_user_confirm", "commit_draft"]
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

  const convRows = await ctx.db
    .select({ target_workflow_id: conversations.target_workflow_id })
    .from(conversations)
    .where(eq(conversations.id, ctx.conversation_id))
    .limit(1);
  let targetWorkflowId = convRows[0]?.target_workflow_id ?? null;

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
                "After the user confirms in chat, call commit_draft again with target_workflow_id=<conflict.workflow_id>",
              rename:
                "Otherwise rename the draft (update_param / build_workflow with a fresh slug) and re-validate before committing.",
            },
          },
        }),
      };
    }
  }

  let result: Awaited<ReturnType<typeof createWorkflow>>;
  try {
    if (targetWorkflowId) {
      result = await updateWorkflow(
        { tenant_id: ctx.tenant_id, id: targetWorkflowId, def, actor_id: ctx.actor_id },
        ctx.db,
      );
    } else {
      result = await createWorkflow(
        { tenant_id: ctx.tenant_id, def, actor_id: ctx.actor_id },
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
                  ? `slug "${attempted}" belongs to workflow id=${existing.id}. To overwrite it, ask the user, then call commit_draft with target_workflow_id="${existing.id}". Otherwise rename the draft slug.`
                  : `slug "${attempted}" already exists for this tenant — pick a different slug and call commit_draft again`,
              },
            ],
            attempted_slug: attempted,
            ...(existing ? { conflict: { workflow_id: existing.id, slug: existing.slug } } : {}),
            ...(existing
              ? {
                  recovery: {
                    overwrite: `After the user confirms in chat, call commit_draft again with target_workflow_id="${existing.id}"`,
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
