import { z } from "zod";
import type { ResolvedPrincipal } from "../../auth/types.ts";
import { loadDraft } from "../../conversations/public/authoring.ts";
import { canReadTaskRun, getConversation } from "../../conversations/public/lifecycle.ts";
import {
  buildWorkflowUsage,
  classifyDraftVsPersisted,
  persistedWorkflowResource,
} from "../../conversations/public/tool-contract.ts";
import type { Db } from "../../db/client.ts";
import { getWorkflowDraft } from "../../workflows/drafts.ts";
import { getWorkflow, getWorkflowBySlug } from "../../workflows/service.ts";
import type { HandleConversationToolResult } from "./conversations.ts";

const CommitResult = z.object({
  conversation_id: z.string(),
  workflow_id: z.string(),
  status: z.string(),
  persistence_kind: z.enum(["draft", "active"]),
  activation_required: z.boolean(),
  current_version_id: z.string().nullable(),
  committed: z.object({
    workflow_version_id: z.string(),
    version: z.number().int(),
    steps_present: z.number().int(),
    slug: z.string(),
    name: z.string(),
    updated_at: z.string(),
  }),
  draft_state: z.enum(["clean", "empty_draft"]),
  verified_against_draft: z.boolean(),
  note: z.string().optional(),
  usage: z.unknown().optional(),
});

export async function readConversationCommit(
  db: Db,
  principal: ResolvedPrincipal,
  conversation_id: string,
): Promise<HandleConversationToolResult> {
  if (!(await canReadTaskRun(db, { tenant_id: principal.tenant_id, conversation_id, principal })))
    return errorText("conversation not found");
  const detail = await getConversation(principal.tenant_id, conversation_id, db);
  if (!detail) return errorText("conversation not found");

  const draft = await loadDraft(principal.tenant_id, detail.conversation.id, db);

  let workflowId = detail.conversation.target_workflow_id;
  if (!workflowId) {
    const bound = draft.state ? persistedWorkflowResource(draft.state) : null;
    const resolved = bound?.id
      ? await getWorkflow(principal.tenant_id, bound.id, db)
      : bound?.slug
        ? await getWorkflowBySlug(principal.tenant_id, bound.slug, db)
        : null;
    if (resolved) workflowId = resolved.id;
  }
  if (!workflowId) {
    return errorText("conversation has no committed workflow");
  }
  const draftState = await classifyDraftVsPersisted(db, principal.tenant_id, draft, workflowId);
  if (draftState.state === "structural") {
    return errorText(
      "NOT COMMITTED: this conversation's working draft or observed version differs from the saved draft. conversation_commit only reports status; it does not persist or activate. Review the current saved draft before saving edits with save_workflow_draft after a successful dry_run_workflow. For a metadata-only change (name/description/lifecycle), call update_workflow. Do not report a completed save until the save tool returns ok.",
    );
  }
  if (draftState.state === "no_target" && draftState.reason === "no_persisted_version") {
    return errorText(
      "NOT COMMITTED: the resolved workflow has no persisted version — nothing was written. conversation_commit only reports status; to persist the draft call save_workflow_draft (after a successful dry_run_workflow). Do not tell the user it is committed.",
    );
  }
  if (draftState.state === "no_target" && draftState.reason === "unreadable_dag") {
    return errorText(
      "COMMIT UNVERIFIED: a persisted version exists but its stored definition could not be read, so the commit cannot be confirmed against it. Do not report success; inspect the workflow with get_workflow.",
    );
  }
  const committedWorkflow = await getWorkflow(principal.tenant_id, workflowId, db);
  if (!committedWorkflow) {
    return errorText(
      "NOT COMMITTED: the resolved workflow no longer exists (it may have been deleted). Nothing is committed for this conversation.",
    );
  }
  const savedDraft = await getWorkflowDraft(principal.tenant_id, workflowId, db);
  if (savedDraft) {
    const bound = draft.state ? persistedWorkflowResource(draft.state) : null;
    if (bound?.persistence_kind === "draft" && bound.version_id !== savedDraft.version_id) {
      return errorText(
        "NOT COMMITTED: the saved draft changed after this session observed it. Reload and review the new version before saving; no activation or execution authority was granted.",
      );
    }
    return successText(
      CommitResult.parse({
        conversation_id: detail.conversation.id,
        workflow_id: workflowId,
        status: detail.conversation.status,
        persistence_kind: "draft",
        activation_required: savedDraft.current_version_id !== savedDraft.version_id,
        current_version_id: savedDraft.current_version_id,
        committed: {
          workflow_version_id: savedDraft.version_id,
          version: savedDraft.version,
          steps_present: savedDraft.definition.steps.length,
          slug: committedWorkflow.slug,
          name: savedDraft.definition.name,
          updated_at: committedWorkflow.updated_at.toISOString(),
        },
        draft_state: draftState.state === "clean" ? "clean" : "empty_draft",
        verified_against_draft: draftState.state === "clean",
        note: "The exact draft is saved. Saving grants no activation or execution authority. Review the version and effects before activation; use dry_run_workflow for a preview.",
      }),
    );
  }
  if (!committedWorkflow.current_version_id || committedWorkflow.current_version == null) {
    return errorText(
      "NOT COMMITTED: the resolved workflow has no persisted version — nothing was written. conversation_commit only reports status; to persist the draft call save_workflow_draft (after a successful dry_run_workflow). Do not tell the user it is committed.",
    );
  }
  const verified = draftState.state === "clean";
  return successText(
    CommitResult.parse({
      conversation_id: detail.conversation.id,
      workflow_id: workflowId,
      status: detail.conversation.status,
      persistence_kind: "active",
      activation_required: false,
      current_version_id: committedWorkflow.current_version_id,
      committed: {
        workflow_version_id: committedWorkflow.current_version_id,
        version: committedWorkflow.current_version,
        steps_present: committedWorkflow.steps.length,
        slug: committedWorkflow.slug,
        name: committedWorkflow.name,
        updated_at: committedWorkflow.updated_at.toISOString(),
      },
      draft_state: verified ? "clean" : "empty_draft",
      verified_against_draft: verified,
      ...(verified
        ? {}
        : {
            note: "no draft content was compared against the persisted version — this reply reflects the persisted rows only, not a confirmation that this conversation's edits were written",
          }),
      usage: await buildWorkflowUsage(db, principal.tenant_id, {
        id: committedWorkflow.id,
        slug: committedWorkflow.slug,
        name: committedWorkflow.name,
        definition: committedWorkflow.definition,
      }),
    }),
  );
}

function successText(obj: unknown): HandleConversationToolResult {
  return { isError: false, content: [{ type: "text", text: JSON.stringify(obj) }] };
}

function errorText(msg: string): HandleConversationToolResult {
  return { isError: true, content: [{ type: "text", text: msg }] };
}
