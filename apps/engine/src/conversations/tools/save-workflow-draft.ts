// save_workflow_draft — diagnostic re-issue path for workflow drafts.
//
// The normal commit path is the harness auto-persist on
// `ask_user_confirm` of the dry-run preview (driven by
// `elicitations.ts` → `commitWorkflowAtomic` with
// `reason: "auto_persist_on_confirmation"`). This tool stays
// available for legitimate re-issue cases:
//   - re-committing after an aborted save,
//   - reverting + re-applying an edit,
//   - force-committing after a failed dry-run by passing
//     `force_commit: true`.
//
// The audit row emitted from this tool path carries
// `reason: "manual_re_issue"`. That distinction lets operators tell
// the two writes apart in the audit trail.
//
// TODO(bug-6 follow-up): the LLM-facing tool name should become
// `save_workflow_draft` to match the symmetric `save_connector_draft`
// surface. This is a wide rename (~100 files: mcp catalog, intent
// detector, authoring palette, state gate, tool policies, build
// workflow, mock provider, plus the corresponding tests + journey
// fixtures + seed skill bodies). Tracked separately so it lands as
// one cohesive commit instead of bleeding through five bug fixes.

import { createHash } from "node:crypto";
import { z } from "@hono/zod-openapi";
import { and, eq } from "drizzle-orm";
import { recordWorkflowCommitted, recordWorkflowUpdated } from "../../audit/recorders/index.ts";
import { conversations, skills as skillsTable } from "../../db/schema/index.ts";
import { logger } from "../../logging/logger.ts";
import { getWorkflow } from "../../workflows/service.ts";
import { getWorkflowDraft } from "../authoring-state.ts";
import { commitWorkflowAtomic } from "../persistence/commit-workflow.ts";
import type { ConversationTool, ToolResult } from "./index.ts";

