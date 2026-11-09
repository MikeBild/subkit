import { describe, expect, it } from "bun:test";
import { FROZEN_NOW } from "../../test-helpers/determinism/clock.ts";
import { createEmptyState } from "../authoring-state/normalize.ts";
import type {
  AuthoringStage,
  AuthoringSummary,
  ConnectorDraftDocument,
  WorkflowDraftDocument,
} from "../types.ts";
import {
  checkpointSeq,
  checkpointStatus,
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
  pendingInactiveDraft,
  persistedResourceForKind,
  persistedWorkflowResource,
} from "./authoring-summary.ts";

function activeConnector(): AuthoringSummary["active_target"] {
  return {
    kind: "connector",
    name: "Gmail",
    slug: "google-gmail",
    id: null,
    environment: "dev",
    lifecycle_state: "draft_only",
  };
}

function activeWorkflow(): AuthoringSummary["active_target"] {
  return {
    kind: "workflow",
    name: "github-briefing",
    slug: "github-briefing",
    id: null,
    environment: "prod",
    lifecycle_state: "draft_only",
  };
}

function emptyWorkflow(): WorkflowDraftDocument {
  return { name: "", steps: [] };
}

function workflowDraft(
  execution_privacy?: WorkflowDraftDocument["execution_privacy"],
): WorkflowDraftDocument {
  return {
    name: "github-briefing",
    ...(execution_privacy ? { execution_privacy } : {}),
    steps: [{ id: "read", kind: "transform", expression: "return {};", language: "javascript" }],
  };
}

function oauth2DraftValidated(): ConnectorDraftDocument {
  return {
    name: "Gmail",
    slug: "google-gmail",
    driver: "http",
    environment: "dev",
    auth_type: "oauth2",
    base_url: "https://gmail.googleapis.com",
    validation: { ok: true, missing_fields: [], errors: [] },
    config: { oauth: { client_id: "x", client_secret: "y" } },
  };
}

function freshen<
  K extends "connector_inspected" | "connector_validated" | "connector_authenticated",
>(state: ReturnType<typeof createEmptyState>, ...keys: K[]) {
  for (const key of keys) state.checkpoints[key] = checkpoint(key, state.connector_mutation_seq);
  return state;
}

function persistedWorkflowState(options: { previewed?: boolean } = {}) {
  const state = createEmptyState("workflow");
  const verified_at = new Date(FROZEN_NOW).toISOString();
  state.persisted_resources = [
    {
      kind: "workflow",
      id: "workflow-1",
      slug: "github-briefing",
      name: "github-briefing",
      version_id: "draft-version",
      version: 2,
      environment: null,
      saved_at: verified_at,
      draft_version_id: "draft-version",
      current_version_id: "active-version",
      persistence_kind: "draft",
    },
  ];
  state.checkpoints.workflow_persisted = checkpoint("workflow_persisted", 0);
  if (options.previewed) state.checkpoints.workflow_previewed = checkpoint("workflow_previewed", 0);
  return state;
}

function checkpoint(
  key: keyof ReturnType<typeof createEmptyState>["checkpoints"],
  mutation_seq: number,
  overrides: Partial<
    NonNullable<ReturnType<typeof createEmptyState>["checkpoints"][typeof key]>
  > = {},
) {
  return {
    key,
    mutation_seq,
    verified_at: new Date(FROZEN_NOW).toISOString(),
    verified_by_tool: "test",
    ok: true,
    summary: "checked",
    ...overrides,
  };
}

