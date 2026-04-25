import { extractTemplatePlaceholders } from "./connector-template-intelligence.ts";
import type {
  AuthoringCheckpointKey,
  AuthoringCheckpointRecord,
  AuthoringCheckpointStatus,
  AuthoringCheckpointView,
  AuthoringLifecycleState,
  AuthoringMode,
  AuthoringStage,
  AuthoringState,
  AuthoringSummary,
  AuthoringSurfaceMode,
  ConnectorDraftDocument,
  DraftDocument,
  LatestDiagnosisSummary,
  LatestExecutionSummary,
  PersistedResourceRef,
  WorkflowDraftDocument,
} from "./types.ts";

const CHECKPOINT_KEYS: readonly AuthoringCheckpointKey[] = [
  "connector_inspected",
  "connector_validated",
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

function createEmptyState(mode: AuthoringSurfaceMode): AuthoringState {
  return {
    mode,
    stage: "idle",
    connector_mutation_seq: 0,
    workflow_mutation_seq: 0,
    checkpoints: {},
    persisted_resources: [],
    latest_execution: null,
    latest_diagnosis: null,
  };
}

export function createEmptyDraftDocument(mode: AuthoringMode = "onboarding"): DraftDocument {
  return refreshDraftSummary({
    mode,
    workflow: createEmptyWorkflowDraft(),
    connector: null,
    latest_preview: null,
    state: createEmptyState(modeFromLegacy(mode)),
  });
}

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === "object" && value !== null && !Array.isArray(value);
}

function normalizeWorkflowDraft(raw: unknown): WorkflowDraftDocument {
  const fallback = createEmptyWorkflowDraft();
  if (!isRecord(raw)) return fallback;
  const base = isRecord(raw.workflow) ? raw.workflow : raw;
  const pickString = (key: string): string | undefined => {
    const value = base[key];
    return typeof value === "string" && value.length > 0 ? value : undefined;
  };
  const name = pickString("name") ?? fallback.name;
  const slug = pickString("slug");
  const description = pickString("description");
  const outputTransform = pickString("output_transform");
  return {
    name,
    ...(slug ? { slug } : {}),
    ...(description ? { description } : {}),
    steps: Array.isArray(base.steps)
      ? base.steps.filter((step): step is Record<string, unknown> => isRecord(step))
      : [],
    ...(isRecord(base.input_schema) ? { input_schema: base.input_schema } : {}),
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
  };
}

function normalizeConnectorDraft(raw: unknown): ConnectorDraftDocument | null {
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
  if (typeof connector.template_id === "string") next.template_slug = connector.template_id;
  if (connector.template_id === null) next.template_slug = null;
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
      ...(typeof probe.failure_code === "string" ? { failure_code: probe.failure_code } : {}),
    };
  }
  if (typeof connector.saved_connector_id === "string") {
    next.saved_connector_id = connector.saved_connector_id;
  }
  if (connector.saved_connector_id === null) next.saved_connector_id = null;
  return Object.keys(next).length > 0 ? next : {};
}

function parseCheckpointRecord(
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

function normalizePersistedResource(value: unknown): PersistedResourceRef | null {
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
  };
}

function normalizeLatestExecution(value: unknown): LatestExecutionSummary | null {
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
  };
}

function normalizeLatestDiagnosis(value: unknown): LatestDiagnosisSummary | null {
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

function modeFromLegacy(mode: AuthoringMode | undefined): AuthoringSurfaceMode {
  if (mode === "workflow_authoring" || mode === "resume_review") return "workflow";
  return "connector";
}

function normalizeState(
  raw: unknown,
  legacyMode: AuthoringMode | undefined,
  connector: ConnectorDraftDocument | null,
  workflow: WorkflowDraftDocument,
  latest_preview: DraftDocument["latest_preview"],
): AuthoringState {
  const fallback = createEmptyState(modeFromLegacy(legacyMode));
  if (!isRecord(raw) || !isRecord(raw.state)) {
    return hydrateLegacyState(fallback, connector, workflow, latest_preview);
  }
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
  };
  if (isRecord(state.checkpoints)) {
    for (const key of CHECKPOINT_KEYS) {
      const parsed = parseCheckpointRecord(key, state.checkpoints[key]);
      if (parsed) next.checkpoints[key] = parsed;
    }
  }
  return hydrateLegacyState(next, connector, workflow, latest_preview);
}

