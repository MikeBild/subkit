// Authoring-state mutations + the public `with*` API.
//
// After the Phase 4 split (audit §4.2), the heavy compute / parsing
// logic lives in `authoring-state/`:
//
//   - `authoring-state/normalize.ts` — pure validators that coerce
//                                       `unknown` payloads into typed
//                                       drafts / state / summary
//   - `authoring-state/summary.ts`   — pure compute helpers that
//                                       derive the surfaced
//                                       `AuthoringSummary` from a
//                                       given state
//
// This file owns the mutating glue: state cloning, checkpoint
// recording, persisted-resource accumulation, and the 17 public
// `with*` helpers the chat loop calls after each tool succeeds.

import { isRecord } from "../utils/type-guards.ts";
import {
  CHECKPOINT_KEYS,
  createEmptyState,
  createEmptyWorkflowDraft,
  normalizeConnectorDraft,
  normalizeState,
  normalizeSummary,
  normalizeWorkflowDraft,
  nowIso,
} from "./authoring-state/normalize.ts";
import {
  checkpointSeq,
  checkpointView,
  computeActiveTarget,
  computeBlockedBy,
  computeConnectorMissingFields,
  computeNextAction,
  computeNextSuggestedTool,
  computeProgressLabel,
  computeReadiness,
  computeStage,
  computeSurfaceMode,
  computeWorkflowMissingFields,
  emptySummary,
} from "./authoring-state/summary.ts";
import type {
  AuthoringCheckpointKey,
  AuthoringCheckpointRecord,
  AuthoringMode,
  AuthoringState,
  AuthoringSummary,
  ConnectorDraftDocument,
  DraftDocument,
  LatestDiagnosisSummary,
  LatestExecutionSummary,
  PersistedResourceRef,
  WorkflowDraftDocument,
} from "./types.ts";

export { createEmptyWorkflowDraft } from "./authoring-state/normalize.ts";

export function createEmptyDraftDocument(mode: AuthoringMode = "onboarding"): DraftDocument {
  return refreshDraftSummary({
    mode,
    workflow: createEmptyWorkflowDraft(),
    connector: null,
    latest_preview: null,
    state: createEmptyState(modeFromLegacy(mode)),
  });
}

function modeFromLegacy(mode: AuthoringMode | undefined): "connector" | "workflow" {
  if (mode === "workflow_authoring" || mode === "resume_review") return "workflow";
  return "connector";
}

function inferLegacyMode(draft: DraftDocument): AuthoringMode {
  if (
    draft.mode === "onboarding" ||
    draft.mode === "connector_authoring" ||
    draft.mode === "workflow_authoring" ||
    draft.mode === "resume_review"
  ) {
    return draft.mode;
  }
  if (draft.connector && !draft.connector.saved_connector_id) return "connector_authoring";
  if (draft.workflow && draft.workflow.steps.length > 0) return "workflow_authoring";
  return "onboarding";
}

function cloneState(state: AuthoringState): AuthoringState {
  return {
    ...state,
    checkpoints: { ...state.checkpoints },
    persisted_resources: [...state.persisted_resources],
    latest_execution: state.latest_execution ? { ...state.latest_execution } : null,
    latest_diagnosis: state.latest_diagnosis
      ? {
          ...state.latest_diagnosis,
          warning_sources: [...state.latest_diagnosis.warning_sources],
          steps: state.latest_diagnosis.steps.map((step) => ({ ...step })),
        }
      : null,
  };
}

function recordCheckpoint(
  state: AuthoringState,
  key: AuthoringCheckpointKey,
  tool: string,
  ok: boolean | null,
  summary: string | null,
  resource_ref?: AuthoringCheckpointRecord["resource_ref"],
): AuthoringState {
  const next = cloneState(state);
  next.checkpoints[key] = {
    key,
    verified_at: nowIso(),
    verified_by_tool: tool,
    mutation_seq: checkpointSeq(next, key),
    ok,
    summary,
    resource_ref: resource_ref ?? null,
  };
  return next;
}

