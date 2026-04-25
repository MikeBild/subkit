import { normalizeDraftDocument } from "../authoring-state.ts";
import type { AuthoringSummary, DraftDocument } from "../types.ts";

const ALWAYS_VISIBLE = new Set([
  "ask_user_choice",
  "ask_user_confirm",
  "ask_user_form",
  "ask_user_multi",
  "ask_user_text",
  "cannot_help",
  "fetch_connector_docs",
  "get_raw_result",
  "inspect_authoring_context",
  "list_attachments",
  "list_skills",
  "load_skill",
  "preview_attachment",
  "search_knowledge",
  "suggest_connector_templates",
]);

const RELEVANT_READS = new Set([
  "get_connector",
  "get_execution",
  "get_workflow",
  "list_connectors",
  "list_executions",
  "list_workflows",
  "probe_connector",
]);

// Cleanup operations on tenant resources. The palette filter would
// otherwise hide them from every authoring state because no per-state
// set lists them, leaving the model to call cannot_help with "delete
// not available in this conversation" — exactly the bug user mike
// reported in session 9b9ea73b ("lösche dummy-http").
//
// These tools are protected by the DANGEROUS_TOOLS confirm gate in
// tool-policies.ts which fires regardless of permission_mode, so it
// is safe to keep them visible in every authoring state. The user
// always sees a structured ask_user_confirm before any deletion.
const ALWAYS_AVAILABLE_CLEANUP = new Set([
  "delete_connector",
  "delete_knowledge_source",
  "delete_subscription",
  "delete_tunnel",
  "delete_workflow",
  "revoke_api_key",
  "revoke_portal_token",
  // update_<resource> tools are the chat-native generic patch ops
  // (rename, repoint, change lifecycle, rotate secrets). Like the
  // delete_* and revoke_* tools they must be reachable in every
  // authoring state — the user types "rename to X" or "pause that
  // webhook" in the middle of any conversation and the LLM needs the
  // tool in its palette. Slug/uniqueness + the dangerous-tools
  // confirm gate are the safety net (see tool-policies.ts).
  "update_workflow",
  "update_connector",
  "update_knowledge_source",
  "update_subscription",
]);

const CONNECTOR_AUTHORING = new Set([
  "inspect_connector_draft",
  "probe_connector_draft",
  "start_connector_from_description",
  "start_connector_from_template",
  "update_connector_draft",
  "validate_connector_draft",
]);

const CONNECTOR_PERSISTENCE = new Set(["save_connector_draft"]);

const CONNECTOR_POST_SAVE = new Set(["submit_connector_credential"]);

const WORKFLOW_AUTHORING = new Set([
  "build_workflow",
  "connect_steps",
  "inspect_workflow_draft",
  "propose_step",
  "start_workflow_from_goal",
  "update_param",
  "validate_draft",
]);

const WORKFLOW_PREVIEW = new Set(["dry_run_step", "dry_run_transform", "dry_run_workflow"]);

const WORKFLOW_PERSISTENCE = new Set(["commit_draft"]);

const EXECUTION_TOOLS = new Set(["run_workflow"]);

const DIAGNOSIS_TOOLS = new Set(["diagnose_latest_execution"]);

function hasFocusedAuthoringState(draft: DraftDocument): boolean {
  const normalized = normalizeDraftDocument(draft);
  const summary = normalized.summary;
  if (!summary) return false;
  if (summary.active_target.kind !== "none") return true;
  return Boolean(summary.latest_execution || summary.latest_diagnosis);
}

function addNames(target: Set<string>, names: Iterable<string>): void {
  for (const name of names) target.add(name);
}

function hasMissingFields(summary: AuthoringSummary): boolean {
  return summary.blocked_by.some((item) => item.startsWith("missing:"));
}

function hasCheckpoint(
  summary: AuthoringSummary,
  key: AuthoringSummary["checkpoints"][number]["key"],
  status: AuthoringSummary["checkpoints"][number]["status"] = "fresh",
): boolean {
  return summary.checkpoints.some(
    (checkpoint) => checkpoint.key === key && checkpoint.status === status,
  );
}

function connectorDraftAllowsSave(summary: AuthoringSummary): boolean {
  if (summary.active_target.kind !== "connector") return false;
  if (summary.active_target.lifecycle_state !== "draft_only") return false;
  if (summary.stage !== "connector_probed") return false;
  if (hasMissingFields(summary)) return false;
  return !summary.blocked_by.some(
    (item) =>
      item === "inspect_connector_draft" ||
      item === "validate_connector_draft" ||
      item === "probe_connector_draft",
  );
}

function workflowDraftAllowsCommit(summary: AuthoringSummary): boolean {
  if (summary.active_target.kind !== "workflow") return false;
  if (summary.active_target.lifecycle_state !== "draft_only") return false;
  if (summary.stage !== "workflow_previewed") return false;
  if (hasMissingFields(summary)) return false;
  return !summary.blocked_by.some(
    (item) =>
      item === "inspect_workflow_draft" || item === "validate_draft" || item === "dry_run_workflow",
  );
}

