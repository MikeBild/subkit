import { extractTemplatePlaceholders } from "../connector-template-intelligence.ts";
import type {
  AuthoringCheckpointKey,
  AuthoringCheckpointStatus,
  AuthoringCheckpointView,
  AuthoringLifecycleState,
  AuthoringStage,
  AuthoringState,
  AuthoringSummary,
  AuthoringSurfaceMode,
  ConnectorDraftDocument,
  DraftDocument,
  PersistedResourceRef,
  WorkflowDraftDocument,
} from "../types.ts";

export function emptySummary(): AuthoringSummary {
  return {
    readiness: "drafting",
    next_action: null,
    next_required_action: null,
    next_suggested_tool: null,
    missing_fields: [],
    last_action: null,
    progress_label: null,
    mode: "connector",
    stage: "idle",
    lifecycle_state: "none",
    active_target: {
      kind: "none",
      name: null,
      slug: null,
      id: null,
      environment: null,
      lifecycle_state: "none",
    },
    blocked_by: [],
    checkpoints: [],
    persisted_resources: [],
    latest_execution: null,
    latest_diagnosis: null,
  };
}

export function checkpointSeq(state: AuthoringState, key: AuthoringCheckpointKey): number {
  switch (key) {
    case "connector_inspected":
    case "connector_validated":
    case "connector_authenticated":
    case "connector_probed":
    case "connector_persisted":
      return state.connector_mutation_seq;
    default:
      return state.workflow_mutation_seq;
  }
}

export function checkpointStatus(
  state: AuthoringState,
  key: AuthoringCheckpointKey,
): AuthoringCheckpointStatus {
  const record = state.checkpoints[key];
  if (!record) return "missing";
  return record.mutation_seq === checkpointSeq(state, key) ? "fresh" : "stale";
}

export function checkpointView(
  state: AuthoringState,
  key: AuthoringCheckpointKey,
): AuthoringCheckpointView {
  const record = state.checkpoints[key];
  if (!record) {
    return {
      key,
      status: "missing",
      verified_at: null,
      verified_by_tool: null,
      ok: null,
      summary: null,
    };
  }
  return {
    key,
    status: checkpointStatus(state, key),
    verified_at: record.verified_at,
    verified_by_tool: record.verified_by_tool,
    ok: typeof record.ok === "boolean" ? record.ok : null,
    summary: record.summary ?? null,
  };
}

export function persistedResourceForKind(
  state: AuthoringState,
  kind: PersistedResourceRef["kind"],
): PersistedResourceRef | null {
  return state.persisted_resources.find((item) => item.kind === kind) ?? null;
}

export function persistedWorkflowResource(state: AuthoringState): PersistedResourceRef | null {
  const persisted = persistedResourceForKind(state, "workflow");
  if (persisted) return persisted;
  const latestExecution = state.latest_execution;
  if (!latestExecution?.workflow_id) return null;
  return {
    kind: "workflow",
    id: latestExecution.workflow_id,
    slug: null,
    name: null,
    version_id: latestExecution.workflow_version_id,
    version: null,
    environment: latestExecution.environment,
    saved_at: latestExecution.recorded_at,
  };
}

export function pendingInactiveDraft(state: AuthoringState): boolean {
  const resource = persistedResourceForKind(state, "workflow");
  if (resource?.persistence_kind !== "draft") return false;
  const pendingVersion = resource.version_id ?? resource.draft_version_id ?? null;
  return !resource.current_version_id || pendingVersion !== resource.current_version_id;
}

function savedDraftPreviewed(
  state: AuthoringState,
  latest_preview: DraftDocument["latest_preview"],
): boolean {
  return checkpointStatus(state, "workflow_previewed") === "fresh" && latest_preview?.ok === true;
}

export function computeConnectorMissingFields(connector: ConnectorDraftDocument | null): string[] {
  if (!connector) return [];
  const missing: string[] = [];
  if (!connector.name) missing.push("name");
  if (!connector.driver) missing.push("driver");
  if (!connector.environment) missing.push("environment");
  if (connector.driver === "http" || connector.driver === "graphql" || connector.driver === "s3") {
    if (!connector.base_url) {
      missing.push("base_url");
    } else {
      for (const field of extractTemplatePlaceholders(connector.base_url)) {
        missing.push(`base_url.${field}`);
      }
    }
  }
  if (connector.driver === "postgres" && !connector.dsn) missing.push("dsn");
  if (!connector.auth_type) missing.push("auth_type");
  if (connector.validation && connector.validation.errors.length > 0) {
    for (const error of connector.validation.errors) {
      if (!missing.includes(error.path)) missing.push(error.path);
    }
  }
  return missing;
}