function addPersistedResource(
  state: AuthoringState,
  resource: PersistedResourceRef,
): AuthoringState {
  const next = cloneState(state);
  next.persisted_resources = [
    resource,
    ...next.persisted_resources.filter(
      (item) => !(item.kind === resource.kind && item.id === resource.id),
    ),
  ];
  return next;
}

function applyConnectorMutation(
  draft: DraftDocument,
  connector: ConnectorDraftDocument | null,
  last_action: string | null,
): DraftDocument {
  const normalized = normalizeDraftDocument(draft);
  const state = cloneState(normalized.state ?? createEmptyState("connector"));
  state.mode = "connector";
  state.stage = connector ? "connector_draft_started" : "idle";
  state.connector_mutation_seq += 1;
  state.latest_execution = null;
  state.latest_diagnosis = null;
  return refreshDraftSummary({
    ...normalized,
    ...(connector
      ? { mode: "connector_authoring" as const }
      : normalized.mode
        ? { mode: normalized.mode }
        : {}),
    connector,
    state,
    summary: {
      ...(normalized.summary ?? emptySummary()),
      last_action,
    },
  });
}

function applyWorkflowMutation(
  draft: DraftDocument,
  workflow: WorkflowDraftDocument,
  last_action: string | null,
): DraftDocument {
  const normalized = normalizeDraftDocument(draft);
  const state = cloneState(normalized.state ?? createEmptyState("workflow"));
  state.mode = "workflow";
  state.stage = workflow.steps.length > 0 ? "workflow_draft_started" : "workflow_targeted";
  state.workflow_mutation_seq += 1;
  state.latest_execution = null;
  state.latest_diagnosis = null;
  return refreshDraftSummary({
    ...normalized,
    mode: "workflow_authoring",
    workflow,
    state,
    summary: {
      ...(normalized.summary ?? emptySummary()),
      last_action,
    },
  });
}

export function refreshDraftSummary(draft: DraftDocument): DraftDocument {
  const workflow = normalizeWorkflowDraft(draft);
  const connector = draft.connector ?? null;
  const mode = inferLegacyMode({ ...draft, workflow, connector });
  const existingSummary = normalizeSummary(draft) ?? undefined;
  const state = normalizeState(draft, mode);
  const active_target = computeActiveTarget(state, connector, workflow);
  const blocked_by = computeBlockedBy(
    state,
    connector,
    workflow,
    draft.latest_preview ?? null,
    active_target,
  );
  const next_action = computeNextAction(state, active_target, blocked_by, workflow);
  const next_suggested_tool = computeNextSuggestedTool(state, active_target, blocked_by, workflow);
  const missing_fields =
    active_target.kind === "connector"
      ? computeConnectorMissingFields(connector)
      : computeWorkflowMissingFields(workflow, active_target);
  state.mode = computeSurfaceMode(state, active_target);
  state.stage = computeStage(state, active_target);
  const summary: AuthoringSummary = {
    readiness: computeReadiness(active_target, blocked_by),
    next_action,
    next_required_action: next_action,
    next_suggested_tool,
    missing_fields,
    last_action: existingSummary?.last_action ?? draft.summary?.last_action ?? null,
    progress_label: computeProgressLabel(active_target, connector, workflow),
    mode: state.mode,
    stage: state.stage,
    lifecycle_state: active_target.lifecycle_state,
    active_target,
    blocked_by,
    checkpoints: CHECKPOINT_KEYS.map((key) => checkpointView(state, key)),
    persisted_resources: [...state.persisted_resources],
    latest_execution: state.latest_execution,
    latest_diagnosis: state.latest_diagnosis,
  };

  return {
    ...draft,
    mode,
    workflow,
    connector,
    ...(draft.session ? { session: draft.session } : {}),
    state,
    summary,
  };
}