describe("authoring summary foundational projections", () => {
  it("projects empty state, checkpoint freshness, and checkpoint records without mutation", () => {
    const state = createEmptyState("workflow");
    state.connector_mutation_seq = 3;
    state.workflow_mutation_seq = 5;
    expect(emptySummary()).toEqual({
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
    });
    for (const key of [
      "connector_inspected",
      "connector_validated",
      "connector_authenticated",
      "connector_probed",
      "connector_persisted",
    ] as const)
      expect(checkpointSeq(state, key)).toBe(3);
    expect(checkpointSeq(state, "workflow_previewed")).toBe(5);
    expect(checkpointStatus(state, "workflow_previewed")).toBe("missing");
    expect(checkpointView(state, "workflow_previewed")).toEqual({
      key: "workflow_previewed",
      status: "missing",
      verified_at: null,
      verified_by_tool: null,
      ok: null,
      summary: null,
    });
    state.checkpoints.workflow_previewed = checkpoint("workflow_previewed", 5, {
      ok: "unexpected" as never,
    });
    expect(checkpointStatus(state, "workflow_previewed")).toBe("fresh");
    expect(checkpointView(state, "workflow_previewed")).toMatchObject({
      status: "fresh",
      ok: null,
      summary: "checked",
    });
    state.checkpoints.workflow_previewed = checkpoint("workflow_previewed", 5, { ok: false });
    expect(checkpointView(state, "workflow_previewed").ok).toBe(false);
    state.checkpoints.workflow_previewed = checkpoint("workflow_previewed", 5, { ok: true });
    expect(checkpointView(state, "workflow_previewed").ok).toBe(true);
    state.workflow_mutation_seq = 6;
    expect(checkpointStatus(state, "workflow_previewed")).toBe("stale");
  });

  it("finds persisted resources and derives a workflow resource from the latest execution", () => {
    const state = createEmptyState("workflow");
    expect(persistedResourceForKind(state, "connector")).toBeNull();
    expect(persistedWorkflowResource(state)).toBeNull();
    state.latest_execution = {
      execution_id: "execution-1",
      workflow_id: "workflow-1",
      workflow_version_id: "version-1",
      status: "succeeded",
      environment: "prod",
      warnings_count: 0,
      recorded_at: new Date(FROZEN_NOW).toISOString(),
      diagnosis_available: false,
    };
    expect(persistedWorkflowResource(state)).toMatchObject({
      kind: "workflow",
      id: "workflow-1",
      version_id: "version-1",
      environment: "prod",
    });
    state.persisted_resources.push({
      kind: "workflow",
      id: "persisted-workflow",
      slug: "saved",
      name: "Saved",
      version_id: "current",
      version: 1,
      environment: "dev",
      saved_at: new Date(FROZEN_NOW).toISOString(),
    });
    expect(persistedResourceForKind(state, "workflow")?.id).toBe("persisted-workflow");
    expect(persistedWorkflowResource(state)?.id).toBe("persisted-workflow");
  });

  it("recognizes an inactive persisted draft only when its pending version differs", () => {
    const state = createEmptyState("workflow");
    expect(pendingInactiveDraft(state)).toBe(false);
    state.persisted_resources = [
      {
        kind: "workflow",
        id: "workflow-1",
        slug: null,
        name: null,
        version_id: "draft",
        version: null,
        environment: null,
        saved_at: new Date(FROZEN_NOW).toISOString(),
        persistence_kind: "draft",
        current_version_id: "active",
      },
    ];
    expect(pendingInactiveDraft(state)).toBe(true);
    state.persisted_resources[0]!.version_id = "active";
    expect(pendingInactiveDraft(state)).toBe(false);
    state.persisted_resources[0]!.persistence_kind = "active";
    expect(pendingInactiveDraft(state)).toBe(false);
  });
});