export function computeWorkflowMissingFields(
  workflow: WorkflowDraftDocument,
  active?: AuthoringSummary["active_target"] | null,
): string[] {
  const missing: string[] = [];
  if (!workflow.name && !(active?.kind === "workflow" && active.name)) {
    missing.push("workflow.name");
  }
  if (workflow.steps.length === 0 && active?.lifecycle_state !== "persisted") {
    missing.push("workflow.steps");
  }
  return missing;
}

function connectorTargetLifecycle(
  state: AuthoringState,
  connector: ConnectorDraftDocument | null,
): AuthoringLifecycleState {
  if (!connector) return "none";
  return checkpointStatus(state, "connector_persisted") === "fresh" &&
    typeof connector.saved_connector_id === "string"
    ? "persisted"
    : "draft_only";
}

function workflowTargetLifecycle(
  state: AuthoringState,
  workflow: WorkflowDraftDocument,
): AuthoringLifecycleState {
  const persistedWorkflow = persistedWorkflowResource(state);
  if (workflow.steps.length === 0) {
    if (!persistedWorkflow) return "none";
    return state.workflow_mutation_seq > 0 &&
      checkpointStatus(state, "workflow_persisted") !== "fresh"
      ? "draft_only"
      : "persisted";
  }
  return checkpointStatus(state, "workflow_persisted") === "fresh" ? "persisted" : "draft_only";
}

export function computeActiveTarget(
  state: AuthoringState,
  connector: ConnectorDraftDocument | null,
  workflow: WorkflowDraftDocument,
): AuthoringSummary["active_target"] {
  const connectorLifecycle = connectorTargetLifecycle(state, connector);
  const workflowLifecycle = workflowTargetLifecycle(state, workflow);
  const persistedWorkflow = persistedWorkflowResource(state);
  if (state.authoring_focus === "connector" && typeof connector?.saved_connector_id !== "string") {
    return {
      kind: "connector",
      name: connector?.name ?? null,
      slug: connector?.slug ?? null,
      id: null,
      environment: connector?.environment ?? null,
      lifecycle_state: connectorLifecycle,
    };
  }
  if (workflow.steps.length > 0) {
    return {
      kind: "workflow",
      name: workflow.name || (persistedWorkflow?.name ?? null),
      slug: workflow.slug ?? persistedWorkflow?.slug ?? null,
      id: persistedWorkflow?.id ?? null,
      environment: connector?.environment ?? persistedWorkflow?.environment ?? null,
      lifecycle_state: workflowLifecycle,
    };
  }
  if (persistedWorkflow) {
    return {
      kind: "workflow",
      name: persistedWorkflow.name ?? null,
      slug: persistedWorkflow.slug ?? null,
      id: persistedWorkflow.id,
      environment: persistedWorkflow.environment ?? connector?.environment ?? null,
      lifecycle_state: workflowLifecycle,
    };
  }
  if (connector) {
    const persistedConnector = persistedResourceForKind(state, "connector");
    return {
      kind: "connector",
      name: connector.name ?? persistedConnector?.name ?? null,
      slug: connector.slug ?? persistedConnector?.slug ?? null,
      id: connector.saved_connector_id ?? persistedConnector?.id ?? null,
      environment: connector.environment ?? persistedConnector?.environment ?? null,
      lifecycle_state: connectorLifecycle,
    };
  }
  return {
    kind: "none",
    name: null,
    slug: null,
    id: null,
    environment: null,
    lifecycle_state: "none",
  };
}