export function normalizeDraftDocument(raw: unknown): DraftDocument {
  if (!isRecord(raw)) return createEmptyDraftDocument();
  const workflow = normalizeWorkflowDraft(raw);
  const connector = normalizeConnectorDraft(raw);
  const summary = normalizeSummary(raw);
  const next: DraftDocument = {
    ...(typeof raw.mode === "string" ? { mode: raw.mode as AuthoringMode } : {}),
    workflow,
    connector,
    ...(isRecord(raw.session) &&
    (raw.session.permission_mode === "auto" ||
      raw.session.permission_mode === "ask" ||
      raw.session.permission_mode === "plan")
      ? {
          session: {
            permission_mode: raw.session.permission_mode,
          },
        }
      : {}),
    ...(isRecord(raw.latest_preview)
      ? {
          latest_preview: {
            ok: raw.latest_preview.ok === true,
            step_id:
              typeof raw.latest_preview.step_id === "string" ? raw.latest_preview.step_id : null,
            summary:
              typeof raw.latest_preview.summary === "string"
                ? raw.latest_preview.summary
                : "Preview executed.",
            ...(raw.latest_preview.preview !== undefined
              ? { preview: raw.latest_preview.preview }
              : {}),
            ...(Array.isArray(raw.latest_preview.warnings)
              ? { warnings: raw.latest_preview.warnings }
              : {}),
            ...(raw.latest_preview.requires_repair === true ? { requires_repair: true } : {}),
            ...(raw.latest_preview.input !== undefined ? { input: raw.latest_preview.input } : {}),
            ...(Array.isArray(raw.latest_preview.step_traces)
              ? {
                  step_traces: raw.latest_preview.step_traces
                    .filter((entry: unknown): entry is Record<string, unknown> => isRecord(entry))
                    .map((entry: Record<string, unknown>) => {
                      const scope =
                        isRecord(entry.scope_at_step) &&
                        Array.isArray(
                          (entry.scope_at_step as Record<string, unknown>).available_paths,
                        )
                          ? {
                              available_paths: (
                                (entry.scope_at_step as Record<string, unknown>)
                                  .available_paths as unknown[]
                              ).filter((s): s is string => typeof s === "string"),
                              shape_summary:
                                typeof (entry.scope_at_step as Record<string, unknown>)
                                  .shape_summary === "string"
                                  ? ((entry.scope_at_step as Record<string, unknown>)
                                      .shape_summary as string)
                                  : "unknown",
                              primary_data_path:
                                typeof (entry.scope_at_step as Record<string, unknown>)
                                  .primary_data_path === "string"
                                  ? ((entry.scope_at_step as Record<string, unknown>)
                                      .primary_data_path as string)
                                  : null,
                            }
                          : undefined;
                      return {
                        step_id: typeof entry.step_id === "string" ? entry.step_id : "(unknown)",
                        kind: typeof entry.kind === "string" ? entry.kind : "unknown",
                        status: typeof entry.status === "string" ? entry.status : "unknown",
                        ...(typeof entry.duration_ms === "number"
                          ? { duration_ms: entry.duration_ms }
                          : {}),
                        ...(entry.output_preview !== undefined
                          ? { output_preview: entry.output_preview }
                          : {}),
                        ...(entry.raw_preview !== undefined
                          ? { raw_preview: entry.raw_preview }
                          : {}),
                        ...(scope ? { scope_at_step: scope } : {}),
                        ...(entry.request_meta !== undefined
                          ? { request_meta: entry.request_meta }
                          : {}),
                        ...(typeof entry.error_code === "string"
                          ? { error_code: entry.error_code }
                          : {}),
                      };
                    }),
                }
              : {}),
          },
        }
      : {}),
    ...(isRecord(raw.state)
      ? {
          state: normalizeState(raw, raw.mode as AuthoringMode),
        }
      : {}),
  };
  if (summary) next.summary = summary;
  return refreshDraftSummary(next);
}

export function getWorkflowDraft(draft: DraftDocument): WorkflowDraftDocument {
  return normalizeDraftDocument(draft).workflow;
}

