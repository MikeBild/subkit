import { toPublicConnector } from "../../connectors/public-view.ts";
import type { ConnectorView } from "../../connectors/types.ts";
import { isRecord } from "../../utils/type-guards.ts";
import { WORKFLOW_DEF_FIELD_KEYS, type WorkflowTrigger } from "../../workflows/types.ts";
import { readStoredSpec } from "../../workflows/version-spec.ts";
import type {
  AuthoringCheckpointKey,
  AuthoringCheckpointRecord,
  AuthoringCheckpointStatus,
  AuthoringCheckpointView,
  AuthoringMode,
  AuthoringStage,
  AuthoringState,
  AuthoringSummary,
  AuthoringSurfaceMode,
  ConnectorDraftDocument,
  JudgeBreakerState,
  JudgeVerdictMemo,
  LatestDiagnosisSummary,
  LatestExecutionSummary,
  PersistedResourceRef,
  WorkflowDraftDocument,
} from "../types.ts";

const CHECKPOINT_KEYS: readonly AuthoringCheckpointKey[] = [
  "connector_inspected",
  "connector_validated",
  "connector_authenticated",
  "connector_probed",
  "connector_persisted",
  "workflow_inspected",
  "workflow_validated",
  "workflow_previewed",
  "workflow_persisted",
  "workflow_executed",
  "workflow_diagnosed",
];

function nowIso(): string {
  return new Date().toISOString();
}

export function createEmptyWorkflowDraft(): WorkflowDraftDocument {
  return {
    name: "new-workflow",
    steps: [],
  };
}

export function createEmptyState(mode: AuthoringSurfaceMode): AuthoringState {
  return {
    mode,
    stage: "idle",
    connector_mutation_seq: 0,
    workflow_mutation_seq: 0,
    checkpoints: {},
    persisted_resources: [],
    latest_execution: null,
    latest_diagnosis: null,
    judge_breaker: null,
    latest_workflow_save_error: null,
  };
}

function normalizeWorkflowSaveError(
  value: unknown,
): NonNullable<AuthoringState["latest_workflow_save_error"]> | null {
  if (!isRecord(value) || value.code !== "draft_conflict") return null;
  if (typeof value.message !== "string" || value.message.length === 0) return null;
  if (
    typeof value.mutation_seq !== "number" ||
    !Number.isSafeInteger(value.mutation_seq) ||
    value.mutation_seq < 0
  ) {
    return null;
  }
  return {
    code: "draft_conflict",
    message: value.message.slice(0, 1_000),
    mutation_seq: value.mutation_seq,
  };
}

export function surfaceModeFor(mode: AuthoringMode | undefined): AuthoringSurfaceMode {
  if (mode === "workflow_authoring" || mode === "resume_review") return "workflow";
  return "connector";
}

export function hydrateDraftFromSavedConnector(view: ConnectorView): ConnectorDraftDocument {
  const saved = toPublicConnector(view);
  const next: ConnectorDraftDocument = {
    name: saved.display_name,
    slug: saved.slug,
    driver: saved.driver,
    environment: saved.environment,
    auth_type: saved.auth_type,
    config: saved.config ?? {},
    template_slug: saved.template_slug,
    template_name: saved.template_name,
    template_source: saved.template_source,
    latest_probe: null,
    saved_connector_id: saved.id,
  };
  if (saved.base_url) next.base_url = saved.base_url;
  if (saved.dsn) next.dsn = saved.dsn;
  return next;
}

