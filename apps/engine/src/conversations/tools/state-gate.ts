import type { AuthoringStage, AuthoringSummary, DraftDocument } from "../types.ts";
import type { ToolResult } from "./index.ts";

const CONNECTOR_STAGE_PROGRESSION: Readonly<
  Partial<Record<AuthoringStage, Partial<Record<AuthoringStage, string[]>>>>
> = {
  idle: {
    connector_targeted: ["start_connector_from_description", "start_connector_from_template"],
    connector_inspected: ["start_connector_from_description", "inspect_connector_draft"],
    connector_validated: ["start_connector_from_description", "validate_connector_draft"],
    connector_probed: ["start_connector_from_description", "probe_connector_draft"],
  },
  connector_targeted: {
    connector_inspected: ["update_connector_draft", "inspect_connector_draft"],
    connector_validated: ["inspect_connector_draft", "validate_connector_draft"],
    connector_probed: [
      "inspect_connector_draft",
      "validate_connector_draft",
      "probe_connector_draft",
    ],
  },
  connector_draft_started: {
    connector_inspected: ["update_connector_draft", "inspect_connector_draft"],
    connector_validated: ["inspect_connector_draft", "validate_connector_draft"],
    connector_probed: [
      "inspect_connector_draft",
      "validate_connector_draft",
      "probe_connector_draft",
    ],
  },
  connector_inspected: {
    connector_validated: ["validate_connector_draft"],
    connector_probed: ["validate_connector_draft", "probe_connector_draft"],
  },
  connector_validated: {
    connector_probed: ["probe_connector_draft", "ask_user_form"],
  },
};

const WORKFLOW_STAGE_PROGRESSION: Readonly<
  Partial<Record<AuthoringStage, Partial<Record<AuthoringStage, string[]>>>>
> = {
  idle: {
    workflow_targeted: ["author_workflow"],
    workflow_inspected: ["author_workflow", "inspect_workflow_draft"],
    workflow_validated: ["author_workflow", "validate_draft"],
    workflow_previewed: ["author_workflow", "dry_run_workflow"],
  },
  workflow_targeted: {
    workflow_inspected: ["edit_workflow_patch", "inspect_workflow_draft"],
    workflow_validated: ["inspect_workflow_draft", "validate_draft"],
    workflow_previewed: ["inspect_workflow_draft", "validate_draft", "dry_run_workflow"],
  },
  workflow_draft_started: {
    workflow_inspected: ["edit_workflow_patch", "inspect_workflow_draft"],
    workflow_validated: ["inspect_workflow_draft", "validate_draft"],
    workflow_previewed: ["inspect_workflow_draft", "validate_draft", "dry_run_workflow"],
  },
  workflow_inspected: {
    workflow_validated: ["validate_draft"],
    workflow_previewed: ["validate_draft", "dry_run_workflow"],
  },
  workflow_validated: {
    workflow_previewed: ["dry_run_workflow"],
  },
};

function progressionFor(current: AuthoringStage, required: AuthoringStage): string[] {
  const isConnectorRequired = required.startsWith("connector_");
  const map = isConnectorRequired ? CONNECTOR_STAGE_PROGRESSION : WORKFLOW_STAGE_PROGRESSION;
  const next = map[current]?.[required];
  if (next) return [...next];
  if (isConnectorRequired) {
    return ["inspect_connector_draft", "validate_connector_draft", "probe_connector_draft"];
  }
  return ["inspect_workflow_draft", "validate_draft", "dry_run_workflow"];
}

function unavailableEnvelope(params: {
  toolName: string;
  message: string;
  details?: Record<string, unknown>;
  next_best_actions: string[];
}): ToolResult {
  return {
    ok: false,
    error_code: "tool_unavailable_in_state",
    message: params.message,
    next_best_actions: params.next_best_actions,
    ...(params.details ? { details: params.details } : {}),
    data: {
      error: "tool_unavailable_in_state",
      tool: params.toolName,
      message: params.message,
      next_best_actions: params.next_best_actions,
      ...(params.details ?? {}),
    },
  };
}

