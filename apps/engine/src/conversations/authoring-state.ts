// Authoring-state mutations + the public `with*` API.
//
// The heavy compute / parsing logic lives in `authoring-state/`:
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
import { pruneTracesForMutation, retainFingerprintValidTraces } from "./step-fingerprint.ts";
import { canonicalJson } from "./text-line-diff.ts";
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
    judge_breaker: state.judge_breaker ? { ...state.judge_breaker } : null,
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
  // Every changed definition invalidates whole-workflow evidence and the saved
  // checkpoint. Per-step evidence is retained below only for unchanged steps.
  if (canonicalJson(normalized.workflow) !== canonicalJson(workflow)) {
    state.workflow_mutation_seq += 1;
  }
  // Judge breaker hygiene (P3): `blocks_since_commit` is a MONOTONIC
  // count of judge blocks since the last successful commit — a same-goal
  // edit must NOT reset it, or a model churning edits between blocks
  // resets the breaker on every fingerprint change and never converges
  // (the C1 loop). Only a commit clears it (see `clearJudgeBreakerOnCommit`).
  // The fingerprint-keyed verdict memo (`last_verdict`) is naturally
  // invalidated by an edit — it only matches when the fingerprint
  // matches — so a stale memo after a step change is harmless and is
  // left in place rather than cleared.
  //
  // BUT a GOAL CHANGE invalidates the count: the goal is the judge's
  // evaluation target, so blocks accumulated against goal A must not
  // carry into goal B (else the first green preview for B degrades
  // straight to advisory and auto-commits WITHOUT the judge ever
  // blocking once on B — the green-but-wrong commit the judge exists
  // to prevent). Reset the breaker (count + memo) when the goal differs.
  const priorGoal = normalized.workflow?.goal ?? null;
  const nextGoal = workflow.goal ?? null;
  if (priorGoal !== nextGoal) {
    state.judge_breaker = null;
  }
  // Fingerprint-keyed evidence retention (Fix 5, session 784c1b02).
  // A mutation drops preview evidence ONLY for steps whose definition
  // changed (or which were removed); unchanged steps keep their
  // recorded `scope_at_step` / `output_preview`, so the loop/transform
  // authoring gates stay satisfied without a redundant dry-run.
  // Pre-fix every mutation left the traces untouched (stale evidence
  // could satisfy a gate against a rewritten step) while other paths
  // wiped them wholesale — both wrong; the fingerprint is the single
  // retention rule now.
  const latest_preview = normalized.latest_preview
    ? {
        ...normalized.latest_preview,
        step_traces: pruneTracesForMutation(
          normalized.latest_preview.step_traces ?? [],
          normalized.workflow?.steps ?? [],
          workflow.steps,
        ),
      }
    : normalized.latest_preview;
  return refreshDraftSummary({
    ...normalized,
    mode: "workflow_authoring",
    workflow,
    ...(latest_preview !== undefined ? { latest_preview } : {}),
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
    ...(() => {
      // Carry the durable session sub-document across the DB round-trip.
      // Both `permission_mode` (auto/ask/plan — `yolo` is intentionally
      // non-persistent) and the `playground` sandbox flag must survive, or
      // the loop would silently lose them on the next turn's read
      // (the authoring-drift data-loss class).
      if (!isRecord(raw.session)) return {};
      const session: DraftDocument["session"] = {};
      if (
        raw.session.permission_mode === "auto" ||
        raw.session.permission_mode === "ask" ||
        raw.session.permission_mode === "plan"
      ) {
        session.permission_mode = raw.session.permission_mode;
      }
      if (raw.session.playground === true) session.playground = true;
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
                        // Hold-writes preview artifacts: the materialized
                        // never-dispatched request is the step's reviewable
                        // payload — it must survive normalization so the
                        // NEXT turn's context still shows the would-be send.
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
  // A fresh workflow target is a fresh judge subject — drop any blocks
  // accumulated against the previous goal (P3).
  state.judge_breaker = null;
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

/**
 * Record the preview-judge circuit-breaker state (Fix C). Pure draft
 * mutation like every other `with*` helper — callers pass the next
 * breaker value (or null to clear) and the state survives the
 * normalize/serialize round-trip alongside the fingerprint evidence.
 */
export function withJudgeBreaker(
  draft: DraftDocument,
  judge_breaker: JudgeBreakerState | null,
): DraftDocument {
  const normalized = normalizeDraftDocument(draft);
  const state = cloneState(normalized.state ?? createEmptyState("workflow"));
  state.judge_breaker = judge_breaker ? { ...judge_breaker } : null;
  return refreshDraftSummary({
    ...normalized,
    state,
  });
}

export function withLatestPreview(
  draft: DraftDocument,
  preview: DraftDocument["latest_preview"],
  tool_name = "dry_run_workflow",
  last_action: string | null = "workflow_previewed",
): DraftDocument {
  const normalized = normalizeDraftDocument(draft);
  // Fingerprint-keyed evidence merge. The incoming preview only
  // carries traces for the steps the new walk actually touched — a
  // single-step `dry_run_step`, or a refused dry-run ("Preview blocked
  // until the workflow draft validates cleanly") that carries NO traces
  // at all. Pre-fix the new preview REPLACED `step_traces` wholesale,
  // so one blocked dry-run destroyed every recorded `scope_at_step`
  // and the loop/transform gates deadlocked the next mutation
  // (session 784c1b02: 16× `loop_authoring_requires_inspect`).
  // Merge instead: incoming traces win for their step ids; existing
  // traces survive iff their fingerprint still matches the current
  // draft step.
  const mergedPreview = ((): DraftDocument["latest_preview"] => {
    if (!preview) return preview ?? null;
    const incoming = preview.step_traces ?? [];
    const incomingIds = new Set(incoming.map((t) => t.step_id));
    const retained = retainFingerprintValidTraces(
      normalized.latest_preview?.step_traces ?? [],
      normalized.workflow?.steps ?? [],
    ).filter((t) => !incomingIds.has(t.step_id));
    const merged = [...retained, ...incoming];
    return merged.length > 0 ? { ...preview, step_traces: merged } : preview;
  })();
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
    latest_preview: mergedPreview ?? null,
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
    summary:
      resource.persistence_kind === "draft"
        ? `Workflow draft ${resource.name ?? resource.id} saved; activation is still required.`
        : `Workflow ${resource.name ?? resource.id} persisted.`,
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
  // Judge breaker reset (P3): a successful commit is the ONLY event
  // that clears `blocks_since_commit`. Every commit path funnels
  // through here (auto-commit on green dry-run + explicit/force
  // save_workflow_draft both call commitWorkflowAtomic →
  // withWorkflowPersisted → here), so this is the single reset site.
  // The fingerprint-keyed verdict memo is dropped too — the committed
  // definition no longer needs a cached "is this preview good?" answer.
  state.judge_breaker = null;
  state = addPersistedResource(state, resource);
  state = recordCheckpoint(
    state,
    "workflow_persisted",
    options?.tool_name ?? "workflow_binding",
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
