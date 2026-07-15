// Read-only `/context` snapshot — projection over what the next
// prompt assembly would inject. No LLM calls.

import { and, asc, eq } from "drizzle-orm";
import type { Db } from "../../db/client.ts";
import { getConversationBudgetReport } from "../../llm/core/conversation-budget-report.ts";
import { computeGroundingStatus } from "../grounding-staleness.ts";
import { getConversation } from "./get.ts";

export interface ContextSnapshot {
  conversation_id: string;
  connector_id: string | null;
  workflow_id: string | null;
  draft_mode: string;
  authoring_mode: string | null;
  authoring_stage: string | null;
  draft_summary: {
    readiness: string;
    next_action: string | null;
    next_required_action: string | null;
    next_suggested_tool: string | null;
    missing_fields: string[];
    progress_label: string | null;
    lifecycle_state: string;
    blocked_by: string[];
  } | null;
  active_target: {
    kind: "connector" | "workflow" | "none";
    name: string | null;
    slug: string | null;
    id: string | null;
    environment: string | null;
    lifecycle_state: string;
  } | null;
  checkpoint_statuses: Array<{
    key: string;
    status: string;
    verified_at: string | null;
    verified_by_tool: string | null;
    ok: boolean | null;
    summary: string | null;
  }>;
  stale_checkpoints: string[];
  next_required_action: string | null;
  persisted_resources: Array<{
    kind: string;
    id: string;
    slug: string | null;
    name: string | null;
    version_id: string | null;
    version: number | null;
    environment: string | null;
    saved_at: string;
  }>;
  latest_execution: {
    execution_id: string;
    workflow_id: string | null;
    workflow_version_id: string | null;
    status: string;
    environment: string;
    warnings_count: number;
    recorded_at: string;
    diagnosis_available: boolean;
  } | null;
  latest_diagnosis: {
    execution_id: string;
    recorded_at: string;
    reason: string;
    warning_sources: Array<{ step_key: string; code: string; identifier: string | null }>;
    steps: Array<{
      step_key: string;
      kind: string;
      status: string;
      duration_ms: number | null;
      output_preview?: unknown;
      error?: unknown;
      request_meta?: unknown;
    }>;
  } | null;
  skills: {
    global: Array<{ id: string; title: string }>;
    connector: Array<{ id: string; title: string }>;
    workflow: Array<{ id: string; title: string }>;
    total: number;
  };
  messages: {
    total: number;
    last_role: string | null;
  };
  tool_calls_total: number;
  pending_elicitations: number;
  /**
   * Compact "what's in scope for the LLM right now" payload used by sk's
   * `/context` pane. Thin projections over state that already lives on
   * the draft or elsewhere — no extra DB reads beyond what
   * getConversation + retrieveApplicableSkills already pull.
   */
  attachments: {
    total: number;
    items: Array<{ slug: string; filename: string | null; bytes: number | null }>;
  };
  latest_probe: {
    ok: boolean;
    summary: string | null;
    failure_code: string | null;
    /** ISO-8601 timestamp the probe ran. Operators reading the
     *  `/context` snapshot use this with the cooldown gate
     *  (save-connector.ts) to see how stale a failed probe is. */
    probed_at: string | null;
  } | null;
  latest_preview: {
    ok: boolean;
    summary: string | null;
    step_id: string | null;
  } | null;
  workflow_version: {
    workflow_id: string;
    current_version: number | null;
  } | null;
  /** What the LAST assembled turn dropped to fit the model context —
   *  the in-band answer to "why doesn't the agent remember X?". Null
   *  when no turn ran since engine start (in-process cache — see
   *  llm/core/conversation-budget-report.ts). */
  last_context_budget: {
    cap_tokens: number;
    total_tokens: number;
    dropped_sections: string[];
    assembled_at: string;
  } | null;
  /** Whether the draft's grounding is still current, checked at resume.
   *  Advisory only — never blocks. `null` when the draft carries no
   *  grounding checkpoint. Real fresh/stale/unknown logic lands with the
   *  grounding-staleness feature; populated `null` until then. */
  grounding_status: {
    state: "fresh" | "stale" | "unknown";
    advisory: string | null;
  } | null;
}

/**
 * Read-only snapshot of the context the engine would inject if we
 * assembled a prompt right now. Powers the `/context` CLI panel —
 * skill counts / names in scope, recent activity, pending
 * elicitations. Does not invoke the LLM provider.
 */
