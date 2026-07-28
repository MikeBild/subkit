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
// The LLM-facing tool name is intentionally asymmetric with
// `save_connector_draft`. Renaming this tool to `save_workflow_draft`
// requires coordinated updates across ~100 files (mcp catalog, intent
// detector, authoring palette, state gate, tool policies, build
// workflow, mock provider, plus tests, journey fixtures, and seed
// skill bodies) and so is sequenced as its own change.

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
    'No silent webhook teardown: updating a workflow whose trigger drops from `webhook` to anything else refuses with `webhook_trigger_removal_unconfirmed` (it would DELETE the live public ingress hook). If the webhook should stay, restore `trigger: { kind: "webhook", … }` via edit_workflow_patch and re-run dry_run_workflow. If removal is intended, confirm with the user, then re-call with force_commit: true.',
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

    // Idempotency lives one layer down: `updateWorkflow` compares the
    // normalised def against the current version's dag and skips the
    // version rotate when they match. Both the dry-run auto-persist and
    // this re-issue tool route through it, so an unchanged draft never
    // appends a redundant workflow_version (which would also unbind the
    // workflow's schedules).
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

    // Snapshot the draft target before commit so it can be echoed in the
    // result envelope even on the already_persisted / error paths. The
    // 'edited the wrong draft' bug occurred because the model had no
    // authoritative signal about which draft was being mutated — surfacing
    // draft_target on every save response closes that gap.
    const draftSlug = draftSnapshot.slug ?? null;
    const draftName = draftSnapshot.name ?? null;

    // Same predicate the gate itself applies — see commit-workflow.ts. When it
    // is true nobody approved this commit, and both the reason and the flag
    // below have to say so.
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
    // commitWorkflowAtomic emits an audit row only when
    // emitAutoPersistAudit=true (harness path). The tool path adds its
    // own row here so operators triaging the audit log can tell the two
    // paths apart. `manual_re_issue` is only honest when a human actually
    // stood behind the call: under `permission_mode=auto` the prior-approval
    // gate was skipped, so the row says that instead — and carries the flag,
    // because "did anyone approve this commit?" must be answerable from the
    // audit log alone.
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
    // Idempotent re-commit: when commitWorkflowAtomic detected the def
    // was unchanged from the current version, nothing was written — do
    // not emit a `manual_re_issue` audit row for a no-op. Mirrors the
    // `already_persisted` short-circuit in save-connector-draft.ts.
    const alreadyPersisted = data.already_persisted === true;
    if (workflow_id && !alreadyPersisted) {
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
    // Resolve the authoritative slug/id from the commit result — the
    // committed slug is canonical; fall back to the draft snapshot values
    // captured before the commit for the already_persisted path.
    const resolvedSlug = typeof data.slug === "string" ? data.slug : draftSlug;
    const resolvedId = workflow_id;
    const resolvedName = typeof data.name === "string" ? data.name : draftName;

    return {
      ok: true,
      data: {
        // `data` from commitWorkflowAtomic already carries the usage
        // block plus next_best_actions / next_prompt — do not re-stamp
        // them here or the usage.follow_up gets clobbered.
        ...data,
        // Always surface the active draft target so the model and
        // operator can confirm which workflow was mutated. Closes the
        // 'edited the wrong draft' failure class.
        draft_target: {
          id: resolvedId,
          slug: resolvedSlug,
          name: resolvedName,
        },
        re_issued: true,
        audit_reason: auditReason,
        ...(warnings.length > 0 ? { warnings } : {}),
      },
      ...(typeof result.committed_workflow_id === "string"
        ? { committed_workflow_id: result.committed_workflow_id }
        : {}),
    };
  },
};