export function normalizeWorkflowDraft(raw: unknown): WorkflowDraftDocument {
  const fallback = createEmptyWorkflowDraft();
  if (!isRecord(raw) || !isRecord(raw.workflow)) return fallback;
  const base = raw.workflow;
  const pickString = (key: string): string | undefined => {
    const value = base[key];
    return typeof value === "string" && value.length > 0 ? value : undefined;
  };
  const name = pickString("name") ?? fallback.name;
  const slug = pickString("slug");
  const description = pickString("description");
  const goal = pickString("goal");
  const spec = readStoredSpec(base.spec);
  const outputTransform = pickString("output_transform");
  const derivedFromSkillId = pickString("derived_from_skill_id");
  const normalized: WorkflowDraftDocument = {
    name,
    ...(slug ? { slug } : {}),
    ...(description ? { description } : {}),
    ...(goal ? { goal } : {}),
    ...(spec ? { spec } : {}),
    ...(derivedFromSkillId
      ? { derived_from_skill_id: derivedFromSkillId }
      : base.derived_from_skill_id === null
        ? { derived_from_skill_id: null }
        : {}),
    steps: Array.isArray(base.steps)
      ? base.steps.filter((step): step is Record<string, unknown> => isRecord(step))
      : [],
    ...(isRecord(base.input_schema) ? { input_schema: base.input_schema } : {}),
    ...(base.input_schema_sample !== undefined && base.input_schema_sample !== null
      ? { input_schema_sample: base.input_schema_sample }
      : {}),
    ...(isRecord(base.output_schema) ? { output_schema: base.output_schema } : {}),
    ...(outputTransform ? { output_transform: outputTransform } : {}),
    ...(Array.isArray(base.edges)
      ? {
          edges: base.edges
            .filter(
              (edge): edge is { from: string; to: string } =>
                isRecord(edge) && typeof edge.from === "string" && typeof edge.to === "string",
            )
            .map((edge) => ({ from: edge.from, to: edge.to })),
        }
      : {}),
    ...(isRecord(base.trigger) && typeof base.trigger.kind === "string"
      ? { trigger: base.trigger as WorkflowTrigger }
      : {}),
  };

  const alreadyNormalized = new Set([
    "name",
    "slug",
    "description",
    "spec",
    "derived_from_skill_id",
    "input_schema",
    "input_schema_sample",
    "output_schema",
    "output_transform",
    "steps",
    "trigger",
  ]);
  const normalizedRecord = normalized as unknown as Record<string, unknown>;
  for (const key of WORKFLOW_DEF_FIELD_KEYS) {
    if (alreadyNormalized.has(key) || base[key] === undefined) continue;
    normalizedRecord[key] = base[key];
  }
  return normalized;
}

