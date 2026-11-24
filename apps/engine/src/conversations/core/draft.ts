import { isRunIdempotencyKey } from "../../execution/core/run-idempotency-key.ts";
import { isRecord } from "../../utils/type-guards.ts";
import { workflowJsonDigest } from "../../workflows/canonical-json.ts";
import { reconcileDraftSpec } from "../authoring-spec.ts";
import {
  CHECKPOINT_KEYS,
  createEmptyState,
  createEmptyWorkflowDraft,
  normalizeConnectorDraft,
  normalizeState,
  normalizeSummary,
  normalizeWorkflowDraft,
  surfaceModeFor,
} from "../authoring-state/normalize.ts";
import { pruneTracesForMutation, retainFingerprintValidTraces } from "../step-fingerprint.ts";
import { canonicalJson } from "../text-line-diff.ts";
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
} from "./authoring-summary.ts";

const INTAKE_ITEM_ID_RE = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i;
const UUID_RE = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i;

import type {
  AuthoringCheckpointKey,
  AuthoringCheckpointRecord,
  AuthoringMode,
  AuthoringState,
  AuthoringSummary,
  ConnectorDraftDocument,
  DraftDocument,
  JudgeBreakerState,
  LatestDiagnosisSummary,
  LatestExecutionSummary,
  PersistedResourceRef,
  TaskRunCheck,
  TaskRunMarker,
  WorkflowDraftDocument,
} from "../types.ts";

export { createEmptyWorkflowDraft };

export type DraftClock = () => string;

type RefreshedDraft = DraftDocument & { state: AuthoringState; summary: AuthoringSummary };

type DraftSummaryInput = Omit<DraftDocument, "mode"> & { mode?: AuthoringMode | undefined };

function uuidList(raw: unknown): string[] {
  if (!Array.isArray(raw)) return [];
  return [...new Set(raw.filter((id): id is string => typeof id === "string" && UUID_RE.test(id)))];
}

const NIL_UUID = "00000000-0000-0000-0000-000000000000";

export function normalizeTaskRunMarker(raw: unknown): TaskRunMarker | null {
  if (
    !isRecord(raw) ||
    raw.sealed !== undefined ||
    typeof raw.task_id !== "string" ||
    !UUID_RE.test(raw.task_id) ||
    typeof raw.task_run_id !== "string" ||
    !UUID_RE.test(raw.task_run_id) ||
    (raw.environment !== "dev" && raw.environment !== "prod")
  )
    return null;
  return {
    task_id: raw.task_id,
    task_run_id: raw.task_run_id,
    environment: raw.environment,
    workflow_ids: uuidList(raw.workflow_ids),
    connector_ids: uuidList(raw.connector_ids),
    web_search: raw.web_search === true,
  };
}

function storedTaskRunMarker(session: Record<string, unknown>): TaskRunMarker | null {
  if (session.task_run === undefined) return null;
  return (
    normalizeTaskRunMarker(session.task_run) ?? {
      task_id: NIL_UUID,
      task_run_id: NIL_UUID,
      environment: "dev",
      workflow_ids: [],
      connector_ids: [],
      web_search: false,
      sealed: true,
    }
  );
}

export function getTaskRunMarker(draft: unknown): TaskRunMarker | null {
  return isRecord(draft) && isRecord(draft.session) ? storedTaskRunMarker(draft.session) : null;
}

const ISO_INSTANT_RE =
  /^\d{4}-(0[1-9]|1[0-2])-(0[1-9]|[12]\d|3[01])T([01]\d|2[0-3]):[0-5]\d:[0-5]\d(\.\d{1,3})?(Z|[+-]([01]\d|2[0-3]):[0-5]\d)$/;

export function getTaskRunCheck(draft: unknown): TaskRunCheck | null {
  const raw = isRecord(draft) && isRecord(draft.session) ? draft.session.task_check : null;
  if (
    !isRecord(raw) ||
    typeof raw.at !== "string" ||
    !ISO_INSTANT_RE.test(raw.at) ||
    typeof raw.reason !== "string" ||
    raw.reason.length > 200
  )
    return null;
  return { at: raw.at, reason: raw.reason };
}