export function requireAuthoringStage(
  summary: AuthoringSummary | null | undefined,
  requiredStage: AuthoringStage,
  toolName: string,
): ToolResult | null {
  if (!summary) {
    return unavailableEnvelope({
      toolName,
      message: `${toolName} requires the draft to be in stage '${requiredStage}'; the conversation has no authoring summary yet`,
      next_best_actions: progressionFor("idle", requiredStage),
      details: { current_stage: null, required_stage: requiredStage },
    });
  }
  if (summary.stage === requiredStage) return null;
  if (isStageAtLeast(summary.stage, requiredStage)) return null;
  return unavailableEnvelope({
    toolName,
    message: `${toolName} requires the draft to be in stage '${requiredStage}'; current stage is '${summary.stage}'`,
    next_best_actions: progressionFor(summary.stage, requiredStage),
    details: {
      current_stage: summary.stage,
      required_stage: requiredStage,
    },
  });
}

export function requireConnectorDraft(draft: DraftDocument, toolName: string): ToolResult | null {
  const connector = draft.connector;
  if (connector) return null;
  return unavailableEnvelope({
    toolName,
    message: `${toolName} requires an active connector draft; none is attached to the conversation`,
    next_best_actions: ["start_connector_from_description", "start_connector_from_template"],
    details: { current_stage: draft.summary?.stage ?? null },
  });
}

export function requirePersistedConnector(
  summary: AuthoringSummary | null | undefined,
  toolName: string,
): ToolResult | null {
  if (!summary) {
    return unavailableEnvelope({
      toolName,
      message: `${toolName} requires a persisted connector; the conversation has no authoring summary`,
      next_best_actions: ["save_connector_draft", "list_connectors"],
    });
  }
  const persistedActive =
    summary.active_target.kind === "connector" &&
    summary.active_target.lifecycle_state === "persisted";
  const persistedAny = summary.persisted_resources.some((r) => r.kind === "connector");
  if (persistedActive || persistedAny) return null;
  return unavailableEnvelope({
    toolName,
    message: `${toolName} requires a persisted connector; current state has none`,
    next_best_actions: ["save_connector_draft", "list_connectors"],
    details: { current_stage: summary.stage },
  });
}

export function requireWorkflowDraft(draft: DraftDocument, toolName: string): ToolResult | null {
  const wf = draft.workflow;
  if (wf && (wf.steps?.length ?? 0) > 0) return null;
  return unavailableEnvelope({
    toolName,
    message: `${toolName} requires an active workflow draft with at least one step`,
    next_best_actions: ["author_workflow", "edit_workflow_patch"],
    details: { current_stage: draft.summary?.stage ?? null },
  });
}

export function replacesPersistedWorkflow(summary: AuthoringSummary | null | undefined): boolean {
  if (!summary) return false;
  const persistedActive =
    summary.active_target.kind === "workflow" &&
    summary.active_target.lifecycle_state === "persisted";
  return persistedActive || summary.persisted_resources.some((r) => r.kind === "workflow");
}

export function requirePersistedWorkflow(
  summary: AuthoringSummary | null | undefined,
  toolName: string,
): ToolResult | null {
  if (!summary) {
    return unavailableEnvelope({
      toolName,
      message: `${toolName} requires a persisted workflow; the conversation has no authoring summary`,
      next_best_actions: ["save_workflow_draft", "list_workflows"],
    });
  }
  const persistedActive =
    summary.active_target.kind === "workflow" &&
    summary.active_target.lifecycle_state === "persisted";
  const persistedAny = summary.persisted_resources.some((r) => r.kind === "workflow");
  const seenExecution = Boolean(summary.latest_execution?.workflow_id);
  if (persistedActive || persistedAny || seenExecution) return null;
  return unavailableEnvelope({
    toolName,
    message: `${toolName} requires a persisted workflow; current state has none`,
    next_best_actions: ["save_workflow_draft", "list_workflows"],
    details: { current_stage: summary.stage },
  });
}

const STAGE_ORDER: Readonly<AuthoringStage[]> = [
  "idle",
  "connector_targeted",
  "connector_draft_started",
  "connector_inspected",
  "connector_validated",
  "connector_probed",
  "connector_persisted",
  "workflow_targeted",
  "workflow_draft_started",
  "workflow_inspected",
  "workflow_validated",
  "workflow_previewed",
  "workflow_persisted",
  "workflow_executed",
  "diagnosing",
  "repairing",
];

function isStageAtLeast(current: AuthoringStage, required: AuthoringStage): boolean {
  const currentConnector = current.startsWith("connector_") || current === "idle";
  const requiredConnector = required.startsWith("connector_");
  if (requiredConnector && !currentConnector) return false;
  if (!requiredConnector && currentConnector) return false;
  return STAGE_ORDER.indexOf(current) >= STAGE_ORDER.indexOf(required);
}