export function normalizeConnectorDraft(raw: unknown): ConnectorDraftDocument | null {
  if (!isRecord(raw) || !isRecord(raw.connector)) return null;
  const connector = raw.connector;
  const next: ConnectorDraftDocument = {};
  if (typeof connector.name === "string" && connector.name.length > 0) next.name = connector.name;
  if (typeof connector.slug === "string" && connector.slug.length > 0) next.slug = connector.slug;
  if (typeof connector.driver === "string") {
    next.driver = connector.driver as NonNullable<ConnectorDraftDocument["driver"]>;
  }
  if (typeof connector.environment === "string") {
    next.environment = connector.environment as NonNullable<ConnectorDraftDocument["environment"]>;
  }
  if (typeof connector.base_url === "string" && connector.base_url.length > 0) {
    next.base_url = connector.base_url;
  }
  if (typeof connector.dsn === "string" && connector.dsn.length > 0) next.dsn = connector.dsn;
  if (typeof connector.auth_type === "string") {
    next.auth_type = connector.auth_type as NonNullable<ConnectorDraftDocument["auth_type"]>;
  }
  if (isRecord(connector.config)) next.config = connector.config;
  if (typeof connector.description === "string" && connector.description.length > 0) {
    next.description = connector.description;
  }
  if (typeof connector.template_slug === "string") next.template_slug = connector.template_slug;
  if (connector.template_slug === null) next.template_slug = null;
  if (typeof connector.template_name === "string") next.template_name = connector.template_name;
  if (connector.template_name === null) next.template_name = null;
  if (typeof connector.template_source === "string") {
    next.template_source = connector.template_source as NonNullable<
      ConnectorDraftDocument["template_source"]
    >;
  }
  if (connector.template_source === null) next.template_source = null;
  if (Array.isArray(connector.docs)) {
    next.docs = connector.docs.filter((doc: unknown): doc is string => typeof doc === "string");
  }
  if (isRecord(connector.validation)) {
    const validation = connector.validation;
    next.validation = {
      ok: validation.ok === true,
      missing_fields: Array.isArray(validation.missing_fields)
        ? validation.missing_fields.filter(
            (field: unknown): field is string => typeof field === "string",
          )
        : [],
      errors: Array.isArray(validation.errors)
        ? validation.errors
            .filter(
              (error: unknown): error is { path: string; message: string } =>
                isRecord(error) &&
                typeof error.path === "string" &&
                typeof error.message === "string",
            )
            .map((error: { path: string; message: string }) => ({
              path: error.path,
              message: error.message,
            }))
        : [],
    };
  }
  if (isRecord(connector.latest_probe)) {
    const probe = connector.latest_probe;
    next.latest_probe = {
      ok: probe.ok === true,
      method: typeof probe.method === "string" ? probe.method : "GET",
      path: typeof probe.path === "string" ? probe.path : "/",
      environment:
        typeof probe.environment === "string"
          ? (probe.environment as NonNullable<ConnectorDraftDocument["environment"]>)
          : "dev",
      ...(typeof probe.status_code === "number" ? { status_code: probe.status_code } : {}),
      ...(typeof probe.duration_ms === "number" ? { duration_ms: probe.duration_ms } : {}),
      summary: typeof probe.summary === "string" ? probe.summary : "Probe executed.",
      ...(probe.response_preview !== undefined ? { response_preview: probe.response_preview } : {}),
      ...(isRecord(probe.response_headers)
        ? { response_headers: probe.response_headers as Record<string, string> }
        : {}),
      ...(typeof probe.failure_code === "string" ? { failure_code: probe.failure_code } : {}),
      ...(typeof probe.probed_at === "string" ? { probed_at: probe.probed_at } : {}),
      ...(typeof probe.fingerprint === "string" ? { fingerprint: probe.fingerprint } : {}),
    };
  }
  if (typeof connector.saved_connector_id === "string") {
    next.saved_connector_id = connector.saved_connector_id;
  }
  if (connector.saved_connector_id === null) next.saved_connector_id = null;
  return Object.keys(next).length > 0 ? next : {};
}

export function parseCheckpointRecord(
  key: AuthoringCheckpointKey,
  value: unknown,
): AuthoringCheckpointRecord | null {
  if (
    !isRecord(value) ||
    typeof value.verified_at !== "string" ||
    typeof value.verified_by_tool !== "string"
  ) {
    return null;
  }
  return {
    key,
    verified_at: value.verified_at,
    verified_by_tool: value.verified_by_tool,
    mutation_seq: typeof value.mutation_seq === "number" ? value.mutation_seq : 0,
    ok: typeof value.ok === "boolean" ? value.ok : null,
    summary: typeof value.summary === "string" ? value.summary : null,
    ...(value.redacted === true ? { redacted: true } : {}),
    resource_ref:
      isRecord(value.resource_ref) &&
      typeof value.resource_ref.kind === "string" &&
      typeof value.resource_ref.id === "string"
        ? {
            kind: value.resource_ref.kind as "connector" | "workflow" | "execution" | "diagnosis",
            id: value.resource_ref.id,
            version_id:
              typeof value.resource_ref.version_id === "string"
                ? value.resource_ref.version_id
                : null,
          }
        : null,
  };
}