function withoutSessionKey<T>(draft: T, key: string): T {
  if (!isRecord(draft) || !isRecord(draft.session) || !(key in draft.session)) return draft;
  const session = Object.fromEntries(
    Object.entries(draft.session).filter(([name]) => name !== key),
  );
  return { ...draft, session };
}

export function withoutTaskRunMarker<T>(draft: T): T {
  return withoutSessionKey(draft, "task_run");
}

export function withoutTaskRunCheck<T>(draft: T): T {
  return withoutSessionKey(draft, "task_check");
}

export function createEmptyDraftDocument(now: DraftClock, mode?: AuthoringMode): RefreshedDraft {
  return refreshDraftSummary(now, {
    mode,
    workflow: createEmptyWorkflowDraft(),
    connector: null,
    latest_preview: null,
    state: createEmptyState(surfaceModeFor(mode)),
  });
}

function inferDraftMode(draft: DraftSummaryInput): AuthoringMode {
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
    judge_breaker: state.judge_breaker ? { ...state.judge_breaker } : null,
    latest_workflow_save_error: state.latest_workflow_save_error
      ? { ...state.latest_workflow_save_error }
      : null,
  };
}

function recordCheckpoint(
  now: DraftClock,
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
    verified_at: now(),
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
  now: DraftClock,
  draft: DraftDocument,
  connector: ConnectorDraftDocument | null,
  last_action: string | null,
): RefreshedDraft {
  const normalized = normalizeDraftDocument(now, draft);
  const state = cloneState(normalized.state);
  state.connector_mutation_seq += 1;
  state.latest_execution = null;
  state.latest_diagnosis = null;
  return refreshDraftSummary(now, {
    ...normalized,
    ...(connector ? { mode: "connector_authoring" as const } : {}),
    connector,
    state,
    summary: {
      ...normalized.summary,
      last_action,
    },
  });
}

function applyWorkflowMutation(
  now: DraftClock,
  draft: DraftDocument,
  requested: WorkflowDraftDocument,
  last_action: string | null,
): RefreshedDraft {
  const normalized = normalizeDraftDocument(now, draft);
  const workflow = reconcileDraftSpec(
    normalized.workflow,
    requested.service_package_source === undefined && normalized.workflow.service_package_source
      ? { ...requested, service_package_source: normalized.workflow.service_package_source }
      : requested,
  );
  const state = cloneState(normalized.state);
  if (canonicalJson(normalized.workflow) !== canonicalJson(workflow)) {
    state.workflow_mutation_seq += 1;
    state.latest_workflow_save_error = null;
  }
  const priorGoal = normalized.workflow.goal ?? null;
  const nextGoal = workflow.goal ?? null;
  if (
    priorGoal !== nextGoal ||
    workflowJsonDigest(normalized.workflow.spec ?? null) !==
      workflowJsonDigest(workflow.spec ?? null)
  ) {
    state.judge_breaker = null;
  }
  const priorTraces = normalized.latest_preview?.step_traces;
  return refreshDraftSummary(now, {
    ...normalized,
    mode: "workflow_authoring",
    workflow,
    ...(normalized.latest_preview
      ? {
          latest_preview: {
            ...normalized.latest_preview,
            step_traces: priorTraces
              ? pruneTracesForMutation(priorTraces, normalized.workflow.steps, workflow.steps)
              : [],
          },
        }
      : {}),
    state,
    summary: {
      ...normalized.summary,
      last_action,
    },
  });
}

export function refreshDraftSummary(now: DraftClock, draft: DraftSummaryInput): RefreshedDraft {
  const workflow = normalizeWorkflowDraft(draft);
  const connector = draft.connector ?? null;
  const mode = inferDraftMode({ ...draft, workflow, connector });
  const existingSummary = normalizeSummary(draft, now);
  const state = normalizeState(draft, mode, now);
  const active_target = computeActiveTarget(state, connector, workflow);
  const blocked_by = computeBlockedBy(
    state,
    connector,
    workflow,
    draft.latest_preview,
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
    last_action: existingSummary?.last_action ?? null,
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
    state,
    summary,
  };
}

