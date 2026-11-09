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
  computeActiveTarget,
  computeBlockedBy,
  computeConnectorMissingFields,
  computeNextAction,
  computeNextSuggestedTool,
  computeProgressLabel,
  computeReadiness,
  computeStage,
  computeWorkflowMissingFields,
} from "./authoring-summary.ts";

const connector = (): AuthoringSummary["active_target"] => ({
  kind: "connector",
  name: "Gmail",
  slug: "gmail",
  id: null,
  environment: "dev",
  lifecycle_state: "draft_only",
});
const workflow = (): AuthoringSummary["active_target"] => ({
  kind: "workflow",
  name: "briefing",
  slug: "briefing",
  id: null,
  environment: "dev",
  lifecycle_state: "draft_only",
});
const none = (): AuthoringSummary["active_target"] => ({
  kind: "none",
  name: null,
  slug: null,
  id: null,
  environment: null,
  lifecycle_state: "none",
});
const draft = (): WorkflowDraftDocument => ({
  name: "briefing",
  steps: [{ id: "one", kind: "transform", expression: "return {};", language: "javascript" }],
});
const connectorDraft = (): ConnectorDraftDocument => ({
  name: "Gmail",
  slug: "gmail",
  driver: "http",
  environment: "dev",
  auth_type: "oauth2",
  base_url: "https://gmail.example",
  validation: { ok: true, missing_fields: [], errors: [] },
  config: { oauth: { client_id: "id", client_secret: "secret" } },
});

function checkpoint(key: keyof ReturnType<typeof createEmptyState>["checkpoints"], sequence = 0) {
  return {
    key,
    mutation_seq: sequence,
    verified_at: new Date(FROZEN_NOW).toISOString(),
    verified_by_tool: "test",
    ok: true,
    summary: "checked",
  };
}

function freshConnector(
  ...keys: Array<
    "connector_inspected" | "connector_validated" | "connector_authenticated" | "connector_probed"
  >
) {
  const state = createEmptyState("connector");
  for (const key of keys) state.checkpoints[key] = checkpoint(key);
  return state;
}

