import { z } from "@hono/zod-openapi";
import { and, eq } from "drizzle-orm";
import { recordWorkflowCommitted, recordWorkflowUpdated } from "../../audit/recorders/index.ts";
import { skills as skillsTable } from "../../db/schema/index.ts";
import { logger } from "../../logging/logger.ts";
import { getWorkflowDraft } from "../authoring-state.ts";
import {
  commitGateBypassedByAutoMode,
  commitWorkflowAtomic,
} from "../persistence/commit-workflow.ts";
import { auditActorFromToolContext } from "./audit-actor.ts";
import type { ConversationTool, ToolResult } from "./index.ts";
import { savedDraftReadiness } from "./saved-draft-readiness.ts";

const inputSchema = z
  .object({
    target_workflow_id: z
      .string()
      .optional()
      .describe(
        "Pin an intentional replacement to an existing workflow. Open that workflow in an authoring session first so its saved draft version is observed; replacing it requires the engine's human confirmation gate. This saves a new inactive draft only, never an active version.",
      ),
    force_commit: z
      .boolean()
      .default(false)
      .describe(
        "Persist the draft even if the most recent dry-run preview was unsuccessful. Surfaces a warning in the response and tags the audit row with `kind: preview_override`. Use only when the operator explicitly confirms.",
      ),
    confirmed: z
      .boolean()
      .default(false)
      .describe(
        'Required when the draft\'s `derived_from_skill_id` resolves to a skill with `side_effects: "destructive"`. Surface the destructive-skill banner to the operator first; pass `true` only after explicit operator confirmation in chat.',
      ),
  })
  .openapi("SaveWorkflowDraftToolInput");