export function normalizeDraftDocument(now: DraftClock, raw: unknown): RefreshedDraft {
  if (!isRecord(raw)) return createEmptyDraftDocument(now);
  const workflow = normalizeWorkflowDraft(raw);
  const connector = normalizeConnectorDraft(raw);
  const next: DraftDocument = {
    mode: raw.mode as AuthoringMode,
    summary: raw.summary as AuthoringSummary,
    workflow,
    connector,
    ...(() => {
      if (!isRecord(raw.session)) return {};
      const session: DraftDocument["session"] = {};
      if (raw.session.playground === true) session.playground = true;
      if (Array.isArray(raw.session.intake_item_ids)) {
        const intake_item_ids = [...new Set(raw.session.intake_item_ids)].filter(
          (id): id is string => typeof id === "string" && INTAKE_ITEM_ID_RE.test(id),
        );
        if (intake_item_ids.length > 0 && intake_item_ids.length <= 100) {
          session.intake_item_ids = intake_item_ids;
          if (raw.session.intake_review_locked === true) session.intake_review_locked = true;
        }
      }
      if (isRecord(raw.session.intake_read_item_versions)) {
        const intake_read_item_versions: Record<string, number> = {};
        for (const [id, version] of Object.entries(raw.session.intake_read_item_versions)) {
          if (
            INTAKE_ITEM_ID_RE.test(id) &&
            Number.isSafeInteger(version) &&
            (version as number) > 0
          ) {
            intake_read_item_versions[id] = version as number;
          }
        }
        if (Object.keys(intake_read_item_versions).length <= 100) {
          session.intake_read_item_versions = intake_read_item_versions;
        }
      }
      if (raw.session.intake_review_active === true) session.intake_review_active = true;
      if (
        isRecord(raw.session.live_test) &&
        typeof raw.session.live_test.workflow_id === "string" &&
        UUID_RE.test(raw.session.live_test.workflow_id) &&
        typeof raw.session.live_test.workflow_version_id === "string" &&
        UUID_RE.test(raw.session.live_test.workflow_version_id) &&
        raw.session.live_test.environment === "dev" &&
        typeof raw.session.live_test.input_digest === "string" &&
        /^[a-f0-9]{64}$/.test(raw.session.live_test.input_digest) &&
        typeof raw.session.live_test.idempotency_key === "string" &&
        isRunIdempotencyKey(raw.session.live_test.idempotency_key) &&
        (raw.session.live_test.state === "pending" ||
          raw.session.live_test.state === "running" ||
          raw.session.live_test.state === "succeeded" ||
          raw.session.live_test.state === "failed" ||
          raw.session.live_test.state === "blocked")
      ) {
        session.live_test = {
          workflow_id: raw.session.live_test.workflow_id,
          workflow_version_id: raw.session.live_test.workflow_version_id,
          environment: "dev",
          input: raw.session.live_test.input,
          input_digest: raw.session.live_test.input_digest,
          idempotency_key: raw.session.live_test.idempotency_key,
          state: raw.session.live_test.state,
          ...(typeof raw.session.live_test.execution_id === "string"
            ? { execution_id: raw.session.live_test.execution_id }
            : {}),
        };
      }
      const task_run = storedTaskRunMarker(raw.session);
      if (task_run) session.task_run = task_run;
      const task_check = getTaskRunCheck(raw);
      if (task_check) session.task_check = task_check;
      return Object.keys(session).length > 0 ? { session } : {};
    })(),
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
            ...(raw.latest_preview.redacted === true ? { redacted: true } : {}),
            ...(raw.latest_preview.mode === "schema_only" ? { mode: "schema_only" as const } : {}),
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
                        ...(typeof entry.fingerprint === "string"
                          ? { fingerprint: entry.fingerprint }
                          : {}),
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
                        ...(entry.held === true ? { held: true } : {}),
                        ...(entry.held === true && entry.held_request !== undefined
                          ? { held_request: entry.held_request }
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
          state: normalizeState(raw, raw.mode as AuthoringMode, now),
        }
      : {}),
  };
  return refreshDraftSummary(now, next);
}

export function getWorkflowDraft(now: DraftClock, draft: DraftDocument): WorkflowDraftDocument {
  return normalizeDraftDocument(now, draft).workflow;
}

export function withWorkflowDraft(
  now: DraftClock,
  draft: DraftDocument,
  workflow: WorkflowDraftDocument,
  last_action: string | null = draft.summary?.last_action ?? null,
): RefreshedDraft {
  return applyWorkflowMutation(now, draft, workflow, last_action);
}

