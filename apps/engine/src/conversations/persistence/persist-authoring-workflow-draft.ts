import { and, eq, isNull } from "drizzle-orm";
import { conversations, workflows } from "../../db/schema/index.ts";
import { saveWorkflowDraft } from "../../workflows/drafts.ts";
import { detectSchedulePhrases } from "../../workflows/schedule-phrase-detector.ts";
import { persistedWorkflowResource } from "../authoring-state/summary.ts";
import { withWorkflowPersisted } from "../authoring-state.ts";
import { buildGateError, buildPersistencePayload } from "../tools/authoring-contract.ts";
import type { ToolContext, ToolResult } from "../tools/index.ts";
import type { DraftDocument } from "../types.ts";
import type { WorkflowDefFromDraft } from "./commit-workflow.ts";
import { proposeAuthoringCapabilityCandidate } from "./commit-workflow-skill-candidate.ts";

/** Saving authoring work has no activation, trigger or execution side effect. */
export async function persistAuthoringWorkflowDraft(input: {
  ctx: ToolContext;
  fullDraft: DraftDocument;
  def: WorkflowDefFromDraft;
  explicitTarget?: string;
  auditMetadata?: Record<string, unknown>;
}): Promise<ToolResult> {
  const { ctx, fullDraft } = input;
  const bound = fullDraft.state ? persistedWorkflowResource(fullDraft.state) : null;
  const [conversation] = await ctx.db
    .select({ target: conversations.target_workflow_id })
    .from(conversations)
    .where(
      and(eq(conversations.tenant_id, ctx.tenant_id), eq(conversations.id, ctx.conversation_id)),
    )
    .limit(1);
  let targetId = input.explicitTarget ?? conversation?.target ?? bound?.id ?? null;
  const fail = (code: string, message: string, extra?: Record<string, unknown>): ToolResult => ({
    ok: false,
    error_code: code,
    data: buildGateError(fullDraft, {
      error_code: code,
      message,
      recommended_mode: "workflow",
      next_best_actions: ["inspect_workflow_draft"],
      ...(extra ? { extra } : {}),
    }),
  });
  let def = input.def;
  if (targetId) {
    const [target] = await ctx.db
      .select({ id: workflows.id, slug: workflows.slug })
      .from(workflows)
      .where(
        and(
          eq(workflows.tenant_id, ctx.tenant_id),
          eq(workflows.id, targetId),
          isNull(workflows.deleted_at),
        ),
      )
      .limit(1);
    if (!target)
      return fail(
        "target_workflow_not_found",
        "The target workflow does not exist in this tenant.",
      );
    if (!input.explicitTarget && def.slug && def.slug !== target.slug) targetId = null;
    else def = { ...def, slug: target.slug };
  }
  if (targetId && (bound?.id !== targetId || bound.draft_version_id === undefined)) {
    return fail(
      "draft_base_not_observed",
      "Open this workflow in an authoring session before replacing its draft. The saved draft version must be observed; an active version or a force flag cannot substitute for it. Existing local edits have not been changed.",
    );
  }
  const scope_index: NonNullable<Parameters<typeof saveWorkflowDraft>[0]["scope_index"]> = {};
  for (const trace of fullDraft.latest_preview?.step_traces ?? []) {
    if (!trace.scope_at_step) continue;
    scope_index[trace.step_id] = {
      available_paths: trace.scope_at_step.available_paths ?? [],
      shape_summary: trace.scope_at_step.shape_summary ?? "unknown",
      primary_data_path: trace.scope_at_step.primary_data_path ?? null,
    };
  }
  const result = await saveWorkflowDraft(
    {
      tenant_id: ctx.tenant_id,
      ...(targetId
        ? { workflow_id: targetId, expected_draft_version_id: bound?.draft_version_id ?? null }
        : {}),
      def,
      scope_index: Object.keys(scope_index).length ? scope_index : null,
      actor_id: ctx.actor_id,
      request_source: "tool-chain",
      ...(input.auditMetadata ? { audit_metadata: input.auditMetadata } : {}),
    },
    ctx.db,
  );
  if (!result.draft) {
    if (result.code === "slug_conflict") {
      const [conflict] = def.slug
        ? await ctx.db
            .select({ workflow_id: workflows.id, slug: workflows.slug, name: workflows.name })
            .from(workflows)
            .where(
              and(
                eq(workflows.tenant_id, ctx.tenant_id),
                eq(workflows.slug, def.slug),
                isNull(workflows.deleted_at),
              ),
            )
            .limit(1)
        : [];
      return fail(
        "slug_conflict_with_live_workflow",
        "This slug belongs to another workflow. No draft was overwritten. Choose a different slug, or open the existing workflow in an authoring session and request human approval before replacing its observed draft.",
        {
          attempted_slug: def.slug ?? null,
          ...(conflict ? { conflict } : {}),
          recovery: {
            rename: "Rename this draft and validate it again.",
            overwrite:
              "Open the existing workflow to observe its draft version; replacing it remains a human-approved action.",
          },
        },
      );
    }
    return fail(result.code, result.errors.join("; "));
  }
  const saved = result.draft;
  const changed = saved.version_id !== bound?.draft_version_id;
  const nextDraft = withWorkflowPersisted(
    fullDraft,
    {
      kind: "workflow",
      id: saved.workflow_id,
      slug: saved.definition.slug ?? null,
      name: saved.definition.name,
      version_id: saved.version_id,
      version: saved.version,
      draft_version_id: saved.version_id,
      current_version_id: saved.current_version_id,
      persistence_kind: "draft",
      environment: null,
      saved_at: new Date().toISOString(),
    },
    "workflow_draft_saved",
  );
  await ctx.db
    .update(conversations)
    .set({ target_workflow_id: saved.workflow_id, status: "active", updated_at: new Date() })
    .where(
      and(eq(conversations.tenant_id, ctx.tenant_id), eq(conversations.id, ctx.conversation_id)),
    );
  await ctx.setDraft(nextDraft);
  // A proposed capability remains preparation. Keep the existing useful
  // authoring summary, but bind it to the saved draft and explicitly state
  // that approving a skill cannot activate or authorize that workflow.
  const candidateNotice = changed
    ? await proposeAuthoringCapabilityCandidate({
        db: ctx.db,
        tenant_id: ctx.tenant_id,
        conversation_id: ctx.conversation_id,
        workflow: {
          id: saved.workflow_id,
          slug: saved.definition.slug ?? saved.workflow_id,
          name: saved.definition.name,
        },
        def,
        scope_index,
        draft_version_id: saved.version_id,
      })
    : null;
  const cadence =
    !saved.definition.trigger || saved.definition.trigger.kind === "request"
      ? detectSchedulePhrases({
          name: saved.definition.name,
          description: saved.definition.description ?? null,
        })
      : null;
  const scheduleWarning = cadence?.matched
    ? "WARNING: the draft names a recurring cadence but has NO schedule trigger declared. Saving this draft did not activate it. Declare the intended trigger before requesting activation."
    : null;
  return {
    ok: true,
    ...(changed ? { committed_workflow_id: saved.workflow_id } : {}),
    data: {
      ...buildPersistencePayload(nextDraft, {
        resource_kind: "workflow",
        resource_id: saved.workflow_id,
        version_id: saved.version_id,
      }),
      workflow_id: saved.workflow_id,
      workflow_version_id: saved.version_id,
      version: saved.version,
      digest: saved.digest,
      slug: saved.definition.slug ?? null,
      name: saved.definition.name,
      version_changed: changed,
      already_persisted: !changed,
      persistence_kind: "draft",
      activation_required: true,
      current_version_id: saved.current_version_id,
      ...(scheduleWarning ? { schedule_warning: scheduleWarning } : {}),
      next_best_actions: ["inspect_workflow_draft", "dry_run_workflow"],
      next_prompt: [
        scheduleWarning,
        "The exact draft version is saved but is not activated. Review its version and effects before human activation; no schedule, webhook or live execution was enabled by this save.",
        candidateNotice,
      ]
        .filter(Boolean)
        .join("\n"),
    },
  };
}