const inputSchema = z
  .object({
    target_workflow_id: z
      .string()
      .optional()
      .describe(
        "Explicitly pin the save target to an existing workflow id. Only set this AFTER the user has confirmed in chat that they want to overwrite that workflow — e.g. after a slug_conflict_with_live_workflow error where the user said 'yes, update it'. Otherwise leave unset.",
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
    "Diagnostic re-issue for workflow drafts. The normal commit path is the harness auto-persist on `ask_user_confirm` of the dry-run preview. Only call this tool to re-commit (revert + re-apply, force-commit after a failed dry_run, etc.).",
  use_case:
    "Diagnostic re-issue when the operator wants to re-apply a draft (revert + re-commit, slug-conflict adoption, force-commit after a failed dry-run). The harness auto-persist on `ask_user_confirm` is the normal commit path; this tool is for the recovery cases the harness can't cover.",
  important_notes: [
    "Refuses with `no_prior_approval` if no matching ask_user_confirm has been answered in this conversation.",
    "Refuses with `workflow_not_ready` until inspect_workflow_draft and validate_draft are fresh; with `preview_failed` if the most recent dry-run failed (pass `force_commit: true` after the operator confirms to override).",
    "Idempotent: if the conversation's target workflow already has a version with the same content hash, returns `already_persisted: true` without writing.",
    "Update-in-place semantics: if the conversation has a target_workflow_id, appends a new workflow_version to that row. The slug of the existing workflow stays authoritative; changing draft.slug does not rename the workflow.",
    "No silent slug-adoption: a draft.slug colliding with a different live workflow produces slug_conflict_with_live_workflow. To overwrite, ask the user explicitly, then call save_workflow_draft again with target_workflow_id=<conflict.workflow_id>.",
    "Writes one `manual_re_issue`-tagged audit row in addition to the workflow_created/updated row emitted by the workflow service.",
  ],
  inputSchema,
  category: "draft_write" as const,
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

    // Idempotency: if the conversation's target workflow already
    // exists and its current_version dag hashes to the same value as
    // the draft, the auto-persist (or a prior re-issue) already
    // applied this exact write. Return `already_persisted: true`
    // instead of appending a redundant workflow_version. We do this
    // BEFORE the prior-approval gate so a redundant approve+commit
    // cycle can also short-circuit cleanly.
    const fullDraft = ctx.getDraft();
    const draftSnapshot = getWorkflowDraft(fullDraft);

    // Destructive-skill confirmation gate. When the draft was cloned
    // from a recipe whose backing skill declares
    // `side_effects: "destructive"`, refuse to commit unless the LLM
    // re-issued with `confirmed: true`. The conversation banner
    // (rendered by the context assembler from the loaded skill) is
    // the operator-facing prompt that authorises this flag.
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

    const draftDef = {
      name: draftSnapshot.name,
      ...(draftSnapshot.slug ? { slug: draftSnapshot.slug } : {}),
      ...(draftSnapshot.description ? { description: draftSnapshot.description } : {}),
      ...(draftSnapshot.input_schema ? { input_schema: draftSnapshot.input_schema } : {}),
      ...(draftSnapshot.output_schema ? { output_schema: draftSnapshot.output_schema } : {}),
      steps: draftSnapshot.steps,
    };
    const draftHash = hashWorkflowDef(draftDef);
    let targetForIdempotency: string | null = args.target_workflow_id ?? null;
    if (!targetForIdempotency) {
      const convRows = await ctx.db
        .select({ target_workflow_id: conversations.target_workflow_id })
        .from(conversations)
        .where(
          and(
            eq(conversations.tenant_id, ctx.tenant_id),
            eq(conversations.id, ctx.conversation_id),
          ),
        )
        .limit(1);
      targetForIdempotency = convRows[0]?.target_workflow_id ?? null;
    }
    if (targetForIdempotency) {
      const existing = await getWorkflow(ctx.tenant_id, targetForIdempotency, ctx.db);
      if (existing?.current_version_id) {
        const existingDef = existing.definition;
        const existingHash = hashWorkflowDef({
          name: existingDef.name,
          ...(existingDef.slug ? { slug: existingDef.slug } : {}),
          ...(existingDef.description ? { description: existingDef.description } : {}),
          ...(existingDef.input_schema ? { input_schema: existingDef.input_schema } : {}),
          ...(existingDef.output_schema ? { output_schema: existingDef.output_schema } : {}),
          steps: existingDef.steps,
        });
        if (existingHash === draftHash) {
          logger.info({
            module: "conversation_tool",
            action: "save_workflow_draft.already_persisted",
            tenant_id: ctx.tenant_id,
            conversation_id: ctx.conversation_id,
            workflow_id: existing.id,
            version: existing.current_version,
          });
          return {
            ok: true,
            data: {
              already_persisted: true,
              workflow_id: existing.id,
              workflow_version_id: existing.current_version_id,
              version: existing.current_version,
              slug: existing.slug,
              name: existing.name,
              next_best_actions: ["inspect_workflow", "list_workflows"],
            },
            committed_workflow_id: existing.id,
          };
        }
      }
    }

    const result = await commitWorkflowAtomic({
      ctx,
      forceCommit: args.force_commit,
      reason: "manual_re_issue",
      ...(args.target_workflow_id ? { target_workflow_id: args.target_workflow_id } : {}),
    });
    if (!result.ok) {
      return result;
    }
    // commitWorkflowAtomic emits an audit row only when
    // emitAutoPersistAudit=true (harness path). The tool path adds its
    // own `manual_re_issue` row here so operators triaging the audit
    // log can tell the two paths apart.
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
    const previewOverride =
      args.force_commit === true &&
      (!fullDraft.latest_preview || fullDraft.latest_preview.ok !== true);
    if (workflow_id) {
      if (previewOverride) {
        await recordWorkflowCommitted({
          tenant_id: ctx.tenant_id,
          actor_id: ctx.actor_id,
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
          actor_id: ctx.actor_id,
          executor: ctx.db,
          workflow_id,
          slug: typeof data.slug === "string" ? data.slug : "",
          version,
          workflow_version_id,
          reason: "manual_re_issue",
          source: "tool_call",
          kind: "save_via_tool",
          tool: "save_workflow_draft",
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
    return {
      ok: true,
      data: {
        ...data,
        re_issued: true,
        audit_reason: "manual_re_issue",
        ...(warnings.length > 0 ? { warnings } : {}),
      },
      ...(typeof result.committed_workflow_id === "string"
        ? { committed_workflow_id: result.committed_workflow_id }
        : {}),
    };
  },
};

/**
 * Stable hash of a workflow definition. Used by the idempotency check
 * so a re-issue against an unchanged draft is a no-op.
 *
 * Sorted-key JSON so {"a":1,"b":2} and {"b":2,"a":1} hash equal — the
 * workflow service produces canonical orderings, but a draft authored
 * field-by-field by the LLM may interleave keys differently.
 */
function hashWorkflowDef(def: unknown): string {
  return createHash("sha256").update(stableStringify(def)).digest("hex");
}

function stableStringify(value: unknown): string {
  if (value === null || typeof value !== "object") return JSON.stringify(value);
  if (Array.isArray(value)) {
    return `[${value.map((v) => stableStringify(v)).join(",")}]`;
  }
  const obj = value as Record<string, unknown>;
  const keys = Object.keys(obj).sort();
  const entries = keys.map((k) => `${JSON.stringify(k)}:${stableStringify(obj[k])}`);
  return `{${entries.join(",")}}`;
}