export function hasInProgressWorkflowDraft(draft: DraftDocument): boolean {
  const workflow = draft.workflow;
  if (!workflow || workflow.steps.length === 0) return false;
  return !draft.summary?.persisted_resources.some(
    (resource) => resource.kind === "workflow" && resource.slug === workflow.slug,
  );
}

export function startNewWorkflowDraft(
  now: DraftClock,
  draft: DraftDocument,
  last_action: string | null = "workflow_target_reset",
): RefreshedDraft {
  const normalized = normalizeDraftDocument(now, draft);
  const state = cloneState(normalized.state);
  state.workflow_mutation_seq += 1;
  state.latest_execution = null;
  state.latest_diagnosis = null;
  state.judge_breaker = null;
  state.persisted_resources = state.persisted_resources.filter((item) => item.kind !== "workflow");
  delete state.checkpoints.workflow_inspected;
  delete state.checkpoints.workflow_validated;
  delete state.checkpoints.workflow_previewed;
  delete state.checkpoints.workflow_persisted;
  delete state.checkpoints.workflow_executed;
  delete state.checkpoints.workflow_diagnosed;
  return refreshDraftSummary(now, {
    ...normalized,
    mode: "workflow_authoring",
    workflow: createEmptyWorkflowDraft(),
    latest_preview: null,
    state,
    summary: {
      ...normalized.summary,
      last_action,
    },
  });
}

export function withConnectorDraft(
  now: DraftClock,
  draft: DraftDocument,
  connector: ConnectorDraftDocument | null,
  last_action: string | null = draft.summary?.last_action ?? null,
): RefreshedDraft {
  return applyConnectorMutation(now, draft, connector, last_action);
}

export function withAuthoringFocus(
  now: DraftClock,
  draft: DraftDocument,
  focus: "connector" | "workflow",
  options: { dropConnector?: boolean } = {},
): RefreshedDraft {
  const base = options.dropConnector
    ? withConnectorDraft(now, draft, null)
    : normalizeDraftDocument(now, draft);
  const state = cloneState(base.state);
  state.authoring_focus = focus === "connector" ? "connector" : null;
  return refreshDraftSummary(now, {
    ...base,
    mode: focus === "connector" ? "connector_authoring" : "workflow_authoring",
    state,
  });
}

export function withJudgeBreaker(
  now: DraftClock,
  draft: DraftDocument,
  judge_breaker: JudgeBreakerState | null,
): RefreshedDraft {
  const normalized = normalizeDraftDocument(now, draft);
  const state = cloneState(normalized.state);
  state.judge_breaker = judge_breaker ? { ...judge_breaker } : null;
  return refreshDraftSummary(now, {
    ...normalized,
    state,
  });
}

export function withLatestPreview(
  now: DraftClock,
  draft: DraftDocument,
  preview: DraftDocument["latest_preview"],
  tool_name = "dry_run_workflow",
  last_action: string | null = "workflow_previewed",
): RefreshedDraft {
  const normalized = normalizeDraftDocument(now, draft);
  const mergedPreview = ((): DraftDocument["latest_preview"] => {
    if (!preview || preview.redacted === true) return preview ?? null;
    const incoming = preview.step_traces ?? [];
    const incomingIds = new Set(incoming.map((t) => t.step_id));
    const prior = normalized.latest_preview?.step_traces;
    const retained = prior
      ? retainFingerprintValidTraces(prior, normalized.workflow.steps).filter(
          (t) => !incomingIds.has(t.step_id),
        )
      : [];
    const merged = [...retained, ...incoming];
    return merged.length > 0 ? { ...preview, step_traces: merged } : preview;
  })();
  let state = recordCheckpoint(
    now,
    normalized.state,
    "workflow_previewed",
    tool_name,
    preview?.ok ?? false,
    preview?.summary ?? "Workflow preview recorded.",
  );
  const redacted = preview?.redacted === true;
  if (redacted) {
    state.checkpoints.workflow_previewed = {
      ...(state.checkpoints.workflow_previewed as AuthoringCheckpointRecord),
      redacted: true,
    };
  }
  if (preview?.ok === true) {
    state = recordCheckpoint(
      now,
      state,
      "workflow_validated",
      tool_name,
      true,
      redacted
        ? "Structure checked; content not checked. This grants no live execution permission."
        : preview.warnings?.length
          ? "Preview completed with warnings. Review the recorded warnings; not every action was verified. This grants no live execution permission."
          : "Preview completed successfully for preparation. This grants no live execution permission.",
    );
  }
  return refreshDraftSummary(now, {
    ...normalized,
    mode: "workflow_authoring",
    latest_preview: mergedPreview ?? null,
    state,
    summary: {
      ...normalized.summary,
      last_action,
    },
  });
}