export function normalizePersistedResource(value: unknown): PersistedResourceRef | null {
  if (!isRecord(value) || typeof value.kind !== "string" || typeof value.id !== "string") {
    return null;
  }
  return {
    kind: value.kind as PersistedResourceRef["kind"],
    id: value.id,
    slug: typeof value.slug === "string" ? value.slug : null,
    name: typeof value.name === "string" ? value.name : null,
    version_id: typeof value.version_id === "string" ? value.version_id : null,
    version: typeof value.version === "number" ? value.version : null,
    environment:
      value.environment === "dev" || value.environment === "prod" ? value.environment : null,
    saved_at: typeof value.saved_at === "string" ? value.saved_at : nowIso(),
    ...(value.draft_version_id === null || typeof value.draft_version_id === "string"
      ? { draft_version_id: value.draft_version_id }
      : {}),
    ...(value.current_version_id === null || typeof value.current_version_id === "string"
      ? { current_version_id: value.current_version_id }
      : {}),
    ...(value.persistence_kind === "draft" || value.persistence_kind === "active"
      ? { persistence_kind: value.persistence_kind }
      : {}),
  };
}

export function normalizeLatestExecution(value: unknown): LatestExecutionSummary | null {
  if (
    !isRecord(value) ||
    typeof value.execution_id !== "string" ||
    typeof value.status !== "string"
  ) {
    return null;
  }
  return {
    execution_id: value.execution_id,
    workflow_id: typeof value.workflow_id === "string" ? value.workflow_id : null,
    workflow_version_id:
      typeof value.workflow_version_id === "string" ? value.workflow_version_id : null,
    status: value.status,
    environment:
      typeof value.environment === "string"
        ? (value.environment as LatestExecutionSummary["environment"])
        : "dev",
    warnings_count: typeof value.warnings_count === "number" ? value.warnings_count : 0,
    recorded_at: typeof value.recorded_at === "string" ? value.recorded_at : nowIso(),
    diagnosis_available: value.diagnosis_available === true,
    ...(value.requires_repair === true ? { requires_repair: true } : {}),
  };
}

export function normalizeLatestDiagnosis(value: unknown): LatestDiagnosisSummary | null {
  if (
    !isRecord(value) ||
    typeof value.execution_id !== "string" ||
    typeof value.reason !== "string"
  ) {
    return null;
  }
  return {
    execution_id: value.execution_id,
    recorded_at: typeof value.recorded_at === "string" ? value.recorded_at : nowIso(),
    reason: value.reason,
    warning_sources: Array.isArray(value.warning_sources)
      ? value.warning_sources
          .filter(
            (item): item is { step_key: string; code: string; identifier: string | null } =>
              isRecord(item) && typeof item.step_key === "string" && typeof item.code === "string",
          )
          .map((item) => ({
            step_key: item.step_key,
            code: item.code,
            identifier: typeof item.identifier === "string" ? item.identifier : null,
          }))
      : [],
    steps: Array.isArray(value.steps)
      ? value.steps
          .filter(
            (
              item,
            ): item is {
              step_key: string;
              kind: string;
              status: string;
              duration_ms?: number | null;
              output_preview?: unknown;
              error?: unknown;
              request_meta?: unknown;
            } =>
              isRecord(item) &&
              typeof item.step_key === "string" &&
              typeof item.kind === "string" &&
              typeof item.status === "string",
          )
          .map((item) => ({
            step_key: item.step_key,
            kind: item.kind,
            status: item.status,
            duration_ms: typeof item.duration_ms === "number" ? item.duration_ms : null,
            ...(item.output_preview !== undefined ? { output_preview: item.output_preview } : {}),
            ...(item.error !== undefined ? { error: item.error } : {}),
            ...(item.request_meta !== undefined ? { request_meta: item.request_meta } : {}),
          }))
      : [],
  };
}