export function withWorkflowDraft(
  draft: DraftDocument,
  workflow: WorkflowDraftDocument,
  last_action: string | null = draft.summary?.last_action ?? null,
): DraftDocument {
  return applyWorkflowMutation(draft, workflow, last_action);
}

/**
 * True when the draft holds a non-empty WORKFLOW draft that is NOT already a
 * persisted workflow (its slug doesn't match any persisted workflow resource).
 * i.e. there is unsaved authored work in flight.
 *
 * Single source of truth for the guard that stops the `startNewWorkflow`
 * intent heuristic in `loop.ts` from wiping in-progress authoring — shared
 * with its unit test so the predicate can't drift between gate and test.
 */
export function hasInProgressWorkflowDraft(draft: DraftDocument): boolean {
  if ((draft.workflow?.steps.length ?? 0) === 0) return false;
  const slug = draft.workflow?.slug;
  return !draft.summary?.persisted_resources.some(
    (resource) => resource.kind === "workflow" && resource.slug === slug,
  );
}

export function startNewWorkflowDraft(
  draft: DraftDocument,
  last_action: string | null = "workflow_target_reset",
): DraftDocument {
  const normalized = normalizeDraftDocument(draft);
  const state = cloneState(normalized.state ?? createEmptyState("workflow"));
  state.mode = "workflow";
  state.stage = "idle";
  state.workflow_mutation_seq += 1;
  state.latest_execution = null;
  state.latest_diagnosis = null;
  state.persisted_resources = state.persisted_resources.filter((item) => item.kind !== "workflow");
  delete state.checkpoints.workflow_inspected;
  delete state.checkpoints.workflow_validated;
  delete state.checkpoints.workflow_previewed;
  delete state.checkpoints.workflow_persisted;
  delete state.checkpoints.workflow_executed;
  delete state.checkpoints.workflow_diagnosed;
  return refreshDraftSummary({
    ...normalized,
    mode: "workflow_authoring",
    workflow: createEmptyWorkflowDraft(),
    latest_preview: null,
    state,
    summary: {
      ...(normalized.summary ?? emptySummary()),
      last_action,
    },
  });
}

export function withConnectorDraft(
  draft: DraftDocument,
  connector: ConnectorDraftDocument | null,
  last_action: string | null = draft.summary?.last_action ?? null,
): DraftDocument {
  return applyConnectorMutation(draft, connector, last_action);
}

export function withLatestPreview(
  draft: DraftDocument,
  preview: DraftDocument["latest_preview"],
  tool_name = "dry_run_workflow",
  last_action: string | null = "workflow_previewed",
): DraftDocument {
  const normalized = normalizeDraftDocument(draft);
  let state = cloneState(normalized.state ?? createEmptyState("workflow"));
  state.mode = "workflow";
  state = recordCheckpoint(
    state,
    "workflow_previewed",
    tool_name,
    preview?.ok ?? false,
    preview?.summary ?? "Workflow preview recorded.",
  );
  // G5 (runtime-logs review plan): a clean end-to-end preview IS
  // validation — every step ran against real data with real
  // credentials and returned a real response. Pre-fix the
  // `workflow_validated` checkpoint was only set by step-level
  // `validate_draft` / `dry_run_step`, so an auto-persist driven by
  // a green `dry_run_workflow` left `validated_step_count` at 0 and
  // the critic later logged `verdict: fail failed_checks:
  // [validated_step_present]` 15 s after the commit row was already
  // written (session ed20f48d). Recording `workflow_validated` here
  // when the preview is clean closes that false-fail without
  // restructuring the turn loop's critic-after-commit ordering.
  if (preview?.ok === true) {
    state = recordCheckpoint(
      state,
      "workflow_validated",
      tool_name,
      true,
      "End-to-end dry-run completed without errors — counts as validation.",
    );
  }
  return refreshDraftSummary({
    ...normalized,
    mode: "workflow_authoring",
    latest_preview: preview ?? null,
    state,
    summary: {
      ...(normalized.summary ?? emptySummary()),
      last_action,
    },
  });
}