function hydrateLegacyState(
  base: AuthoringState,
  connector: ConnectorDraftDocument | null,
  workflow: WorkflowDraftDocument,
  latest_preview: DraftDocument["latest_preview"],
): AuthoringState {
  const next: AuthoringState = {
    ...base,
    checkpoints: { ...base.checkpoints },
    persisted_resources: [...base.persisted_resources],
  };
  if (connector?.validation && !next.checkpoints.connector_validated) {
    next.checkpoints.connector_validated = {
      key: "connector_validated",
      verified_at: nowIso(),
      verified_by_tool: "legacy.connector.validation",
      mutation_seq: next.connector_mutation_seq,
      ok: connector.validation.ok,
      summary: connector.validation.ok
        ? "Legacy connector validation imported."
        : "Legacy connector validation imported with errors.",
      resource_ref: null,
    };
  }
  if (connector?.latest_probe && !next.checkpoints.connector_probed) {
    next.checkpoints.connector_probed = {
      key: "connector_probed",
      verified_at: nowIso(),
      verified_by_tool: "legacy.connector.probe",
      mutation_seq: next.connector_mutation_seq,
      ok: connector.latest_probe.ok,
      summary: connector.latest_probe.summary,
      resource_ref: null,
    };
  }
  if (typeof connector?.saved_connector_id === "string") {
    if (!next.checkpoints.connector_persisted) {
      next.checkpoints.connector_persisted = {
        key: "connector_persisted",
        verified_at: nowIso(),
        verified_by_tool: "legacy.connector.save",
        mutation_seq: next.connector_mutation_seq,
        ok: true,
        summary: "Legacy saved connector imported.",
        resource_ref: {
          kind: "connector",
          id: connector.saved_connector_id,
          version_id: null,
        },
      };
    }
    if (
      !next.persisted_resources.some(
        (item) => item.kind === "connector" && item.id === connector.saved_connector_id,
      )
    ) {
      next.persisted_resources.unshift({
        kind: "connector",
        id: connector.saved_connector_id,
        slug: connector.slug ?? null,
        name: connector.name ?? null,
        version_id: null,
        version: null,
        environment: connector.environment ?? null,
        saved_at: nowIso(),
      });
    }
  }
  if (latest_preview && !next.checkpoints.workflow_previewed) {
    next.checkpoints.workflow_previewed = {
      key: "workflow_previewed",
      verified_at: nowIso(),
      verified_by_tool: "legacy.workflow.preview",
      mutation_seq: next.workflow_mutation_seq,
      ok: latest_preview.ok,
      summary: latest_preview.summary,
      resource_ref: null,
    };
  }
  if (workflow.steps.length > 0 && !next.checkpoints.workflow_inspected) {
    next.checkpoints.workflow_inspected = {
      key: "workflow_inspected",
      verified_at: nowIso(),
      verified_by_tool: "legacy.workflow.inspect",
      mutation_seq: next.workflow_mutation_seq,
      ok: true,
      summary: "Legacy workflow draft imported.",
      resource_ref: null,
    };
  }
  return next;
}