// In-place re-commit on a persisted workflow (the repair-and-save path).
// commit_draft itself supports update-in-place when target_workflow_id is
// set; the palette must surface the tool so the agent can take that path
// instead of abstaining via cannot_help. We require the same gates the
// commit tool checks (inspected + validated), but DO NOT require the
// workflow_previewed checkpoint here — that's commit_draft's job to
// enforce, with a structured `next_best_actions: ["dry_run_workflow"]`
// if missing. Hiding the tool produces a dead end where the model has
// no in-chat path to persist its repair and falls back to suggesting a
// CLI command, which breaks the chat-first contract.
export function workflowPersistedAllowsRecommit(summary: AuthoringSummary): boolean {
  if (summary.active_target.kind !== "workflow") return false;
  if (summary.active_target.lifecycle_state !== "persisted") return false;
  if (hasMissingFields(summary)) return false;
  if (
    summary.blocked_by.some(
      (item) => item === "inspect_workflow_draft" || item === "validate_draft",
    )
  ) {
    return false;
  }
  return hasCheckpoint(summary, "workflow_validated");
}

function workflowAllowsRun(summary: AuthoringSummary): boolean {
  if (summary.active_target.kind !== "workflow") return false;
  if (summary.active_target.lifecycle_state !== "persisted") return false;
  return (
    summary.stage === "workflow_persisted" ||
    summary.stage === "workflow_executed" ||
    summary.stage === "diagnosing"
  );
}

function hasPersistedConnector(summary: AuthoringSummary): boolean {
  if (
    summary.active_target.kind === "connector" &&
    summary.active_target.lifecycle_state === "persisted"
  ) {
    return true;
  }
  return summary.persisted_resources.some((resource) => resource.kind === "connector");
}

function diagnosisAvailable(summary: AuthoringSummary): boolean {
  return summary.latest_execution?.diagnosis_available === true && !summary.latest_diagnosis;
}

function allowConnectorDraftPalette(allowed: Set<string>, summary: AuthoringSummary): void {
  addNames(allowed, CONNECTOR_AUTHORING);
  if (connectorDraftAllowsSave(summary)) {
    addNames(allowed, CONNECTOR_PERSISTENCE);
    addNames(allowed, WORKFLOW_AUTHORING);
    addNames(allowed, WORKFLOW_PREVIEW);
  }
}

function allowConnectorPersistedPalette(allowed: Set<string>): void {
  addNames(allowed, CONNECTOR_AUTHORING);
  addNames(allowed, CONNECTOR_POST_SAVE);
  addNames(allowed, WORKFLOW_AUTHORING);
  addNames(allowed, WORKFLOW_PREVIEW);
}

function allowWorkflowDraftPalette(allowed: Set<string>, summary: AuthoringSummary): void {
  addNames(allowed, WORKFLOW_AUTHORING);
  addNames(allowed, WORKFLOW_PREVIEW);
  if (workflowDraftAllowsCommit(summary)) addNames(allowed, WORKFLOW_PERSISTENCE);
}

function allowWorkflowPersistedPalette(allowed: Set<string>, summary: AuthoringSummary): void {
  addNames(allowed, WORKFLOW_AUTHORING);
  addNames(allowed, WORKFLOW_PREVIEW);
  if (workflowAllowsRun(summary)) addNames(allowed, EXECUTION_TOOLS);
  if (diagnosisAvailable(summary)) addNames(allowed, DIAGNOSIS_TOOLS);
  // Repair-and-save: a persisted workflow that has been edited and
  // validated must be commit-able through the conversation, otherwise
  // the agent has no in-chat path to apply its repair.
  if (workflowPersistedAllowsRecommit(summary)) addNames(allowed, WORKFLOW_PERSISTENCE);
}

export function filterByAuthoringPalette<T extends { name: string }>(
  tools: readonly T[],
  draft: DraftDocument,
): T[] {
  if (!hasFocusedAuthoringState(draft)) return [...tools];
  const normalized = normalizeDraftDocument(draft);
  const summary = normalized.summary;
  if (!summary) return [...tools];
  const allowed = new Set<string>([
    ...ALWAYS_VISIBLE,
    ...RELEVANT_READS,
    ...ALWAYS_AVAILABLE_CLEANUP,
  ]);

  if (summary.mode === "connector") {
    if (
      summary.active_target.kind === "connector" &&
      summary.active_target.lifecycle_state === "draft_only"
    ) {
      allowConnectorDraftPalette(allowed, summary);
    } else if (hasPersistedConnector(summary)) {
      allowConnectorPersistedPalette(allowed);
    } else {
      addNames(allowed, CONNECTOR_AUTHORING);
    }
  } else if (summary.mode === "workflow") {
    if (summary.active_target.lifecycle_state === "draft_only") {
      allowWorkflowDraftPalette(allowed, summary);
    } else {
      allowWorkflowPersistedPalette(allowed, summary);
    }
  } else if (summary.mode === "execution") {
    allowWorkflowPersistedPalette(allowed, summary);
  } else {
    // Idle / fresh-start state (e.g. immediately after a delete_*).
    // Must include the entry tools for BOTH connector and workflow
    // authoring, otherwise the user cannot start a new resource — the
    // model is forced into cannot_help with "tool not available", which
    // is the bug surfaced in session 64db7189 after delete_connector
    // dropped active_target.kind to "none" and the palette hid
    // start_connector_from_description.
    addNames(allowed, CONNECTOR_AUTHORING);
    addNames(allowed, WORKFLOW_AUTHORING);
    addNames(allowed, WORKFLOW_PREVIEW);
  }
  if (diagnosisAvailable(summary)) addNames(allowed, DIAGNOSIS_TOOLS);
  if (hasPersistedConnector(summary) && hasCheckpoint(summary, "connector_persisted")) {
    addNames(allowed, CONNECTOR_POST_SAVE);
  }
  return tools.filter((tool) => allowed.has(tool.name));
}
