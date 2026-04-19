import type {
  AuthoringMode,
  AuthoringSummary,
  ConnectorDraftDocument,
  DraftDocument,
  WorkflowDraftDocument,
} from "./types.ts";

export function createEmptyWorkflowDraft(): WorkflowDraftDocument {
  return {
    name: "new-workflow",
    steps: [],
  };
}

export function createEmptyDraftDocument(mode: AuthoringMode = "onboarding"): DraftDocument {
  const workflow = createEmptyWorkflowDraft();
  return refreshDraftSummary({
    ...workflow,
    mode,
    workflow,
    connector: null,
    latest_preview: null,
  });
}

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === "object" && value !== null && !Array.isArray(value);
}

function normalizeWorkflowDraft(raw: unknown): WorkflowDraftDocument {
  const fallback = createEmptyWorkflowDraft();
  if (!isRecord(raw)) return fallback;
  const base = isRecord(raw.workflow) ? raw.workflow : raw;
  return {
    name: typeof base.name === "string" && base.name.length > 0 ? base.name : fallback.name,
    ...(typeof base.slug === "string" && base.slug.length > 0 ? { slug: base.slug } : {}),
    ...(typeof base.description === "string" && base.description.length > 0
      ? { description: base.description }
      : {}),
    steps: Array.isArray(base.steps)
      ? base.steps.filter((step): step is Record<string, unknown> => isRecord(step))
      : [],
    ...(isRecord(base.input_schema) ? { input_schema: base.input_schema } : {}),
    ...(isRecord(base.output_schema) ? { output_schema: base.output_schema } : {}),
    ...(typeof base.output_transform === "string"
      ? { output_transform: base.output_transform }
      : {}),
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
  if (!isRecord(raw)) return null;
  if (!isRecord(raw.connector)) return null;
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
  if (typeof connector.template_id === "string") next.template_id = connector.template_id;
  if (connector.template_id === null) next.template_id = null;
  if (typeof connector.template_name === "string") next.template_name = connector.template_name;
  if (connector.template_name === null) next.template_name = null;
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

function normalizeSummary(raw: unknown): AuthoringSummary | undefined {
  if (!isRecord(raw)) return undefined;
  if (!isRecord(raw.summary)) return undefined;
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
    missing_fields: Array.isArray(summary.missing_fields)
      ? summary.missing_fields.filter(
          (field: unknown): field is string => typeof field === "string",
        )
      : [],
    last_action: typeof summary.last_action === "string" ? summary.last_action : null,
    progress_label: typeof summary.progress_label === "string" ? summary.progress_label : null,
  };
}

function computeConnectorMissingFields(connector: ConnectorDraftDocument | null): string[] {
  if (!connector) return [];
  const missing: string[] = [];
  if (!connector.name) missing.push("name");
  if (!connector.driver) missing.push("driver");
  if (!connector.environment) missing.push("environment");
  if (connector.driver === "http" || connector.driver === "graphql" || connector.driver === "s3") {
    if (!connector.base_url) missing.push("base_url");
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

function inferMode(draft: DraftDocument): AuthoringMode {
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

export function refreshDraftSummary(draft: DraftDocument): DraftDocument {
  const workflow = normalizeWorkflowDraft(draft);
  const connector = draft.connector ?? null;
  const mode = inferMode({ ...draft, workflow, connector });
  const missing_fields =
    mode === "connector_authoring"
      ? computeConnectorMissingFields(connector)
      : computeWorkflowMissingFields(workflow);
  const connectorProbed = connector?.latest_probe?.ok === true;
  const connectorSaved = typeof connector?.saved_connector_id === "string";
  const workflowReady = workflow.steps.length > 0;
  const workflowPreviewed = draft.latest_preview?.ok === true;

  const summary: AuthoringSummary = connectorSaved
    ? {
        readiness: "saved",
        next_action:
          workflow.steps.length > 0
            ? "Preview the workflow, then commit it."
            : "Describe the workflow you want to build with this connector.",
        missing_fields,
        last_action: draft.summary?.last_action ?? "connector_saved",
        progress_label: "Connector saved",
      }
    : mode === "connector_authoring"
      ? {
          readiness:
            missing_fields.length > 0
              ? "needs_input"
              : connectorProbed
                ? "ready_to_save"
                : "ready_to_probe",
          next_action:
            missing_fields.length > 0
              ? `Collect the remaining connector fields: ${missing_fields.join(", ")}.`
              : connectorProbed
                ? "Save the connector draft or continue editing it."
                : "Probe the connector before saving so auth and response shape are verified.",
          missing_fields,
          last_action: draft.summary?.last_action ?? null,
          progress_label: connector?.template_name
            ? `Connector draft from ${connector.template_name}`
            : "Connector draft",
        }
      : {
          readiness:
            missing_fields.length > 0
              ? "needs_input"
              : workflowReady && workflowPreviewed
                ? "ready_to_save"
                : workflowReady
                  ? "ready_to_probe"
                  : "drafting",
          next_action:
            missing_fields.length > 0
              ? "Add a workflow name and at least one step."
              : workflowPreviewed
                ? "Commit the workflow when the preview looks right."
                : workflowReady
                  ? "Preview a step or the whole workflow before committing."
                  : "Describe the workflow goal and the systems involved.",
          missing_fields,
          last_action: draft.summary?.last_action ?? null,
          progress_label:
            workflow.steps.length > 0
              ? `${workflow.steps.length} workflow step${workflow.steps.length === 1 ? "" : "s"}`
              : "Workflow draft",
        };

  return {
    ...draft,
    ...workflow,
    mode,
    workflow,
    connector,
    summary,
  };
}

export function normalizeDraftDocument(raw: unknown): DraftDocument {
  if (!isRecord(raw)) return createEmptyDraftDocument();
  const workflow = normalizeWorkflowDraft(raw);
  const connector = normalizeConnectorDraft(raw);
  const summary = normalizeSummary(raw);
  const next: DraftDocument = {
    ...workflow,
    ...(typeof raw.mode === "string" ? { mode: raw.mode as AuthoringMode } : {}),
    workflow,
    connector,
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
  };
  if (summary) next.summary = summary;
  return refreshDraftSummary(next);
}

export function getWorkflowDraft(draft: DraftDocument): WorkflowDraftDocument {
  return normalizeDraftDocument(draft).workflow ?? createEmptyWorkflowDraft();
}

export function withWorkflowDraft(
  draft: DraftDocument,
  workflow: WorkflowDraftDocument,
  last_action: string | null = draft.summary?.last_action ?? null,
): DraftDocument {
  const next: DraftDocument = {
    ...draft,
    ...workflow,
    mode: "workflow_authoring",
    workflow,
    summary: {
      ...(draft.summary ?? {
        readiness: "drafting",
        next_action: null,
        missing_fields: [],
        last_action: null,
        progress_label: null,
      }),
      last_action,
    },
  };
  return refreshDraftSummary(next);
}

export function withConnectorDraft(
  draft: DraftDocument,
  connector: ConnectorDraftDocument | null,
  last_action: string | null = draft.summary?.last_action ?? null,
): DraftDocument {
  const next: DraftDocument = {
    ...draft,
    ...(connector ? { mode: "connector_authoring" as const } : {}),
    connector,
    summary: {
      ...(draft.summary ?? {
        readiness: "drafting",
        next_action: null,
        missing_fields: [],
        last_action: null,
        progress_label: null,
      }),
      last_action,
    },
  };
  return refreshDraftSummary(next);
}

export function withLatestPreview(
  draft: DraftDocument,
  preview: DraftDocument["latest_preview"],
  last_action: string | null = "workflow_previewed",
): DraftDocument {
  return refreshDraftSummary({
    ...draft,
    mode: "workflow_authoring",
    latest_preview: preview ?? null,
    summary: {
      ...(draft.summary ?? {
        readiness: "drafting",
        next_action: null,
        missing_fields: [],
        last_action: null,
        progress_label: null,
      }),
      last_action,
    },
  });
}