export async function getContextSnapshot(
  tenant_id: string,
  conversation_id: string,
  exec: Db,
): Promise<ContextSnapshot | null> {
  const detail = await getConversation(tenant_id, conversation_id, exec);
  if (!detail) return null;

  const { retrieveApplicableSkills } = await import("../../skills/service.ts");
  const { listElicitationsForConversation } = await import("../elicitations.ts");

  const applicable = await retrieveApplicableSkills(
    {
      tenant_id,
      ...(detail.conversation.target_connector_id
        ? { connector_ids: [detail.conversation.target_connector_id] }
        : {}),
      ...(detail.conversation.target_workflow_id
        ? { workflow_ids: [detail.conversation.target_workflow_id] }
        : {}),
    },
    exec,
  );

  const elicitations = await listElicitationsForConversation(tenant_id, conversation_id, exec);
  const pending = elicitations.filter((e) => e.status === "pending").length;

  const byScope = {
    global: applicable
      .filter((s) => s.scope === "global")
      .map((s) => ({ id: s.id, title: s.title })),
    connector: applicable
      .filter((s) => s.scope === "connector")
      .map((s) => ({ id: s.id, title: s.title })),
    workflow: applicable
      .filter((s) => s.scope === "workflow")
      .map((s) => ({ id: s.id, title: s.title })),
  };

  const lastMessage = detail.messages[detail.messages.length - 1];

  // Attachments live on the unified `file_links` join; surface a count
  // + first few so the user sees what the LLM can reference inline.
  const { fileLinks, files } = await import("../../db/schema/index.ts");
  const attachmentRows = await exec
    .select({ link: fileLinks, file: files })
    .from(fileLinks)
    .innerJoin(files, eq(files.id, fileLinks.file_id))
    .where(
      and(
        eq(fileLinks.tenant_id, tenant_id),
        eq(fileLinks.resource_type, "conversation"),
        eq(fileLinks.resource_id, conversation_id),
      ),
    )
    .orderBy(asc(fileLinks.created_at));
  const attachmentItems = attachmentRows.slice(0, 10).map((a) => ({
    slug: a.link.slug ?? a.file.filename,
    filename: a.file.filename ?? null,
    bytes: typeof a.file.size_bytes === "number" ? a.file.size_bytes : null,
  }));

  // Latest probe + preview live on the draft; mirror into the snapshot
  // so the `/context` pane doesn't have to re-normalise the draft.
  const latestProbeRaw = detail.draft?.connector?.latest_probe ?? null;
  const latestProbe = latestProbeRaw
    ? {
        ok: latestProbeRaw.ok === true,
        summary: latestProbeRaw.summary ?? null,
        failure_code: latestProbeRaw.failure_code ?? null,
        probed_at: latestProbeRaw.probed_at ?? null,
      }
    : null;
  const latestPreviewRaw = detail.draft?.latest_preview ?? null;
  const latestPreview = latestPreviewRaw
    ? {
        ok: latestPreviewRaw.ok === true,
        summary: latestPreviewRaw.summary ?? null,
        step_id: latestPreviewRaw.step_id ?? null,
      }
    : null;
  const draftSummary = detail.draft?.summary ?? null;

  // Workflow version context for committed conversations — surfaces
  // the current version number for the bound workflow, so `/context`
  // can show operators where they are on the version timeline.
  let workflowVersion: ContextSnapshot["workflow_version"] = null;
  if (detail.conversation.target_workflow_id) {
    try {
      const { getWorkflow } = await import("../../workflows/service.ts");
      const wf = await getWorkflow(tenant_id, detail.conversation.target_workflow_id, exec);
      workflowVersion = {
        workflow_id: detail.conversation.target_workflow_id,
        current_version:
          wf && "current_version" in wf && typeof wf.current_version === "number"
            ? wf.current_version
            : null,
      };
    } catch {
      workflowVersion = {
        workflow_id: detail.conversation.target_workflow_id,
        current_version: null,
      };
    }
  }

  return {
    conversation_id,
    connector_id: detail.conversation.target_connector_id,
    workflow_id: detail.conversation.target_workflow_id,
    draft_mode: detail.draft?.mode ?? "onboarding",
    authoring_mode: draftSummary?.mode ?? null,
    authoring_stage: draftSummary?.stage ?? null,
    draft_summary: draftSummary
      ? {
          readiness: draftSummary.readiness,
          next_action: draftSummary.next_action,
          next_required_action: draftSummary.next_required_action,
          next_suggested_tool: draftSummary.next_suggested_tool,
          missing_fields: draftSummary.missing_fields,
          progress_label: draftSummary.progress_label,
          lifecycle_state: draftSummary.lifecycle_state,
          blocked_by: draftSummary.blocked_by,
        }
      : null,
    active_target: draftSummary?.active_target ?? null,
    checkpoint_statuses: draftSummary?.checkpoints ?? [],
    stale_checkpoints:
      draftSummary?.checkpoints
        .filter((checkpoint) => checkpoint.status === "stale")
        .map((checkpoint) => checkpoint.key) ?? [],
    next_required_action: draftSummary?.next_required_action ?? null,
    persisted_resources: draftSummary?.persisted_resources ?? [],
    latest_execution: draftSummary?.latest_execution ?? null,
    latest_diagnosis: draftSummary?.latest_diagnosis ?? null,
    skills: {
      ...byScope,
      total: applicable.length,
    },
    messages: {
      total: detail.messages.length,
      last_role: lastMessage ? lastMessage.role : null,
    },
    tool_calls_total: detail.tool_calls.length,
    pending_elicitations: pending,
    attachments: { total: attachmentRows.length, items: attachmentItems },
    latest_probe: latestProbe,
    latest_preview: latestPreview,
    workflow_version: workflowVersion,
    last_context_budget: getConversationBudgetReport(tenant_id, conversation_id),
    grounding_status: await computeGroundingStatus(tenant_id, detail.draft, exec),
  };
}