export function withConnectorInspection(
  draft: DraftDocument,
  last_action: string | null = "connector_inspected",
): DraftDocument {
  const normalized = normalizeDraftDocument(draft);
  let state = cloneState(normalized.state ?? createEmptyState("connector"));
  state.mode = "connector";
  state = recordCheckpoint(
    state,
    "connector_inspected",
    "inspect_connector_draft",
    true,
    "Connector draft inspected.",
  );
  return refreshDraftSummary({
    ...normalized,
    state,
    summary: { ...(normalized.summary ?? emptySummary()), last_action },
  });
}

export function withWorkflowInspection(
  draft: DraftDocument,
  last_action: string | null = "workflow_inspected",
): DraftDocument {
  const normalized = normalizeDraftDocument(draft);
  let state = cloneState(normalized.state ?? createEmptyState("workflow"));
  state.mode = "workflow";
  state = recordCheckpoint(
    state,
    "workflow_inspected",
    "inspect_workflow_draft",
    true,
    "Workflow draft inspected.",
  );
  return refreshDraftSummary({
    ...normalized,
    state,
    summary: { ...(normalized.summary ?? emptySummary()), last_action },
  });
}

export function withConnectorValidation(
  draft: DraftDocument,
  connector: ConnectorDraftDocument | null,
  ok: boolean,
  summary: string,
  last_action: string | null = "connector_validated",
): DraftDocument {
  const normalized = normalizeDraftDocument(draft);
  let state = cloneState(normalized.state ?? createEmptyState("connector"));
  state.mode = "connector";
  state = recordCheckpoint(state, "connector_validated", "validate_connector_draft", ok, summary);
  return refreshDraftSummary({
    ...normalized,
    connector,
    state,
    summary: { ...(normalized.summary ?? emptySummary()), last_action },
  });
}

export function withWorkflowValidation(
  draft: DraftDocument,
  ok: boolean,
  summary: string,
  last_action: string | null = "workflow_validated",
): DraftDocument {
  const normalized = normalizeDraftDocument(draft);
  let state = cloneState(normalized.state ?? createEmptyState("workflow"));
  state.mode = "workflow";
  state = recordCheckpoint(state, "workflow_validated", "validate_draft", ok, summary);
  return refreshDraftSummary({
    ...normalized,
    state,
    summary: { ...(normalized.summary ?? emptySummary()), last_action },
  });
}

export function withConnectorAuthenticated(
  draft: DraftDocument,
  connector: ConnectorDraftDocument | null,
  ok: boolean,
  summary: string,
  tool: string,
  last_action: string | null = "connector_authenticated",
): DraftDocument {
  const normalized = normalizeDraftDocument(draft);
  let state = cloneState(normalized.state ?? createEmptyState("connector"));
  state.mode = "connector";
  state = recordCheckpoint(state, "connector_authenticated", tool, ok, summary);
  return refreshDraftSummary({
    ...normalized,
    connector,
    state,
    summary: { ...(normalized.summary ?? emptySummary()), last_action },
  });
}

export function withConnectorProbe(
  draft: DraftDocument,
  connector: ConnectorDraftDocument | null,
  ok: boolean,
  summary: string,
  last_action: string | null = "connector_probed",
): DraftDocument {
  const normalized = normalizeDraftDocument(draft);
  let state = cloneState(normalized.state ?? createEmptyState("connector"));
  state.mode = "connector";
  state = recordCheckpoint(state, "connector_probed", "probe_connector_draft", ok, summary);
  return refreshDraftSummary({
    ...normalized,
    connector,
    state,
    summary: { ...(normalized.summary ?? emptySummary()), last_action },
  });
}