export function withConnectorInspection(
  now: DraftClock,
  draft: DraftDocument,
  last_action: string | null = "connector_inspected",
): RefreshedDraft {
  const normalized = normalizeDraftDocument(now, draft);
  const state = recordCheckpoint(
    now,
    normalized.state,
    "connector_inspected",
    "inspect_connector_draft",
    true,
    "Connector draft inspected.",
  );
  return refreshDraftSummary(now, {
    ...normalized,
    state,
    summary: { ...normalized.summary, last_action },
  });
}

export function withWorkflowInspection(
  now: DraftClock,
  draft: DraftDocument,
  last_action: string | null = "workflow_inspected",
): RefreshedDraft {
  const normalized = normalizeDraftDocument(now, draft);
  const state = recordCheckpoint(
    now,
    normalized.state,
    "workflow_inspected",
    "inspect_workflow_draft",
    true,
    "Workflow draft inspected.",
  );
  return refreshDraftSummary(now, {
    ...normalized,
    state,
    summary: { ...normalized.summary, last_action },
  });
}

export function withConnectorValidation(
  now: DraftClock,
  draft: DraftDocument,
  connector: ConnectorDraftDocument | null,
  ok: boolean,
  summary: string,
  last_action: string | null = "connector_validated",
): RefreshedDraft {
  const normalized = normalizeDraftDocument(now, draft);
  const state = recordCheckpoint(
    now,
    normalized.state,
    "connector_validated",
    "validate_connector_draft",
    ok,
    summary,
  );
  return refreshDraftSummary(now, {
    ...normalized,
    connector,
    state,
    summary: { ...normalized.summary, last_action },
  });
}

export function withWorkflowValidation(
  now: DraftClock,
  draft: DraftDocument,
  ok: boolean,
  summary: string,
  last_action: string | null = "workflow_validated",
): RefreshedDraft {
  const normalized = normalizeDraftDocument(now, draft);
  const state = recordCheckpoint(
    now,
    normalized.state,
    "workflow_validated",
    "validate_draft",
    ok,
    summary,
  );
  return refreshDraftSummary(now, {
    ...normalized,
    state,
    summary: { ...normalized.summary, last_action },
  });
}

export function withConnectorAuthenticated(
  now: DraftClock,
  draft: DraftDocument,
  connector: ConnectorDraftDocument | null,
  ok: boolean,
  summary: string,
  tool: string,
  last_action: string | null = "connector_authenticated",
): RefreshedDraft {
  const normalized = normalizeDraftDocument(now, draft);
  const state = recordCheckpoint(
    now,
    normalized.state,
    "connector_authenticated",
    tool,
    ok,
    summary,
  );
  return refreshDraftSummary(now, {
    ...normalized,
    connector,
    state,
    summary: { ...normalized.summary, last_action },
  });
}

export function withConnectorProbe(
  now: DraftClock,
  draft: DraftDocument,
  connector: ConnectorDraftDocument | null,
  ok: boolean,
  summary: string,
  last_action: string | null = "connector_probed",
): RefreshedDraft {
  const normalized = normalizeDraftDocument(now, draft);
  const state = recordCheckpoint(
    now,
    normalized.state,
    "connector_probed",
    "probe_connector_draft",
    ok,
    summary,
  );
  return refreshDraftSummary(now, {
    ...normalized,
    connector,
    state,
    summary: { ...normalized.summary, last_action },
  });
}