function normalizeSummary(raw: unknown): AuthoringSummary | undefined {
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

function computeConnectorMissingFields(connector: ConnectorDraftDocument | null): string[] {
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

function computeWorkflowMissingFields(workflow: WorkflowDraftDocument): string[] {
  const missing: string[] = [];
  if (!workflow.name) missing.push("workflow.name");
  if (workflow.steps.length === 0) missing.push("workflow.steps");
  return missing;
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

function checkpointSeq(state: AuthoringState, key: AuthoringCheckpointKey): number {
  switch (key) {
    case "connector_inspected":
    case "connector_validated":
    case "connector_probed":
    case "connector_persisted":
      return state.connector_mutation_seq;
    default:
      return state.workflow_mutation_seq;
  }
}

function checkpointStatus(
  state: AuthoringState,
  key: AuthoringCheckpointKey,
): AuthoringCheckpointStatus {
  const record = state.checkpoints[key];
  if (!record) return "missing";
  return record.mutation_seq === checkpointSeq(state, key) ? "fresh" : "stale";
}

function checkpointView(
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

function emptySummary(): AuthoringSummary {
  return {
    readiness: "drafting",
    next_action: null,
    next_required_action: null,
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
  if (workflow.steps.length === 0) return "none";
  return checkpointStatus(state, "workflow_persisted") === "fresh" ? "persisted" : "draft_only";
}

function computeActiveTarget(
  state: AuthoringState,
  connector: ConnectorDraftDocument | null,
  workflow: WorkflowDraftDocument,
): AuthoringSummary["active_target"] {
  const connectorLifecycle = connectorTargetLifecycle(state, connector);
  const workflowLifecycle = workflowTargetLifecycle(state, workflow);
  if (workflow.steps.length > 0) {
    const persistedWorkflow =
      state.persisted_resources.find((item) => item.kind === "workflow") ?? null;
    return {
      kind: "workflow",
      name: workflow.name || (persistedWorkflow?.name ?? null),
      slug: workflow.slug ?? persistedWorkflow?.slug ?? null,
      id: persistedWorkflow?.id ?? null,
      environment: connector?.environment ?? persistedWorkflow?.environment ?? null,
      lifecycle_state: workflowLifecycle,
    };
  }
  if (connector) {
    const persistedConnector =
      state.persisted_resources.find((item) => item.kind === "connector") ?? null;
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

function computeBlockedBy(
  state: AuthoringState,
  connector: ConnectorDraftDocument | null,
  workflow: WorkflowDraftDocument,
  latest_preview: DraftDocument["latest_preview"],
): string[] {
  const blocked: string[] = [];
  const active = computeActiveTarget(state, connector, workflow);
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
    if (
      checkpointStatus(state, "connector_probed") !== "fresh" ||
      connector?.latest_probe?.ok !== true
    ) {
      blocked.push("probe_connector_draft");
    }
    return uniqueStrings(blocked);
  }
  if (active.kind === "workflow") {
    for (const field of computeWorkflowMissingFields(workflow)) blocked.push(`missing:${field}`);
    if (checkpointStatus(state, "workflow_inspected") !== "fresh")
      blocked.push("inspect_workflow_draft");
    if (checkpointStatus(state, "workflow_validated") !== "fresh") blocked.push("validate_draft");
    if (checkpointStatus(state, "workflow_previewed") !== "fresh" || latest_preview?.ok !== true) {
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

function computeReadiness(
  active: AuthoringSummary["active_target"],
  blocked_by: string[],
): AuthoringSummary["readiness"] {
  if (active.lifecycle_state === "persisted") return "saved";
  if (blocked_by.some((item) => item.startsWith("missing:"))) return "needs_input";
  if (active.kind === "connector") {
    return blocked_by.includes("probe_connector_draft") ? "ready_to_probe" : "ready_to_save";
  }
  if (active.kind === "workflow") {
    return blocked_by.includes("dry_run_workflow") ? "ready_to_probe" : "ready_to_save";
  }
  return "drafting";
}

function computeProgressLabel(
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
      : "Workflow draft";
  }
  return null;
}

function computeStage(
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
    if (checkpointStatus(state, "connector_validated") === "fresh") return "connector_validated";
    if (checkpointStatus(state, "connector_inspected") === "fresh") return "connector_inspected";
    return "connector_draft_started";
  }
  return "idle";
}

function computeSurfaceMode(
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
      return "Preview the workflow successfully before committing it.";
    case "diagnose_latest_execution":
      return "Inspect the latest execution in diagnosis mode before editing the workflow.";
    default:
      return null;
  }
}

function computeNextAction(
  state: AuthoringState,
  active: AuthoringSummary["active_target"],
  blocked_by: string[],
  workflow: WorkflowDraftDocument,
): string | null {
  const blockedAction = nextActionForBlocked(blocked_by, active);
  if (blockedAction) return blockedAction;
  if (
    active.kind === "connector" &&
    active.lifecycle_state === "persisted" &&
    workflow.steps.length === 0
  ) {
    return "Describe the workflow you want to build with this saved connector.";
  }
  if (active.kind === "workflow" && active.lifecycle_state === "draft_only") {
    return "Commit the workflow now that inspection, validation, and preview are fresh.";
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

export function refreshDraftSummary(draft: DraftDocument): DraftDocument {
  const workflow = normalizeWorkflowDraft(draft);
  const connector = draft.connector ?? null;
  const mode = inferLegacyMode({ ...draft, workflow, connector });
  const existingSummary = normalizeSummary(draft) ?? undefined;
  const state = normalizeState(draft, mode, connector, workflow, draft.latest_preview ?? null);
  const active_target = computeActiveTarget(state, connector, workflow);
  const blocked_by = computeBlockedBy(state, connector, workflow, draft.latest_preview ?? null);
  const next_action = computeNextAction(state, active_target, blocked_by, workflow);
  const missing_fields =
    active_target.kind === "connector"
      ? computeConnectorMissingFields(connector)
      : computeWorkflowMissingFields(workflow);
  state.mode = computeSurfaceMode(state, active_target);
  state.stage = computeStage(state, active_target);
  const summary: AuthoringSummary = {
    readiness: computeReadiness(active_target, blocked_by),
    next_action,
    next_required_action: next_action,
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
          },
        }
      : {}),
    ...(isRecord(raw.state)
      ? {
          state: normalizeState(
            raw,
            raw.mode as AuthoringMode,
            connector,
            workflow,
            isRecord(raw.latest_preview)
              ? (raw.latest_preview as unknown as DraftDocument["latest_preview"])
              : null,
          ),
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
  const normalized = normalizeDraftDocument(draft);
  let state = cloneState(normalized.state ?? createEmptyState("workflow"));
  state.mode = "workflow";
  state = addPersistedResource(state, resource);
  state = recordCheckpoint(
    state,
    "workflow_persisted",
    "commit_draft",
    true,
    `Workflow ${resource.name ?? resource.id} persisted.`,
    {
      kind: "workflow",
      id: resource.id,
      version_id: resource.version_id,
    },
  );
  return refreshDraftSummary({
    ...normalized,
    state,
    summary: { ...(normalized.summary ?? emptySummary()), last_action },
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