describe("authoring summary target and display projections", () => {
  it("reports connector and workflow input gaps including template and validation paths", () => {
    expect(computeConnectorMissingFields(null)).toEqual([]);
    expect(
      computeConnectorMissingFields({
        name: "",
        driver: "http",
        environment: "dev",
        base_url: "https://{tenant}.example/{token}",
        validation: {
          ok: false,
          missing_fields: [],
          errors: [
            { path: "base_url.tenant", message: "missing" },
            { path: "custom", message: "invalid" },
            { path: "custom", message: "duplicate" },
          ],
        },
      }),
    ).toEqual(["name", "base_url.tenant", "base_url.token", "auth_type", "custom"]);
    expect(
      computeConnectorMissingFields({
        name: "db",
        driver: "postgres",
        environment: "dev",
        auth_type: "none",
      }),
    ).toEqual(["dsn"]);
    for (const driver of ["graphql", "s3"] as const) {
      expect(
        computeConnectorMissingFields({
          name: "remote",
          driver,
          environment: "dev",
          auth_type: "none",
        }),
      ).toEqual(["base_url"]);
    }
    expect(computeWorkflowMissingFields({ name: "", steps: [] })).toEqual([
      "workflow.name",
      "workflow.steps",
    ]);
    expect(
      computeWorkflowMissingFields(
        { name: "", steps: [] },
        {
          kind: "workflow",
          name: "saved",
          slug: null,
          id: "workflow-1",
          environment: "prod",
          lifecycle_state: "persisted",
        },
      ),
    ).toEqual([]);
  });

  it("preserves exact target fallbacks and lifecycle precedence for sparse drafts", () => {
    const connector: ConnectorDraftDocument = {
      driver: "http",
      auth_type: "none",
    };
    const focused = createEmptyState("connector");
    focused.authoring_focus = "connector";
    expect(computeActiveTarget(focused, connector, emptyWorkflow())).toEqual({
      kind: "connector",
      name: null,
      slug: null,
      id: null,
      environment: null,
      lifecycle_state: "draft_only",
    });
    const connectorPersisted = createEmptyState("connector");
    connectorPersisted.checkpoints.connector_persisted = checkpoint("connector_persisted", 0);
    expect(
      computeActiveTarget(
        connectorPersisted,
        { ...connector, saved_connector_id: "connector-1", name: "Saved", environment: "dev" },
        emptyWorkflow(),
      ).lifecycle_state,
    ).toBe("persisted");
    expect(
      computeActiveTarget(connectorPersisted, connector, emptyWorkflow()).lifecycle_state,
    ).toBe("draft_only");

    const workflowState = createEmptyState("workflow");
    workflowState.persisted_resources = [
      {
        kind: "workflow",
        id: "workflow-1",
        slug: "persisted-slug",
        name: "Persisted workflow",
        version_id: "v1",
        version: 1,
        environment: "prod",
        saved_at: new Date(FROZEN_NOW).toISOString(),
      },
    ];
    expect(
      computeActiveTarget(
        workflowState,
        { ...connector, environment: "dev" },
        { name: "", steps: [{ id: "one", kind: "transform" }] },
      ),
    ).toEqual({
      kind: "workflow",
      name: "Persisted workflow",
      slug: "persisted-slug",
      id: "workflow-1",
      environment: "dev",
      lifecycle_state: "draft_only",
    });
    workflowState.workflow_mutation_seq = 1;
    expect(computeActiveTarget(workflowState, connector, emptyWorkflow()).lifecycle_state).toBe(
      "draft_only",
    );
    workflowState.checkpoints.workflow_persisted = checkpoint("workflow_persisted", 1);
    expect(computeActiveTarget(workflowState, connector, emptyWorkflow()).lifecycle_state).toBe(
      "persisted",
    );
  });

  it("chooses connector, in-progress workflow, persisted workflow, fallback connector, or no target", () => {
    const connector: ConnectorDraftDocument = {
      name: "Connector",
      slug: "connector",
      driver: "http",
      environment: "dev",
      auth_type: "none",
      saved_connector_id: "connector-1",
    };
    const state = createEmptyState("connector");
    state.authoring_focus = "connector";
    const { saved_connector_id: _savedConnectorId, ...unsavedConnector } = connector;
    expect(computeActiveTarget(state, unsavedConnector, emptyWorkflow())).toMatchObject({
      kind: "connector",
      lifecycle_state: "draft_only",
      id: null,
    });
    expect(computeActiveTarget(state, connector, workflowDraft())).toMatchObject({
      kind: "workflow",
      name: "github-briefing",
      lifecycle_state: "draft_only",
    });
    state.persisted_resources = [
      {
        kind: "workflow",
        id: "workflow-1",
        slug: "saved",
        name: "Saved workflow",
        version_id: "v1",
        version: 1,
        environment: "prod",
        saved_at: new Date(FROZEN_NOW).toISOString(),
      },
    ];
    expect(computeActiveTarget(state, connector, emptyWorkflow())).toMatchObject({
      kind: "workflow",
      id: "workflow-1",
      name: "Saved workflow",
    });
    state.persisted_resources = [
      {
        kind: "connector",
        id: "connector-1",
        slug: "saved-connector",
        name: "Saved connector",
        version_id: null,
        version: null,
        environment: "prod",
        saved_at: new Date(FROZEN_NOW).toISOString(),
      },
    ];
    expect(computeActiveTarget(state, connector, emptyWorkflow())).toMatchObject({
      kind: "connector",
      id: "connector-1",
      lifecycle_state: "draft_only",
    });
    expect(computeActiveTarget(createEmptyState("connector"), null, emptyWorkflow())).toMatchObject(
      { kind: "none" },
    );
  });

  it("derives labels, surface modes, and stages across lifecycle priorities", () => {
    const state = createEmptyState("workflow");
    const none = emptySummary().active_target;
    const connector = activeConnector();
    const workflow = activeWorkflow();
    expect(
      computeProgressLabel(
        connector,
        { ...oauth2DraftValidated(), template_name: "Gmail" },
        emptyWorkflow(),
      ),
    ).toBe("Connector draft from Gmail");
    expect(computeProgressLabel(connector, oauth2DraftValidated(), emptyWorkflow())).toBe(
      "Connector draft",
    );
    expect(computeProgressLabel(workflow, null, workflowDraft())).toBe("1 workflow step");
    expect(
      computeProgressLabel(workflow, null, {
        ...workflowDraft(),
        steps: [workflowDraft().steps[0]!, workflowDraft().steps[0]!],
      }),
    ).toBe("2 workflow steps");
    expect(
      computeProgressLabel({ ...workflow, lifecycle_state: "persisted" }, null, emptyWorkflow()),
    ).toBe("Saved workflow");
    expect(
      computeProgressLabel({ ...workflow, lifecycle_state: "draft_only" }, null, emptyWorkflow()),
    ).toBe("Workflow draft");
    expect(computeProgressLabel(none, null, emptyWorkflow())).toBeNull();
    expect(computeSurfaceMode(state, connector)).toBe("connector");
    expect(computeSurfaceMode(state, workflow)).toBe("workflow");
    state.latest_execution = {
      execution_id: "e",
      workflow_id: null,
      workflow_version_id: null,
      status: "ok",
      environment: "dev",
      warnings_count: 0,
      recorded_at: "now",
      diagnosis_available: false,
    };
    expect(computeSurfaceMode(state, workflow)).toBe("execution");
    state.latest_diagnosis = {
      execution_id: "e",
      recorded_at: "now",
      reason: "reason",
      warning_sources: [],
      steps: [],
    };
    expect(computeSurfaceMode(state, workflow)).toBe("diagnosis");
    expect(computeStage(createEmptyState("connector"), none)).toBe("idle");
    expect(
      computeStage(createEmptyState("workflow"), { ...workflow, lifecycle_state: "none" }),
    ).toBe("workflow_targeted");
    expect(computeStage(createEmptyState("workflow"), workflow)).toBe("workflow_draft_started");
    const checked = createEmptyState("workflow");
    checked.checkpoints.workflow_inspected = checkpoint("workflow_inspected", 0);
    expect(computeStage(checked, workflow)).toBe("workflow_inspected");
    checked.checkpoints.workflow_validated = checkpoint("workflow_validated", 0);
    expect(computeStage(checked, workflow)).toBe("workflow_validated");
    checked.checkpoints.workflow_previewed = checkpoint("workflow_previewed", 0);
    expect(computeStage(checked, workflow)).toBe("workflow_previewed");
    checked.checkpoints.workflow_persisted = checkpoint("workflow_persisted", 0);
    expect(computeStage(checked, workflow)).toBe("workflow_persisted");
  });
});
