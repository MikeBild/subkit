// State-gate helpers — return a structured "tool_unavailable_in_state"
// envelope when a tool is invoked at the wrong authoring stage.
//
// The palette no longer hides tools by state (PR10/PR15). Loading a
// skill exposes a fixed tool set; calling a tool against the wrong
// state returns the structured envelope below so the LLM has an
// explicit signal — and a `next_best_actions` list — instead of a
// silent disappearance. This is the contract that prevents dead-end
// turns like session 00b93a52, where the agent gave up because
// `save_connector_draft` was filtered out of the palette and asked
// the user to restart.
//
// All helpers return `null` when the precondition is met (caller
// proceeds normally) or a `ToolResult` with `ok: false` and a
// `tool_unavailable_in_state` error code otherwise.
//
// Auto-persist contract (session 0ac7593c follow-up):
//   - A green `probe_connector_draft` is consent to persist. The probe
//     tool calls `saveConnectorAtomic` inline with
//     `reason: "auto_persist_on_green_probe"`; the probe envelope
//     returns the saved-connector shape directly. There is no
//     intermediate `connector_probed` lifecycle visible to the user.
//   - A clean `dry_run_workflow` (status=succeeded, no requires_repair)
//     is consent to commit. The dry-run tool calls
//     `commitWorkflowAtomic({ skipPriorApprovalCheck: true })` inline
//     with `reason: "auto_persist_on_green_dry_run"`; the envelope
//     returns the committed-workflow shape directly. There is no
//     intermediate `workflow_previewed` lifecycle visible to the user.
//   - Anything that is not a green path still surfaces a structured
//     error envelope with `next_best_actions` so the LLM picks the
//     typed recovery move.
//   - This is the only flow; there is no opt-out and no env-var
//     escape hatch. Tests assert against this contract directly.

import type { AuthoringStage, AuthoringSummary, DraftDocument } from "../types.ts";
import type { ToolResult } from "./index.ts";

/**
 * Recommended progression. For any (current_stage, required_stage)
 * pair the value is the ordered list of tools that move the draft
 * forward. Used as the `next_best_actions` payload on a state-gate
 * miss so the LLM has explicit recovery guidance.
 */
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
    workflow_targeted: ["author_workflow", "build_workflow"],
    workflow_inspected: ["author_workflow", "inspect_workflow_draft"],
    workflow_validated: ["author_workflow", "validate_draft"],
    workflow_previewed: ["author_workflow", "dry_run_workflow"],
  },
  workflow_targeted: {
    workflow_inspected: ["update_param", "inspect_workflow_draft"],
    workflow_validated: ["inspect_workflow_draft", "validate_draft"],
    workflow_previewed: ["inspect_workflow_draft", "validate_draft", "dry_run_workflow"],
  },
  workflow_draft_started: {
    workflow_inspected: ["update_param", "inspect_workflow_draft"],
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
  // No explicit progression mapped — emit a generic recovery hint that
  // points at the inspection / validation tools for the requested
  // resource so the LLM still has a deterministic next move.
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

/**
 * Require the authoring summary to be at (or past) `requiredStage`.
 * Returns null when the precondition is met, else a structured
 * `tool_unavailable_in_state` envelope with `next_best_actions` that
 * point the LLM at the tools that move from the current stage to the
 * required one.
 *
 * Stage ordering is approximate — checkpoints (`hasFreshCheckpoint`)
 * are the authoritative readiness signal for tools like
 * `save_connector_draft` / `save_workflow_draft`. This helper is the cheap
 * structural gate that catches obvious mismatches (e.g. asking to
 * save before any connector is even targeted).
 */
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

/**
 * Require the active draft to carry a connector (draft-only or
 * persisted). Returns null when present, else a structured envelope.
 */
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

/**
 * Require a persisted connector — either the active target is
 * persisted, or the draft references a saved connector id.
 */
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

/**
 * Require the workflow draft to carry at least a name + a step.
 * Returns null when the draft is structurally a workflow draft.
 */
export function requireWorkflowDraft(draft: DraftDocument, toolName: string): ToolResult | null {
  const wf = draft.workflow;
  if (wf && (wf.steps?.length ?? 0) > 0) return null;
  return unavailableEnvelope({
    toolName,
    message: `${toolName} requires an active workflow draft with at least one step`,
    next_best_actions: ["author_workflow", "build_workflow", "propose_step"],
    details: { current_stage: draft.summary?.stage ?? null },
  });
}

/**
 * Require a persisted workflow.
 */
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
  // Stage progression is not strictly linear (connector vs workflow
  // axes), so we only treat it as "at least" within the same axis.
  const currentConnector = current.startsWith("connector_") || current === "idle";
  const requiredConnector = required.startsWith("connector_");
  if (requiredConnector && !currentConnector) return false;
  if (!requiredConnector && currentConnector) return false;
  return STAGE_ORDER.indexOf(current) >= STAGE_ORDER.indexOf(required);
}