export function computeBlockedBy(
  state: AuthoringState,
  connector: ConnectorDraftDocument | null,
  workflow: WorkflowDraftDocument,
  latest_preview: DraftDocument["latest_preview"],
  active: AuthoringSummary["active_target"],
): string[] {
  const blocked: string[] = [];
  if (active.kind === "connector" && active.lifecycle_state === "draft_only") {
    for (const field of computeConnectorMissingFields(connector)) blocked.push(`missing:${field}`);
    if (checkpointStatus(state, "connector_inspected") !== "fresh")
      blocked.push("inspect_connector_draft");
    if (
      checkpointStatus(state, "connector_validated") !== "fresh" ||
      connector?.validation?.ok !== true
    ) {
      blocked.push("validate_connector_draft");
    }
    const authPending =
      connector !== null &&
      connector.auth_type !== "none" &&
      checkpointStatus(state, "connector_authenticated") !== "fresh";
    if (authPending && connector) {
      blocked.push(connector.auth_type === "oauth2" ? "authenticate_oauth" : "ask_user_form");
    }
    const oauth2AwaitingAuth =
      connector?.auth_type === "oauth2" &&
      checkpointStatus(state, "connector_authenticated") !== "fresh";
    if (
      !oauth2AwaitingAuth &&
      (checkpointStatus(state, "connector_probed") !== "fresh" ||
        connector?.latest_probe?.ok !== true)
    ) {
      blocked.push("probe_connector_draft");
    }
    return uniqueStrings(blocked);
  }
  if (active.kind === "workflow") {
    for (const field of computeWorkflowMissingFields(workflow, active)) {
      blocked.push(`missing:${field}`);
    }
    if (active.lifecycle_state === "draft_only") {
      if (checkpointStatus(state, "workflow_inspected") !== "fresh") {
        blocked.push("inspect_workflow_draft");
      }
      if (checkpointStatus(state, "workflow_validated") !== "fresh") {
        blocked.push("validate_draft");
      }
      if (
        checkpointStatus(state, "workflow_previewed") !== "fresh" ||
        latest_preview?.ok !== true
      ) {
        blocked.push("dry_run_workflow");
      }
    }
    if (
      active.lifecycle_state === "persisted" &&
      pendingInactiveDraft(state) &&
      !savedDraftPreviewed(state, latest_preview)
    ) {
      blocked.push("dry_run_workflow");
    }
    if (
      state.latest_execution?.diagnosis_available &&
      checkpointStatus(state, "workflow_diagnosed") !== "fresh"
    ) {
      blocked.push("diagnose_latest_execution");
    }
  }
  return uniqueStrings(blocked);
}

function uniqueStrings(items: string[]): string[] {
  return [...new Set(items)];
}

export function computeReadiness(
  active: AuthoringSummary["active_target"],
  blocked_by: string[],
): AuthoringSummary["readiness"] {
  if (active.lifecycle_state === "persisted") {
    return active.kind === "workflow" && blocked_by.includes("dry_run_workflow")
      ? "ready_to_probe"
      : "saved";
  }
  if (blocked_by.some((item) => item.startsWith("missing:"))) return "needs_input";
  if (active.kind === "connector") {
    return blocked_by.includes("probe_connector_draft") ? "ready_to_probe" : "ready_to_save";
  }
  if (active.kind === "workflow") {
    return blocked_by.includes("dry_run_workflow") ? "ready_to_probe" : "ready_to_save";
  }
  return "drafting";
}

export function computeProgressLabel(
  active: AuthoringSummary["active_target"],
  connector: ConnectorDraftDocument | null,
  workflow: WorkflowDraftDocument,
): string | null {
  if (active.kind === "connector") {
    return connector?.template_name
      ? `Connector draft from ${connector.template_name}`
      : "Connector draft";
  }
  if (active.kind === "workflow") {
    return workflow.steps.length > 0
      ? `${workflow.steps.length} workflow step${workflow.steps.length === 1 ? "" : "s"}`
      : active.lifecycle_state === "persisted"
        ? "Saved workflow"
        : "Workflow draft";
  }
  return null;
}

export function computeStage(
  state: AuthoringState,
  active: AuthoringSummary["active_target"],
): AuthoringStage {
  if (state.latest_diagnosis) return "diagnosing";
  if (state.latest_execution) return "workflow_executed";
  if (active.kind === "workflow") {
    if (checkpointStatus(state, "workflow_persisted") === "fresh") return "workflow_persisted";
    if (checkpointStatus(state, "workflow_previewed") === "fresh") return "workflow_previewed";
    if (checkpointStatus(state, "workflow_validated") === "fresh") return "workflow_validated";
    if (checkpointStatus(state, "workflow_inspected") === "fresh") return "workflow_inspected";
    return active.lifecycle_state === "none" ? "workflow_targeted" : "workflow_draft_started";
  }
  if (active.kind === "connector") {
    if (checkpointStatus(state, "connector_persisted") === "fresh") return "connector_persisted";
    if (checkpointStatus(state, "connector_probed") === "fresh") return "connector_probed";
    if (checkpointStatus(state, "connector_authenticated") === "fresh")
      return "connector_authenticated";
    if (checkpointStatus(state, "connector_validated") === "fresh") return "connector_validated";
    if (checkpointStatus(state, "connector_inspected") === "fresh") return "connector_inspected";
    return "connector_draft_started";
  }
  return "idle";
}

export function computeSurfaceMode(
  state: AuthoringState,
  active: AuthoringSummary["active_target"],
): AuthoringSurfaceMode {
  if (state.latest_diagnosis) return "diagnosis";
  if (state.latest_execution) return "execution";
  if (active.kind === "workflow") return "workflow";
  return "connector";
}