export function withConnectorPersisted(
  draft: DraftDocument,
  connector: ConnectorDraftDocument | null,
  resource: PersistedResourceRef,
  last_action: string | null = "connector_persisted",
): DraftDocument {
  const normalized = normalizeDraftDocument(draft);
  let state = cloneState(normalized.state ?? createEmptyState("connector"));
  state.mode = "connector";
  state = addPersistedResource(state, resource);
  state = recordCheckpoint(
    state,
    "connector_persisted",
    "save_connector_draft",
    true,
    `Connector ${resource.name ?? resource.id} persisted.`,
    {
      kind: "connector",
      id: resource.id,
      version_id: null,
    },
  );
  return refreshDraftSummary({
    ...normalized,
    connector,
    state,
    summary: { ...(normalized.summary ?? emptySummary()), last_action },
  });
}

export function withWorkflowPersisted(
  draft: DraftDocument,
  resource: PersistedResourceRef,
  last_action: string | null = "workflow_persisted",
): DraftDocument {
  return bindPersistedWorkflow(draft, resource, {
    tool_name: "save_workflow_draft",
    summary: `Workflow ${resource.name ?? resource.id} persisted.`,
    last_action,
  });
}

export function bindPersistedWorkflow(
  draft: DraftDocument,
  resource: PersistedResourceRef,
  options?: {
    tool_name?: string;
    summary?: string | null;
    last_action?: string | null;
  },
): DraftDocument {
  const normalized = normalizeDraftDocument(draft);
  let state = cloneState(normalized.state ?? createEmptyState("workflow"));
  state.mode = state.latest_diagnosis
    ? "diagnosis"
    : state.latest_execution
      ? "execution"
      : "workflow";
  state = addPersistedResource(state, resource);
  state = recordCheckpoint(
    state,
    "workflow_persisted",
    options?.tool_name ?? "workflow_binding",
    true,
    options?.summary ?? `Saved workflow ${resource.name ?? resource.id} is active.`,
    {
      kind: "workflow",
      id: resource.id,
      version_id: resource.version_id,
    },
  );
  return refreshDraftSummary({
    ...normalized,
    state,
    summary: {
      ...(normalized.summary ?? emptySummary()),
      last_action: options?.last_action ?? normalized.summary?.last_action ?? null,
    },
  });
}

export function withWorkflowExecution(
  draft: DraftDocument,
  execution: LatestExecutionSummary,
  last_action: string | null = "workflow_executed",
): DraftDocument {
  const normalized = normalizeDraftDocument(draft);
  let state = cloneState(normalized.state ?? createEmptyState("execution"));
  state.mode = execution.diagnosis_available ? "diagnosis" : "execution";
  state.latest_execution = execution;
  if (execution.diagnosis_available) state.latest_diagnosis = null;
  state = recordCheckpoint(
    state,
    "workflow_executed",
    "run_workflow",
    execution.status === "succeeded",
    `Execution ${execution.execution_id} finished with status ${execution.status}.`,
    {
      kind: "execution",
      id: execution.execution_id,
      version_id: execution.workflow_version_id,
    },
  );
  return refreshDraftSummary({
    ...normalized,
    state,
    summary: { ...(normalized.summary ?? emptySummary()), last_action },
  });
}

export function withWorkflowDiagnosis(
  draft: DraftDocument,
  diagnosis: LatestDiagnosisSummary,
  last_action: string | null = "workflow_diagnosed",
): DraftDocument {
  const normalized = normalizeDraftDocument(draft);
  let state = cloneState(normalized.state ?? createEmptyState("diagnosis"));
  state.mode = "diagnosis";
  state.latest_diagnosis = diagnosis;
  state = recordCheckpoint(
    state,
    "workflow_diagnosed",
    "diagnose_latest_execution",
    true,
    diagnosis.reason,
    {
      kind: "diagnosis",
      id: diagnosis.execution_id,
      version_id: null,
    },
  );
  return refreshDraftSummary({
    ...normalized,
    state,
    summary: { ...(normalized.summary ?? emptySummary()), last_action },
  });
}