export function withConnectorPersisted(
  now: DraftClock,
  draft: DraftDocument,
  connector: ConnectorDraftDocument | null,
  resource: PersistedResourceRef,
  last_action: string | null = "connector_persisted",
): RefreshedDraft {
  const normalized = normalizeDraftDocument(now, draft);
  let state = addPersistedResource(normalized.state, resource);
  state = recordCheckpoint(
    now,
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
  return refreshDraftSummary(now, {
    ...normalized,
    connector,
    state,
    summary: { ...normalized.summary, last_action },
  });
}

export function withWorkflowPersisted(
  now: DraftClock,
  draft: DraftDocument,
  resource: PersistedResourceRef,
  last_action: string | null = "workflow_persisted",
): RefreshedDraft {
  return bindPersistedWorkflow(now, draft, resource, {
    tool_name: "save_workflow_draft",
    summary:
      resource.persistence_kind === "draft"
        ? `Workflow draft ${resource.name ?? resource.id} saved; activation is still required.`
        : `Workflow ${resource.name ?? resource.id} persisted.`,
    last_action,
  });
}

export function withWorkflowSaveError(
  now: DraftClock,
  draft: DraftDocument,
  error: { code: "draft_conflict"; message: string },
): RefreshedDraft {
  const normalized = normalizeDraftDocument(now, draft);
  const state = cloneState(normalized.state);
  state.latest_workflow_save_error = {
    code: error.code,
    message: error.message,
    mutation_seq: state.workflow_mutation_seq,
  };
  return refreshDraftSummary(now, {
    ...normalized,
    state,
    summary: {
      ...normalized.summary,
      last_action: "workflow_save_conflict",
    },
  });
}

export const WORKFLOW_BINDING_TOOL = "workflow_binding";

export function bindPersistedWorkflow(
  now: DraftClock,
  draft: DraftDocument,
  resource: PersistedResourceRef,
  options?: {
    tool_name?: string;
    summary?: string | null;
    last_action?: string | null;
  },
): RefreshedDraft {
  const normalized = normalizeDraftDocument(now, draft);
  let state = cloneState(normalized.state);
  state.judge_breaker = null;
  state.latest_workflow_save_error = null;
  state = addPersistedResource(state, resource);
  state = recordCheckpoint(
    now,
    state,
    "workflow_persisted",
    options?.tool_name ?? WORKFLOW_BINDING_TOOL,
    true,
    options?.summary ??
      (resource.persistence_kind === "draft"
        ? `Workflow draft ${resource.name ?? resource.id} saved; activation is still required.`
        : `Saved workflow ${resource.name ?? resource.id} is active.`),
    {
      kind: "workflow",
      id: resource.id,
      version_id: resource.version_id,
    },
  );
  return refreshDraftSummary(now, {
    ...normalized,
    state,
    summary: {
      ...normalized.summary,
      last_action: options?.last_action ?? normalized.summary.last_action,
    },
  });
}

export function withWorkflowExecution(
  now: DraftClock,
  draft: DraftDocument,
  execution: LatestExecutionSummary,
  last_action: string | null = "workflow_executed",
): RefreshedDraft {
  const normalized = normalizeDraftDocument(now, draft);
  let state = cloneState(normalized.state);
  state.latest_execution = execution;
  if (execution.diagnosis_available) state.latest_diagnosis = null;
  state = recordCheckpoint(
    now,
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
  return refreshDraftSummary(now, {
    ...normalized,
    state,
    summary: { ...normalized.summary, last_action },
  });
}

export function withFocusedExecution(
  now: DraftClock,
  draft: DraftDocument,
  execution: LatestExecutionSummary,
  last_action: string | null = "execution_focused",
): RefreshedDraft {
  const normalized = normalizeDraftDocument(now, draft);
  const state = cloneState(normalized.state);
  state.latest_execution = execution;
  state.latest_diagnosis = null;
  return refreshDraftSummary(now, {
    ...normalized,
    state,
    summary: { ...normalized.summary, last_action },
  });
}

export function withWorkflowDiagnosis(
  now: DraftClock,
  draft: DraftDocument,
  diagnosis: LatestDiagnosisSummary,
  last_action: string | null = "workflow_diagnosed",
): RefreshedDraft {
  const normalized = normalizeDraftDocument(now, draft);
  let state = cloneState(normalized.state);
  state.latest_diagnosis = diagnosis;
  state = recordCheckpoint(
    now,
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
  return refreshDraftSummary(now, {
    ...normalized,
    state,
    summary: { ...normalized.summary, last_action },
  });
}