function nextActionForBlocked(
  blocked: string[],
  active: AuthoringSummary["active_target"],
): string | null {
  const first = blocked[0];
  if (!first) return null;
  if (first.startsWith("missing:")) {
    return active.kind === "connector"
      ? `Collect the remaining connector fields before continuing: ${blocked
          .filter((item) => item.startsWith("missing:"))
          .map((item) => item.slice("missing:".length))
          .join(", ")}.`
      : "Add a workflow name and at least one step before continuing.";
  }
  switch (first) {
    case "inspect_connector_draft":
      return "Inspect the connector draft to lock the current state before saving.";
    case "validate_connector_draft":
      return "Validate the connector draft again before saving.";
    case "probe_connector_draft":
      return "Probe the connector draft successfully before saving it.";
    case "inspect_workflow_draft":
      return "Inspect the workflow draft to lock the current step graph before committing.";
    case "validate_draft":
      return "Validate the workflow draft again before committing.";
    case "dry_run_workflow":
      return active.lifecycle_state === "persisted"
        ? "Preview the saved inactive draft with held writes; nothing is activated and live effects remain a human decision."
        : "Preview the workflow successfully before committing it.";
    case "diagnose_latest_execution":
      return "Inspect the latest execution in diagnosis mode before editing the workflow.";
    default:
      return null;
  }
}

function nextSuggestedToolForBlocked(blocked: string[]): string | null {
  const first = blocked[0];
  if (!first || first.startsWith("missing:")) return null;
  switch (first) {
    case "inspect_connector_draft":
    case "validate_connector_draft":
    case "probe_connector_draft":
    case "inspect_workflow_draft":
    case "validate_draft":
    case "dry_run_workflow":
    case "diagnose_latest_execution":
      return first;
    default:
      return null;
  }
}

export function computeNextAction(
  state: AuthoringState,
  active: AuthoringSummary["active_target"],
  blocked_by: string[],
  workflow: WorkflowDraftDocument,
): string | null {
  const blockedAction = nextActionForBlocked(blocked_by, active);
  if (blockedAction) return blockedAction;
  if (active.kind === "connector" && active.lifecycle_state === "draft_only") {
    return "Save the connector now that inspection, validation, and probe are fresh.";
  }
  if (
    active.kind === "connector" &&
    active.lifecycle_state === "persisted" &&
    workflow.steps.length === 0
  ) {
    return "Describe the workflow you want to build with this saved connector.";
  }
  if (active.kind === "workflow" && active.lifecycle_state === "draft_only") {
    return workflow.execution_privacy === "sensitive"
      ? "Save the inactive sensitive workflow draft now that inspection, validation and the metadata-only test run are fresh."
      : "Commit the workflow now that inspection, validation, and preview are fresh.";
  }
  if (
    active.kind === "workflow" &&
    active.lifecycle_state === "persisted" &&
    pendingInactiveDraft(state)
  ) {
    return "Hand over the saved change for human review; activation and live effects remain a human decision.";
  }
  if (
    active.kind === "workflow" &&
    active.lifecycle_state === "persisted" &&
    !state.latest_execution
  ) {
    return "Run the saved workflow to verify the persisted version.";
  }
  if (state.latest_execution?.diagnosis_available && !state.latest_diagnosis) {
    return "Open diagnosis for the latest execution before editing the workflow.";
  }
  if (state.latest_diagnosis) {
    return "Edit the workflow based on the diagnosis, then preview and re-run it.";
  }
  if (state.latest_execution) {
    return "Review the latest execution result and decide whether to run again or edit the workflow.";
  }
  return "Continue the conversation.";
}

export function computeNextSuggestedTool(
  state: AuthoringState,
  active: AuthoringSummary["active_target"],
  blocked_by: string[],
  workflow: WorkflowDraftDocument,
): string | null {
  const blockedTool = nextSuggestedToolForBlocked(blocked_by);
  if (blockedTool) return blockedTool;
  if (active.kind === "connector" && active.lifecycle_state === "draft_only") {
    return "save_connector_draft";
  }
  if (
    active.kind === "connector" &&
    active.lifecycle_state === "persisted" &&
    workflow.steps.length === 0
  ) {
    return "author_workflow";
  }
  if (active.kind === "workflow" && active.lifecycle_state === "draft_only") {
    return "save_workflow_draft";
  }
  const inactiveDraft = pendingInactiveDraft(state);
  if (active.kind === "workflow" && active.lifecycle_state === "persisted" && inactiveDraft) {
    return "review_workflow_automation";
  }
  if (
    active.kind === "workflow" &&
    active.lifecycle_state === "persisted" &&
    !state.latest_execution
  ) {
    return "run_workflow";
  }
  if (state.latest_execution?.diagnosis_available && !state.latest_diagnosis) {
    return "diagnose_latest_execution";
  }
  if (state.latest_execution && active.kind === "workflow" && !inactiveDraft) {
    return "run_workflow";
  }
  return null;
}
