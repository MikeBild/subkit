import { describe, expect, it } from "bun:test";
import { FROZEN_NOW } from "../../test-helpers/determinism/clock.ts";
import { createEmptyState } from "../authoring-state/normalize.ts";
import type { AuthoringSummary, ConnectorDraftDocument, WorkflowDraftDocument } from "../types.ts";
import {
  computeActiveTarget,
  computeBlockedBy,
  computeNextAction,
  computeNextSuggestedTool,
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

describe("authoring checkpoint and target gates", () => {
  it("does not promote stale checkpoints, null drafts, or failed probes into cleared gates", () => {
    const connectorState = freshConnector(
      "connector_inspected",
      "connector_validated",
      "connector_authenticated",
    );
    expect(
      computeBlockedBy(
        connectorState,
        {
          ...connectorDraft(),
          latest_probe: {
            ok: false,
            method: "GET",
            path: "/",
            environment: "dev",
            summary: "failed",
          },
        },
        { name: "", steps: [] },
        null,
        connector(),
      ),
    ).toEqual(["probe_connector_draft"]);
    expect(
      computeBlockedBy(
        createEmptyState("connector"),
        null,
        { name: "", steps: [] },
        null,
        connector(),
      ),
    ).toEqual(["inspect_connector_draft", "validate_connector_draft", "probe_connector_draft"]);
    const workflowState = createEmptyState("workflow");
    workflowState.checkpoints.workflow_inspected = checkpoint("workflow_inspected");
    workflowState.checkpoints.workflow_validated = checkpoint("workflow_validated");
    workflowState.checkpoints.workflow_previewed = checkpoint("workflow_previewed");
    expect(computeBlockedBy(workflowState, null, draft(), null, workflow())).toEqual([
      "dry_run_workflow",
    ]);
    workflowState.workflow_mutation_seq = 1;
    expect(
      computeBlockedBy(
        workflowState,
        null,
        draft(),
        { ok: true, summary: "ok", step_traces: [] },
        workflow(),
      ),
    ).toEqual(["inspect_workflow_draft", "validate_draft", "dry_run_workflow"]);
    expect(computeBlockedBy(createEmptyState("workflow"), null, draft(), null, none())).toEqual([]);
  });

  it("keeps connector-focus drafts distinct from matching persisted fallbacks", () => {
    const state = createEmptyState("workflow");
    state.authoring_focus = "connector";
    state.persisted_resources = [
      {
        kind: "connector",
        id: "persisted-id",
        slug: "persisted",
        name: "Persisted",
        version_id: null,
        version: null,
        environment: "prod",
        saved_at: new Date(FROZEN_NOW).toISOString(),
      },
    ];
    expect(
      computeActiveTarget(
        state,
        { name: "Focused", slug: "focused", environment: "dev", driver: "http", auth_type: "none" },
        { name: "", steps: [] },
      ),
    ).toEqual({
      kind: "connector",
      name: "Focused",
      slug: "focused",
      id: null,
      environment: "dev",
      lifecycle_state: "draft_only",
    });
    state.authoring_focus = null;
    expect(
      computeActiveTarget(
        state,
        { name: "Focused", slug: "focused", environment: "dev", driver: "http", auth_type: "none" },
        { name: "", steps: [] },
      ),
    ).toEqual({
      kind: "connector",
      name: "Focused",
      slug: "focused",
      id: "persisted-id",
      environment: "dev",
      lifecycle_state: "draft_only",
    });
  });

  it("does not infer a connector or workflow lifecycle action for an unrelated target", () => {
    const state = createEmptyState("workflow");
    const empty = { name: "", steps: [] } as WorkflowDraftDocument;
    expect(computeNextAction(state, none(), [], empty)).toBe("Continue the conversation.");
    expect(computeNextSuggestedTool(state, none(), [], empty)).toBeNull();
    expect(computeNextAction(state, none(), [], draft())).toBe("Continue the conversation.");
    expect(computeNextSuggestedTool(state, none(), [], draft())).toBeNull();
    const executed = createEmptyState("workflow");
    executed.latest_execution = {
      execution_id: "e",
      workflow_id: null,
      workflow_version_id: null,
      status: "ok",
      environment: "dev",
      warnings_count: 0,
      recorded_at: "now",
      diagnosis_available: false,
    };
    expect(
      computeNextAction(executed, { ...connector(), lifecycle_state: "persisted" }, [], draft()),
    ).toContain("Review the latest execution");
    expect(
      computeNextSuggestedTool(
        executed,
        { ...connector(), lifecycle_state: "persisted" },
        [],
        draft(),
      ),
    ).toBeNull();
  });

  it("keeps each post-blocker branch behind its own target and lifecycle predicate", () => {
    const state = createEmptyState("workflow");
    const empty = { name: "", steps: [] } as WorkflowDraftDocument;
    const savedConnector = { ...connector(), lifecycle_state: "persisted" as const };
    const savedWorkflow = { ...workflow(), lifecycle_state: "persisted" as const };
    expect(computeNextAction(state, connector(), [], empty)).toContain("Save the connector");
    expect(computeNextAction(state, savedConnector, [], empty)).toContain("Describe the workflow");
    expect(computeNextAction(state, savedConnector, [], draft())).toBe(
      "Continue the conversation.",
    );
    expect(computeNextAction(state, workflow(), [], empty)).toContain("Commit the workflow");
    expect(computeNextAction(state, savedWorkflow, [], empty)).toContain("Run the saved workflow");
    expect(computeNextAction(state, savedWorkflow, [], draft())).toContain(
      "Run the saved workflow",
    );
    expect(computeNextSuggestedTool(state, connector(), [], empty)).toBe("save_connector_draft");
    expect(computeNextSuggestedTool(state, savedConnector, [], empty)).toBe("author_workflow");
    expect(computeNextSuggestedTool(state, savedConnector, [], draft())).toBeNull();
    expect(computeNextSuggestedTool(state, workflow(), [], empty)).toBe("save_workflow_draft");
    expect(computeNextSuggestedTool(state, savedWorkflow, [], empty)).toBe("run_workflow");
  });

  it("separates fresh persisted workflow facts from stale draft facts", () => {
    const state = createEmptyState("workflow");
    state.persisted_resources = [
      {
        kind: "workflow",
        id: "workflow-1",
        slug: "briefing",
        name: "Saved",
        version_id: "v1",
        version: 1,
        environment: "prod",
        saved_at: new Date(FROZEN_NOW).toISOString(),
      },
    ];
    state.checkpoints.workflow_persisted = checkpoint("workflow_persisted");
    expect(computeActiveTarget(state, null, draft())).toMatchObject({
      kind: "workflow",
      name: "briefing",
      id: "workflow-1",
      environment: "prod",
      lifecycle_state: "persisted",
    });
    state.workflow_mutation_seq = 1;
    expect(computeActiveTarget(state, null, draft())).toMatchObject({
      kind: "workflow",
      lifecycle_state: "draft_only",
    });
    expect(
      computeBlockedBy(
        state,
        null,
        draft(),
        { ok: true, summary: "ok", step_traces: [] },
        workflow(),
      ),
    ).toEqual(["inspect_workflow_draft", "validate_draft", "dry_run_workflow"]);
  });

  it("requires a true validation and a true fresh probe independently", () => {
    const state = freshConnector(
      "connector_inspected",
      "connector_validated",
      "connector_authenticated",
      "connector_probed",
    );
    const goodProbe = {
      ok: true,
      method: "GET",
      path: "/",
      environment: "dev",
      summary: "ok",
    } as const;
    expect(
      computeBlockedBy(
        state,
        { ...connectorDraft(), latest_probe: goodProbe },
        { name: "", steps: [] },
        null,
        connector(),
      ),
    ).toEqual([]);
    expect(
      computeBlockedBy(
        state,
        {
          ...connectorDraft(),
          validation: { ok: false, missing_fields: [], errors: [] },
          latest_probe: goodProbe,
        },
        { name: "", steps: [] },
        null,
        connector(),
      ),
    ).toEqual(["validate_connector_draft"]);
    expect(
      computeBlockedBy(
        state,
        { ...connectorDraft(), latest_probe: { ...goodProbe, ok: false } },
        { name: "", steps: [] },
        null,
        connector(),
      ),
    ).toEqual(["probe_connector_draft"]);
  });

  it("projects empty, connector, workflow, and persisted target identities without cross-kind fallback", () => {
    const state = createEmptyState("workflow");
    expect(computeActiveTarget(state, null, { name: "", steps: [] })).toEqual(none());
    state.persisted_resources = [
      {
        kind: "workflow",
        id: "w",
        slug: "ws",
        name: "Saved workflow",
        version_id: "v",
        version: 1,
        environment: "prod",
        saved_at: new Date(FROZEN_NOW).toISOString(),
      },
    ];
    expect(computeActiveTarget(state, null, { name: "", steps: [] })).toMatchObject({
      kind: "workflow",
      id: "w",
      name: "Saved workflow",
      slug: "ws",
      environment: "prod",
      lifecycle_state: "persisted",
    });
    expect(
      computeActiveTarget(
        state,
        { name: "C", slug: "c", environment: "dev", driver: "http", auth_type: "none" },
        draft(),
      ),
    ).toMatchObject({
      kind: "workflow",
      name: "briefing",
      environment: "dev",
      lifecycle_state: "draft_only",
    });
  });

  it("keeps missing workflow, preview, validation, and probe blockers observable", () => {
    const incomplete = { ...workflow(), name: null };
    expect(
      computeBlockedBy(
        createEmptyState("workflow"),
        null,
        { name: "", steps: [] },
        null,
        incomplete,
      ),
    ).toEqual([
      "missing:workflow.name",
      "missing:workflow.steps",
      "inspect_workflow_draft",
      "validate_draft",
      "dry_run_workflow",
    ]);
    const connectorState = freshConnector(
      "connector_inspected",
      "connector_validated",
      "connector_authenticated",
      "connector_probed",
    );
    const { latest_probe: _withoutProbe, ...withoutProbe } = connectorDraft();
    expect(
      computeBlockedBy(connectorState, withoutProbe, { name: "", steps: [] }, null, connector()),
    ).toEqual(["probe_connector_draft"]);
  });

  it("does not turn display, blocker text, or unknown blockers into known actions", () => {
    const state = createEmptyState("workflow");
    expect(computeNextAction(state, connector(), ["missing:name"], draft())).toBe(
      "Collect the remaining connector fields before continuing: name.",
    );
    expect(computeNextSuggestedTool(state, connector(), ["missing:name"], draft())).toBe(
      "save_connector_draft",
    );
    expect(computeNextAction(state, workflow(), ["unknown"], draft())).toContain(
      "Commit the workflow",
    );
    expect(computeNextSuggestedTool(state, workflow(), ["unknown"], draft())).toBe(
      "save_workflow_draft",
    );
  });

  it("keeps missing blocker text scoped to missing fields even when later gates exist", () => {
    const state = createEmptyState("connector");
    expect(
      computeNextAction(
        state,
        connector(),
        ["missing:name", "inspect_connector_draft", "missing:base_url"],
        draft(),
      ),
    ).toBe("Collect the remaining connector fields before continuing: name, base_url.");
    expect(
      computeNextSuggestedTool(
        state,
        connector(),
        ["missing:name", "inspect_connector_draft"],
        draft(),
      ),
    ).toBe("save_connector_draft");
  });
});
