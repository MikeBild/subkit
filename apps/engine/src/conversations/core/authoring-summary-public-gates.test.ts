import { describe, expect, it } from "bun:test";
import { FROZEN_NOW } from "../../test-helpers/determinism/clock.ts";
import { createEmptyState } from "../authoring-state/normalize.ts";
import type { AuthoringSummary, ConnectorDraftDocument, WorkflowDraftDocument } from "../types.ts";
import {
  computeBlockedBy,
  computeNextAction,
  computeNextSuggestedTool,
  computeProgressLabel,
  computeStage,
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

describe("authoring public input gate contracts", () => {
  it("keeps connector and workflow gate families isolated across probe and inactive-draft facts", () => {
    const inspected = freshConnector("connector_inspected", "connector_validated");
    const nonOAuth = { ...connectorDraft(), auth_type: "none" as const };
    expect(
      computeBlockedBy(inspected, nonOAuth, { name: "", steps: [] }, null, connector()),
    ).toEqual(["probe_connector_draft"]);

    const workflowState = createEmptyState("workflow");
    workflowState.persisted_resources = [
      {
        kind: "workflow",
        id: "w",
        slug: "saved",
        name: "Saved",
        version_id: "active",
        draft_version_id: "active",
        current_version_id: "active",
        version: 1,
        environment: "prod",
        saved_at: new Date(FROZEN_NOW).toISOString(),
        persistence_kind: "draft",
      },
    ];
    expect(
      computeBlockedBy(
        workflowState,
        null,
        draft(),
        { ok: true, summary: "ok", step_traces: [] },
        { ...workflow(), lifecycle_state: "persisted" },
      ),
    ).toEqual([]);
    expect(computeBlockedBy(workflowState, null, draft(), null, connector())).toEqual([
      "inspect_connector_draft",
      "validate_connector_draft",
      "probe_connector_draft",
    ]);
  });

  it("does not skip validation or probe gates when their optional result object is absent", () => {
    const state = freshConnector(
      "connector_inspected",
      "connector_validated",
      "connector_authenticated",
      "connector_probed",
    );
    const bareConnector = {
      name: "C",
      driver: "http" as const,
      environment: "dev" as const,
      auth_type: "none" as const,
      base_url: "https://connector.example",
    };
    expect(
      computeBlockedBy(state, bareConnector, { name: "", steps: [] }, null, connector()),
    ).toEqual(["validate_connector_draft", "probe_connector_draft"]);
    expect(
      computeBlockedBy(createEmptyState("workflow"), null, draft(), null, workflow()),
    ).toContain("inspect_workflow_draft");

    const fullyFresh = freshConnector(
      "connector_inspected",
      "connector_validated",
      "connector_authenticated",
      "connector_probed",
    );
    expect(computeBlockedBy(fullyFresh, null, draft(), null, connector())).toEqual([
      "validate_connector_draft",
      "probe_connector_draft",
    ]);
  });

  it("keeps concrete missing field prefixes and connector targeting out of workflow branches", () => {
    const incomplete = {
      driver: "http" as const,
      environment: "dev" as const,
      auth_type: "none" as const,
      base_url: "https://connector.example",
    };
    expect(
      computeBlockedBy(
        createEmptyState("connector"),
        incomplete,
        { name: "", steps: [] },
        null,
        connector(),
      ),
    ).toContain("missing:name");
    const state = createEmptyState("workflow");
    state.persisted_resources = [
      {
        kind: "connector",
        id: "c",
        slug: "saved",
        name: "Saved",
        version_id: null,
        version: null,
        environment: "dev",
        saved_at: new Date(FROZEN_NOW).toISOString(),
      },
    ];
    expect(
      computeBlockedBy(state, incomplete, { name: "", steps: [] }, null, connector()),
    ).not.toContain("missing:workflow.name");
  });

  it("keeps exact empty connector display, stage, and none-lifecycle action fallbacks", () => {
    const emptyConnector: AuthoringSummary["active_target"] = {
      ...connector(),
      lifecycle_state: "none",
    };
    expect(computeStage(createEmptyState("connector"), connector())).toBe(
      "connector_draft_started",
    );
    expect(computeProgressLabel(connector(), null, draft())).toBe("Connector draft");
    expect(
      computeNextAction(createEmptyState("workflow"), emptyConnector, [], { name: "", steps: [] }),
    ).toBe("Continue the conversation.");
    expect(
      computeNextSuggestedTool(createEmptyState("workflow"), emptyConnector, [], {
        name: "",
        steps: [],
      }),
    ).toBeNull();
  });

  it("does not force connector gates, workflow gates, or save branches across target kinds", () => {
    const state = createEmptyState("workflow");
    expect(computeBlockedBy(state, null, draft(), null, workflow())).toEqual([
      "inspect_workflow_draft",
      "validate_draft",
      "dry_run_workflow",
    ]);
    expect(computeBlockedBy(state, null, draft(), null, none())).toEqual([]);

    const workflowNone: AuthoringSummary["active_target"] = {
      ...workflow(),
      lifecycle_state: "none",
    };
    expect(computeNextAction(state, workflowNone, [], draft())).toBe("Continue the conversation.");
    expect(computeNextSuggestedTool(state, workflowNone, [], draft())).toBeNull();
  });

  it("keeps public none and cross-target lifecycle inputs from taking workflow save or review branches", () => {
    const state = createEmptyState("workflow");
    const noneTarget: AuthoringSummary["active_target"] = {
      kind: "none",
      name: null,
      slug: null,
      id: null,
      environment: null,
      lifecycle_state: "none",
    };
    expect(computeNextAction(state, noneTarget, [], draft())).toBe("Continue the conversation.");
    expect(computeNextSuggestedTool(state, noneTarget, [], draft())).toBeNull();

    state.persisted_resources = [
      {
        kind: "workflow",
        id: "w",
        slug: "saved",
        name: "Saved",
        version_id: "draft",
        draft_version_id: "draft",
        current_version_id: "active",
        version: 1,
        environment: "dev",
        saved_at: new Date(FROZEN_NOW).toISOString(),
        persistence_kind: "draft",
      },
    ];
    const workflowNone: AuthoringSummary["active_target"] = {
      ...workflow(),
      lifecycle_state: "none",
    };
    expect(computeBlockedBy(state, null, { name: "", steps: [] }, null, workflowNone)).toEqual([
      "missing:workflow.steps",
    ]);
    const connectorPersisted: AuthoringSummary["active_target"] = {
      ...connector(),
      lifecycle_state: "persisted",
    };
    expect(computeNextAction(state, connectorPersisted, [], draft())).toBe(
      "Continue the conversation.",
    );
    expect(computeNextSuggestedTool(state, connectorPersisted, [], draft())).toBeNull();
  });

  it("requires a fresh probe and preview even when their prior result was successful", () => {
    const connectorState = freshConnector(
      "connector_inspected",
      "connector_validated",
      "connector_authenticated",
    );
    const completedProbe = {
      ...connectorDraft(),
      auth_type: "none" as const,
      latest_probe: {
        ok: true,
        method: "GET",
        path: "/",
        environment: "dev" as const,
        summary: "ok",
      },
    };
    expect(
      computeBlockedBy(connectorState, completedProbe, { name: "", steps: [] }, null, connector()),
    ).toEqual(["probe_connector_draft"]);

    const workflowState = createEmptyState("workflow");
    workflowState.persisted_resources = [
      {
        kind: "workflow",
        id: "w",
        slug: "saved",
        name: "Saved",
        version_id: "draft",
        draft_version_id: "draft",
        current_version_id: "active",
        version: 1,
        environment: "dev",
        saved_at: new Date(FROZEN_NOW).toISOString(),
        persistence_kind: "draft",
      },
    ];
    expect(
      computeBlockedBy(
        workflowState,
        null,
        { name: "", steps: [] },
        { ok: true, summary: "ok", step_traces: [] },
        { ...workflow(), lifecycle_state: "persisted" },
      ),
    ).toEqual(["dry_run_workflow"]);
  });

  it("honors independent public target kind and lifecycle values in action and tool guards", () => {
    const noneDraft: AuthoringSummary["active_target"] = {
      kind: "none",
      name: null,
      slug: null,
      id: null,
      environment: null,
      lifecycle_state: "draft_only",
    };
    expect(computeNextAction(createEmptyState("workflow"), noneDraft, [], draft())).toBe(
      "Continue the conversation.",
    );
    expect(
      computeNextSuggestedTool(createEmptyState("workflow"), noneDraft, [], draft()),
    ).toBeNull();

    const pending = createEmptyState("workflow");
    pending.persisted_resources = [
      {
        kind: "workflow",
        id: "w",
        slug: "saved",
        name: "Saved",
        version_id: "draft-v2",
        draft_version_id: "draft-v2",
        current_version_id: "live-v1",
        version: 2,
        environment: "dev",
        saved_at: new Date(FROZEN_NOW).toISOString(),
        persistence_kind: "draft",
      },
    ];
    const workflowNone: AuthoringSummary["active_target"] = {
      ...workflow(),
      lifecycle_state: "none",
    };
    expect(computeNextAction(pending, workflowNone, [], draft())).toBe(
      "Continue the conversation.",
    );
    expect(computeNextSuggestedTool(pending, workflowNone, [], draft())).toBeNull();
  });

  it("does not enter connector or workflow draft gates for public non-draft targets", () => {
    expect(
      computeBlockedBy(createEmptyState("connector"), connectorDraft(), draft(), null, {
        ...connector(),
        lifecycle_state: "persisted",
      }),
    ).toEqual([]);
    expect(
      computeBlockedBy(createEmptyState("workflow"), null, draft(), null, {
        kind: "none",
        name: null,
        slug: null,
        id: null,
        environment: null,
        lifecycle_state: "draft_only",
      }),
    ).toEqual([]);
  });
});