function normalizeJudgeVerdictMemo(value: unknown): JudgeVerdictMemo | null {
  if (
    !isRecord(value) ||
    typeof value.fingerprint !== "string" ||
    (value.verdict !== "passes" && value.verdict !== "partial" && value.verdict !== "failed") ||
    typeof value.reason !== "string"
  ) {
    return null;
  }
  return {
    fingerprint: value.fingerprint,
    verdict: value.verdict,
    reason: value.reason,
    missing: Array.isArray(value.missing)
      ? value.missing.filter((m): m is string => typeof m === "string")
      : [],
  };
}

function normalizeJudgeBreaker(value: unknown): JudgeBreakerState | null {
  if (!isRecord(value)) return null;
  const blocksSinceCommit =
    typeof value.blocks_since_commit === "number"
      ? value.blocks_since_commit
      : typeof value.blocks === "number"
        ? value.blocks
        : null;
  const lastVerdict = normalizeJudgeVerdictMemo(value.last_verdict);
  if (blocksSinceCommit === null && lastVerdict === null) return null;
  const holdsAtCap =
    typeof value.holds_at_cap === "number" && value.holds_at_cap > 0
      ? value.holds_at_cap
      : undefined;
  return {
    blocks_since_commit: blocksSinceCommit ?? 0,
    last_verdict: lastVerdict,
    ...(holdsAtCap !== undefined ? { holds_at_cap: holdsAtCap } : {}),
  };
}

function normalizeLastDeniedIntent(
  value: unknown,
): { fingerprint: string; timestamp: string } | null {
  if (!isRecord(value) || typeof value.fingerprint !== "string") return null;
  return {
    fingerprint: value.fingerprint,
    timestamp: typeof value.timestamp === "string" ? value.timestamp : nowIso(),
  };
}

export function normalizeState(raw: unknown, draftMode: AuthoringMode | undefined): AuthoringState {
  const fallback = createEmptyState(surfaceModeFor(draftMode));
  if (!isRecord(raw) || !isRecord(raw.state)) return fallback;
  const state = raw.state;
  const next: AuthoringState = {
    mode:
      state.mode === "workflow" ||
      state.mode === "execution" ||
      state.mode === "diagnosis" ||
      state.mode === "connector"
        ? state.mode
        : fallback.mode,
    stage: typeof state.stage === "string" ? (state.stage as AuthoringStage) : fallback.stage,
    connector_mutation_seq:
      typeof state.connector_mutation_seq === "number" ? state.connector_mutation_seq : 0,
    workflow_mutation_seq:
      typeof state.workflow_mutation_seq === "number" ? state.workflow_mutation_seq : 0,
    checkpoints: {},
    persisted_resources: Array.isArray(state.persisted_resources)
      ? state.persisted_resources
          .map(normalizePersistedResource)
          .filter((item): item is PersistedResourceRef => item !== null)
      : [],
    latest_execution: normalizeLatestExecution(state.latest_execution),
    latest_diagnosis: normalizeLatestDiagnosis(state.latest_diagnosis),
    judge_breaker: normalizeJudgeBreaker(state.judge_breaker),
    grounding_fingerprint:
      typeof state.grounding_fingerprint === "string" ? state.grounding_fingerprint : null,
    grounding_connector_ids: Array.isArray(state.grounding_connector_ids)
      ? state.grounding_connector_ids.filter((id): id is string => typeof id === "string")
      : null,
    last_denied_intent: normalizeLastDeniedIntent(state.last_denied_intent),
    latest_workflow_save_error: normalizeWorkflowSaveError(state.latest_workflow_save_error),
    authoring_focus: state.authoring_focus === "connector" ? "connector" : null,
  };
  if (isRecord(state.checkpoints)) {
    for (const key of CHECKPOINT_KEYS) {
      const parsed = parseCheckpointRecord(key, state.checkpoints[key]);
      if (parsed) next.checkpoints[key] = parsed;
    }
  }
  return next;
}