export const saveWorkflowDraftTool: ConversationTool = {
  name: "save_workflow_draft",
  description:
    "Save an immutable, inactive workflow draft after validation and preview. Sensitive definitions require fresh inspection and schema validation instead of a forbidden chat preview; runtime verification remains outstanding. In auto mode a green judged preview may already have saved it; do not repeat that save. Saving never activates a version, changes live schedules or webhooks, or grants execution authority. Force and explicit replacement remain human-gated.",
  use_case:
    "Persist validated authoring work, including recovery after an interrupted save. In ask/plan mode the existing save confirmation remains available; in auto mode ordinary draft preparation needs no human decision.",
  important_notes: [
    "In ask/plan mode, refuses with `no_prior_approval` until the matching save confirmation is resolved. Ordinary saves in auto mode do not require it.",
    "Before saving, inspect and validate the current draft. Ordinary definitions also require dry_run_workflow with grounded inputs. Sensitive definitions can only be saved inertly without preview; do not execute them in chat, invent preview evidence, or use force_commit. On workflow_not_ready, complete the named missing checks automatically within current permissions. On preview_failed diagnose and repair first; exceptional eligible overrides remain explicitly human-gated.",
    "Idempotent: unchanged definition and preview shape hints return the same saved draft version without writing. Changed hints receive a new immutable version.",
    "Update-in-place semantics: if the conversation has a target_workflow_id, appends a new workflow_version to that row. The slug of the existing workflow stays authoritative; changing draft.slug does not rename the workflow.",
    "No silent slug-adoption: a different workflow's slug produces slug_conflict_with_live_workflow. Rename the draft or open that workflow to observe its saved draft before requesting a human-approved replacement. A force flag cannot replace an observed version.",
    "Saving changed triggers does not alter existing live webhook or schedule bindings. Review and activate the exact saved version separately; repeated live runs require bounded execution authority.",
    "Writes one `manual_re_issue`-tagged audit row in addition to the workflow_created/updated row emitted by the workflow service.",
  ],
  inputSchema,
  category: "draft_write" as const,
  authoring_resource: "workflow",
  async execute(ctx, rawArgs): Promise<ToolResult> {
    const args = inputSchema.parse(rawArgs);
    logger.info({
      module: "conversation_tool",
      action: "save_workflow_draft.started",
      tenant_id: ctx.tenant_id,
      conversation_id: ctx.conversation_id,
      target_workflow_id: args.target_workflow_id ?? null,
      force_commit: args.force_commit === true,
    });

    const fullDraft = ctx.getDraft();
    const draftSnapshot = getWorkflowDraft(fullDraft);

    const derivedFromSkillId = (draftSnapshot as { derived_from_skill_id?: string | null })
      .derived_from_skill_id;
    if (derivedFromSkillId && !args.confirmed) {
      const skillRows = await ctx.db
        .select({ side_effects: skillsTable.side_effects, title: skillsTable.title })
        .from(skillsTable)
        .where(
          and(eq(skillsTable.tenant_id, ctx.tenant_id), eq(skillsTable.slug, derivedFromSkillId)),
        )
        .limit(1);
      const skillRow = skillRows[0];
      if (skillRow && skillRow.side_effects === "destructive") {
        return {
          ok: false,
          error_code: "destructive_skill_confirmation_required",
          message: `workflow derives from skill \`${derivedFromSkillId}\` (${skillRow.title}) which is marked side_effects:"destructive". Surface the destructive-skill banner to the operator and re-issue with confirmed: true after explicit chat confirmation.`,
          next_best_actions: ["save_workflow_draft"],
          data: { derived_from_skill_id: derivedFromSkillId, side_effects: "destructive" },
        };
      }
    }

    const draftSlug = draftSnapshot.slug ?? null;
    const draftName = draftSnapshot.name ?? null;

    const gateBypassed = commitGateBypassedByAutoMode({ permission_mode: ctx.permission_mode });
    const auditReason = gateBypassed ? "auto_mode_no_prior_approval" : "manual_re_issue";

    const result = await commitWorkflowAtomic({
      ctx,
      forceCommit: args.force_commit,
      reason: auditReason,
      ...(args.target_workflow_id ? { target_workflow_id: args.target_workflow_id } : {}),
    });
    if (!result.ok) {
      return result;
    }
    const data =
      typeof result.data === "object" && result.data !== null
        ? (result.data as Record<string, unknown>)
        : {};
    const workflow_id =
      typeof data.workflow_id === "string"
        ? data.workflow_id
        : typeof result.committed_workflow_id === "string"
          ? result.committed_workflow_id
          : null;
    const workflow_version_id =
      typeof data.workflow_version_id === "string" ? data.workflow_version_id : null;
    const version = typeof data.version === "number" ? data.version : null;
    const previewOverride = args.force_commit === true && fullDraft.latest_preview?.ok !== true;
    const alreadyPersisted = data.already_persisted === true;
    if (workflow_id && !alreadyPersisted) {
      if (previewOverride) {
        await recordWorkflowCommitted({
          tenant_id: ctx.tenant_id,
          ...auditActorFromToolContext(ctx),
          executor: ctx.db,
          workflow_id,
          workflow_version_id,
          version,
          reason: "force_save_override",
          source: "tool_call",
          tool: "save_workflow_draft",
          latest_preview_summary: fullDraft.latest_preview?.summary ?? null,
          latest_preview_warnings: fullDraft.latest_preview?.warnings ?? [],
        });
      } else {
        await recordWorkflowUpdated({
          tenant_id: ctx.tenant_id,
          ...auditActorFromToolContext(ctx),
          executor: ctx.db,
          workflow_id,
          slug: typeof data.slug === "string" ? data.slug : "",
          version,
          workflow_version_id,
          reason: auditReason,
          source: "tool_call",
          kind: "save_via_tool",
          tool: "save_workflow_draft",
          ...(gateBypassed ? { bypassed_prior_approval: true } : {}),
        });
      }
    }
    logger.info({
      module: "conversation_tool",
      action: "save_workflow_draft.re_issued",
      tenant_id: ctx.tenant_id,
      conversation_id: ctx.conversation_id,
      workflow_id,
      version,
      kind: previewOverride ? "preview_override" : "save_via_tool",
    });
    const warnings: string[] = [];
    if (previewOverride) {
      const failureCode = fullDraft.latest_preview?.warnings?.[0]?.code ?? "preview_failed";
      warnings.push(
        `force_commit: workflow saved with a failed preview (${failureCode}). Audit reason: manual_re_issue, kind: preview_override.`,
      );
    }
    const readiness = workflow_id ? await savedDraftReadiness(ctx, workflow_id) : null;
    const resolvedSlug = typeof data.slug === "string" ? data.slug : draftSlug;
    const resolvedId = workflow_id;
    const resolvedName = typeof data.name === "string" ? data.name : draftName;

    return {
      ok: true,
      data: {
        ...data,
        draft_target: {
          id: resolvedId,
          slug: resolvedSlug,
          name: resolvedName,
        },
        re_issued: true,
        audit_reason: auditReason,
        ...(readiness ? { automation_readiness: readiness } : {}),
        ...(warnings.length > 0 ? { warnings } : {}),
      },
      ...(typeof result.committed_workflow_id === "string"
        ? { committed_workflow_id: result.committed_workflow_id }
        : {}),
    };
  },
};