describe("authoring lifecycle and next-step projections", () => {
  it("keeps every lifecycle stage and readiness boundary distinct", () => {
    const stages: Array<
      [keyof ReturnType<typeof createEmptyState>["checkpoints"], AuthoringStage]
    > = [
      ["connector_inspected", "connector_inspected"],
      ["connector_validated", "connector_validated"],
      ["connector_authenticated", "connector_authenticated"],
      ["connector_probed", "connector_probed"],
      ["connector_persisted", "connector_persisted"],
    ];
    for (const [key, stage] of stages) {
      const state = createEmptyState("connector");
      state.checkpoints[key] = checkpoint(key);
      expect(computeStage(state, connector())).toBe(stage);
    }
    expect(
      computeReadiness({ ...workflow(), lifecycle_state: "persisted" }, ["dry_run_workflow"]),
    ).toBe("ready_to_probe");
    expect(computeReadiness({ ...workflow(), lifecycle_state: "persisted" }, [])).toBe("saved");
    expect(computeReadiness(workflow(), ["missing:workflow.name"])).toBe("needs_input");
    expect(computeReadiness(connector(), ["probe_connector_draft"])).toBe("ready_to_probe");
    expect(computeReadiness(connector(), [])).toBe("ready_to_save");
    expect(computeReadiness(workflow(), ["dry_run_workflow"])).toBe("ready_to_probe");
    expect(computeReadiness(workflow(), [])).toBe("ready_to_save");
    expect(computeReadiness(none(), [])).toBe("drafting");
  });

  it("maps known and unknown blockers without disguising the first blocker", () => {
    const state = createEmptyState("workflow");
    const cases: Array<[string, string]> = [
      ["inspect_connector_draft", "Inspect the connector"],
      ["validate_connector_draft", "Validate the connector"],
      ["probe_connector_draft", "Probe the connector"],
      ["inspect_workflow_draft", "Inspect the workflow"],
      ["validate_draft", "Validate the workflow"],
      ["diagnose_latest_execution", "Inspect the latest execution"],
    ];
    expect(
      computeNextAction(state, connector(), ["missing:name", "missing:base_url"], draft()),
    ).toContain("name, base_url");
    expect(computeNextAction(state, workflow(), ["missing:workflow.name"], draft())).toContain(
      "Add a workflow",
    );
    for (const [blocked, message] of cases) {
      expect(computeNextAction(state, workflow(), [blocked], draft())).toContain(message);
      expect(computeNextSuggestedTool(state, workflow(), [blocked], draft())).toBe(blocked);
    }
    expect(computeNextAction(state, workflow(), ["dry_run_workflow"], draft())).toContain(
      "Preview the workflow",
    );
    expect(
      computeNextAction(
        state,
        { ...workflow(), lifecycle_state: "persisted" },
        ["dry_run_workflow"],
        draft(),
      ),
    ).toContain("held writes");
    expect(computeNextSuggestedTool(state, none(), ["unknown"], draft())).toBeNull();
    expect(computeNextAction(state, none(), ["unknown"], draft())).toBe(
      "Continue the conversation.",
    );
  });

  it("selects actions only for the exact target and lifecycle combination", () => {
    const savedConnector = { ...connector(), lifecycle_state: "persisted" as const };
    const savedWorkflow = { ...workflow(), lifecycle_state: "persisted" as const };
    expect(computeNextAction(createEmptyState("connector"), connector(), [], draft())).toContain(
      "Save the connector",
    );
    expect(computeNextSuggestedTool(createEmptyState("connector"), connector(), [], draft())).toBe(
      "save_connector_draft",
    );
    expect(
      computeNextAction(createEmptyState("connector"), savedConnector, [], { name: "", steps: [] }),
    ).toContain("Describe the workflow");
    expect(
      computeNextSuggestedTool(createEmptyState("connector"), savedConnector, [], {
        name: "",
        steps: [],
      }),
    ).toBe("author_workflow");
    expect(
      computeNextAction(createEmptyState("workflow"), workflow(), [], {
        ...draft(),
        execution_privacy: "sensitive",
      }),
    ).toContain("metadata-only");
    expect(computeNextSuggestedTool(createEmptyState("workflow"), workflow(), [], draft())).toBe(
      "save_workflow_draft",
    );
    expect(computeNextAction(createEmptyState("workflow"), savedConnector, [], draft())).toBe(
      "Continue the conversation.",
    );
    expect(
      computeNextSuggestedTool(createEmptyState("workflow"), savedConnector, [], draft()),
    ).toBeNull();
    expect(computeNextAction(createEmptyState("workflow"), savedWorkflow, [], draft())).toContain(
      "Run the saved workflow",
    );
    expect(computeNextSuggestedTool(createEmptyState("workflow"), savedWorkflow, [], draft())).toBe(
      "run_workflow",
    );
  });

  it("keeps connector gates, preview success, and diagnosis gates independent", () => {
    expect(
      computeBlockedBy(
        freshConnector("connector_inspected"),
        connectorDraft(),
        { name: "", steps: [] },
        null,
        connector(),
      ),
    ).toEqual(["validate_connector_draft", "authenticate_oauth"]);
    expect(
      computeBlockedBy(
        freshConnector("connector_validated"),
        connectorDraft(),
        { name: "", steps: [] },
        null,
        connector(),
      ),
    ).toEqual(["inspect_connector_draft", "authenticate_oauth"]);
    expect(
      computeBlockedBy(
        freshConnector("connector_authenticated"),
        connectorDraft(),
        { name: "", steps: [] },
        null,
        connector(),
      ),
    ).toEqual(["inspect_connector_draft", "validate_connector_draft", "probe_connector_draft"]);
    const probeReady = freshConnector(
      "connector_inspected",
      "connector_validated",
      "connector_probed",
    );
    expect(
      computeBlockedBy(
        probeReady,
        {
          ...connectorDraft(),
          auth_type: "none",
          latest_probe: { ok: true, method: "GET", path: "/", environment: "dev", summary: "ok" },
        },
        { name: "", steps: [] },
        null,
        connector(),
      ),
    ).toEqual([]);
    const state = createEmptyState("workflow");
    state.checkpoints.workflow_inspected = checkpoint("workflow_inspected");
    state.checkpoints.workflow_validated = checkpoint("workflow_validated");
    state.checkpoints.workflow_previewed = checkpoint("workflow_previewed");
    expect(
      computeBlockedBy(
        state,
        null,
        draft(),
        { ok: false, summary: "failed", step_traces: [] },
        workflow(),
      ),
    ).toEqual(["dry_run_workflow"]);
    expect(
      computeBlockedBy(
        state,
        null,
        draft(),
        { ok: true, summary: "ok", step_traces: [] },
        workflow(),
      ),
    ).toEqual([]);
    state.latest_execution = {
      execution_id: "e",
      workflow_id: null,
      workflow_version_id: null,
      status: "failed",
      environment: "dev",
      warnings_count: 0,
      recorded_at: "now",
      diagnosis_available: true,
    };
    expect(
      computeBlockedBy(
        state,
        null,
        draft(),
        { ok: true, summary: "ok", step_traces: [] },
        workflow(),
      ),
    ).toEqual(["diagnose_latest_execution"]);
    state.checkpoints.workflow_diagnosed = checkpoint("workflow_diagnosed");
    expect(
      computeBlockedBy(
        state,
        null,
        draft(),
        { ok: true, summary: "ok", step_traces: [] },
        workflow(),
      ),
    ).toEqual([]);
  });

  it("prioritizes execution and diagnosis facts over the normal workflow stage", () => {
    const state = createEmptyState("workflow");
    state.latest_execution = {
      execution_id: "e",
      workflow_id: null,
      workflow_version_id: null,
      status: "ok",
      environment: "dev",
      warnings_count: 0,
      recorded_at: "now",
      diagnosis_available: true,
    };
    expect(computeStage(state, workflow())).toBe("workflow_executed");
    expect(
      computeNextAction(state, { ...workflow(), lifecycle_state: "persisted" }, [], draft()),
    ).toContain("Open diagnosis");
    expect(
      computeNextSuggestedTool(state, { ...workflow(), lifecycle_state: "persisted" }, [], draft()),
    ).toBe("diagnose_latest_execution");
    state.latest_diagnosis = {
      execution_id: "e",
      recorded_at: "now",
      reason: "why",
      warning_sources: [],
      steps: [],
    };
    expect(computeStage(state, workflow())).toBe("diagnosing");
    expect(
      computeNextAction(state, { ...workflow(), lifecycle_state: "persisted" }, [], draft()),
    ).toContain("based on the diagnosis");
    expect(
      computeNextSuggestedTool(state, { ...workflow(), lifecycle_state: "persisted" }, [], draft()),
    ).toBe("run_workflow");
    const executedWithoutDiagnosis = createEmptyState("workflow");
    executedWithoutDiagnosis.latest_execution = {
      execution_id: "e",
      workflow_id: null,
      workflow_version_id: null,
      status: "ok",
      environment: "dev",
      warnings_count: 0,
      recorded_at: "now",
      diagnosis_available: false,
    };
    expect(computeNextAction(executedWithoutDiagnosis, none(), [], draft())).toContain(
      "Review the latest execution",
    );
    expect(computeNextSuggestedTool(executedWithoutDiagnosis, none(), [], draft())).toBeNull();
  });

  it("requires review for a genuinely inactive persisted draft, but runs an active version", () => {
    const state = createEmptyState("workflow");
    const savedWorkflow = { ...workflow(), lifecycle_state: "persisted" as const };
    state.persisted_resources = [
      {
        kind: "workflow",
        id: "workflow-1",
        slug: "briefing",
        name: "briefing",
        version_id: "draft",
        draft_version_id: "draft",
        current_version_id: "active",
        version: 1,
        environment: "dev",
        saved_at: new Date(FROZEN_NOW).toISOString(),
        persistence_kind: "draft",
      },
    ];
    state.checkpoints.workflow_previewed = checkpoint("workflow_previewed");
    expect(computeNextAction(state, savedWorkflow, [], draft())).toContain("human review");
    expect(computeNextSuggestedTool(state, savedWorkflow, [], draft())).toBe(
      "review_workflow_automation",
    );
    expect(computeBlockedBy(state, null, draft(), null, savedWorkflow)).toEqual([
      "dry_run_workflow",
    ]);
    expect(
      computeBlockedBy(
        state,
        null,
        draft(),
        { ok: true, summary: "ok", step_traces: [] },
        savedWorkflow,
      ),
    ).toEqual([]);
    state.persisted_resources[0]!.version_id = "active";
    expect(computeNextAction(state, savedWorkflow, [], draft())).toContain(
      "Run the saved workflow",
    );
    expect(computeNextSuggestedTool(state, savedWorkflow, [], draft())).toBe("run_workflow");
  });

  it("preserves all absent connector fields and every unique validation error", () => {
    expect(computeConnectorMissingFields({ auth_type: "none" })).toEqual([
      "name",
      "driver",
      "environment",
    ]);
    expect(
      computeConnectorMissingFields({
        name: "x",
        driver: "http",
        environment: "dev",
        auth_type: "none",
      }),
    ).toEqual(["base_url"]);
    expect(
      computeConnectorMissingFields({
        name: "x",
        driver: "http",
        environment: "dev",
        auth_type: "none",
        base_url: "https://x",
        validation: {
          ok: false,
          missing_fields: [],
          errors: [
            { path: "a", message: "bad" },
            { path: "a", message: "same" },
            { path: "b", message: "bad" },
          ],
        },
      }),
    ).toEqual(["a", "b"]);
    expect(
      computeWorkflowMissingFields(
        { name: "", steps: [] },
        { ...workflow(), name: "saved", lifecycle_state: "persisted" },
      ),
    ).toEqual([]);
    expect(
      computeWorkflowMissingFields(
        { name: "", steps: [] },
        { ...workflow(), name: null, lifecycle_state: "draft_only" },
      ),
    ).toEqual(["workflow.name", "workflow.steps"]);
  });

  it("retains exact target identities and fallback precedence for saved and unsaved resources", () => {
    const focusConnector = createEmptyState("connector");
    expect(computeActiveTarget(focusConnector, null, { name: "", steps: [] })).toEqual(none());
    expect(
      computeActiveTarget(
        focusConnector,
        { name: "Draft", slug: "draft", environment: "dev", driver: "http", auth_type: "none" },
        { name: "", steps: [] },
      ),
    ).toMatchObject({
      kind: "connector",
      name: "Draft",
      slug: "draft",
      id: null,
      environment: "dev",
      lifecycle_state: "draft_only",
    });
    const workflowState = createEmptyState("workflow");
    workflowState.persisted_resources = [
      {
        kind: "workflow",
        id: "saved-id",
        slug: "saved-slug",
        name: "Saved",
        version_id: "v1",
        version: 1,
        environment: "prod",
        saved_at: new Date(FROZEN_NOW).toISOString(),
      },
    ];
    expect(
      computeActiveTarget(
        workflowState,
        {
          name: "Connector",
          slug: "connector",
          saved_connector_id: "connector-id",
          environment: "dev",
          driver: "http",
          auth_type: "none",
        },
        { name: "", steps: [] },
      ),
    ).toMatchObject({
      kind: "workflow",
      name: "Saved",
      slug: "saved-slug",
      id: "saved-id",
      environment: "prod",
      lifecycle_state: "persisted",
    });
    expect(
      computeActiveTarget(
        workflowState,
        {
          name: "Connector",
          slug: "connector",
          saved_connector_id: "connector-id",
          environment: "dev",
          driver: "http",
          auth_type: "none",
        },
        { name: "", slug: "draft-slug", steps: draft().steps },
      ),
    ).toMatchObject({
      kind: "workflow",
      name: "Saved",
      slug: "draft-slug",
      id: "saved-id",
      environment: "dev",
      lifecycle_state: "draft_only",
    });
    const connectorState = createEmptyState("workflow");
    connectorState.persisted_resources = [
      {
        kind: "connector",
        id: "persisted-id",
        slug: "persisted-slug",
        name: "Persisted",
        version_id: null,
        version: null,
        environment: "prod",
        saved_at: new Date(FROZEN_NOW).toISOString(),
      },
    ];
    expect(
      computeActiveTarget(
        connectorState,
        { driver: "http", auth_type: "none" },
        { name: "", steps: [] },
      ),
    ).toMatchObject({
      kind: "connector",
      name: "Persisted",
      slug: "persisted-slug",
      id: "persisted-id",
      environment: "prod",
    });
  });
});