export function normalizeSummary(raw: unknown): AuthoringSummary | undefined {
  if (!isRecord(raw) || !isRecord(raw.summary)) return undefined;
  const summary = raw.summary;
  return {
    readiness:
      summary.readiness === "drafting" ||
      summary.readiness === "needs_input" ||
      summary.readiness === "ready_to_probe" ||
      summary.readiness === "ready_to_save" ||
      summary.readiness === "saved"
        ? summary.readiness
        : "drafting",
    next_action: typeof summary.next_action === "string" ? summary.next_action : null,
    next_required_action:
      typeof summary.next_required_action === "string"
        ? summary.next_required_action
        : typeof summary.next_action === "string"
          ? summary.next_action
          : null,
    next_suggested_tool:
      typeof summary.next_suggested_tool === "string" ? summary.next_suggested_tool : null,
    missing_fields: Array.isArray(summary.missing_fields)
      ? summary.missing_fields.filter(
          (field: unknown): field is string => typeof field === "string",
        )
      : [],
    last_action: typeof summary.last_action === "string" ? summary.last_action : null,
    progress_label: typeof summary.progress_label === "string" ? summary.progress_label : null,
    mode:
      summary.mode === "workflow" ||
      summary.mode === "execution" ||
      summary.mode === "diagnosis" ||
      summary.mode === "connector"
        ? summary.mode
        : "connector",
    stage: typeof summary.stage === "string" ? (summary.stage as AuthoringStage) : "idle",
    lifecycle_state:
      summary.lifecycle_state === "persisted" ||
      summary.lifecycle_state === "draft_only" ||
      summary.lifecycle_state === "none"
        ? summary.lifecycle_state
        : "none",
    active_target:
      isRecord(summary.active_target) &&
      typeof summary.active_target.kind === "string" &&
      (summary.active_target.kind === "connector" ||
        summary.active_target.kind === "workflow" ||
        summary.active_target.kind === "none")
        ? {
            kind: summary.active_target.kind,
            name:
              typeof summary.active_target.name === "string" ? summary.active_target.name : null,
            slug:
              typeof summary.active_target.slug === "string" ? summary.active_target.slug : null,
            id: typeof summary.active_target.id === "string" ? summary.active_target.id : null,
            environment:
              summary.active_target.environment === "dev" ||
              summary.active_target.environment === "prod"
                ? summary.active_target.environment
                : null,
            lifecycle_state:
              summary.active_target.lifecycle_state === "persisted" ||
              summary.active_target.lifecycle_state === "draft_only" ||
              summary.active_target.lifecycle_state === "none"
                ? summary.active_target.lifecycle_state
                : "none",
          }
        : {
            kind: "none",
            name: null,
            slug: null,
            id: null,
            environment: null,
            lifecycle_state: "none",
          },
    blocked_by: Array.isArray(summary.blocked_by)
      ? summary.blocked_by.filter((item: unknown): item is string => typeof item === "string")
      : [],
    checkpoints: Array.isArray(summary.checkpoints)
      ? summary.checkpoints
          .filter(
            (item: unknown): item is AuthoringCheckpointView =>
              isRecord(item) && typeof item.key === "string" && typeof item.status === "string",
          )
          .map((item) => ({
            key: item.key as AuthoringCheckpointKey,
            status: item.status as AuthoringCheckpointStatus,
            verified_at: typeof item.verified_at === "string" ? item.verified_at : null,
            verified_by_tool:
              typeof item.verified_by_tool === "string" ? item.verified_by_tool : null,
            ok: typeof item.ok === "boolean" ? item.ok : null,
            summary: typeof item.summary === "string" ? item.summary : null,
          }))
      : [],
    persisted_resources: Array.isArray(summary.persisted_resources)
      ? summary.persisted_resources
          .map(normalizePersistedResource)
          .filter((item): item is PersistedResourceRef => item !== null)
      : [],
    latest_execution: normalizeLatestExecution(summary.latest_execution),
    latest_diagnosis: normalizeLatestDiagnosis(summary.latest_diagnosis),
  };
}

export { CHECKPOINT_KEYS, nowIso };
