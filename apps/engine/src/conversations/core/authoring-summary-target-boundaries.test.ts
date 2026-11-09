import { describe, expect, it } from "bun:test";
import { FROZEN_NOW } from "../../test-helpers/determinism/clock.ts";
import { createEmptyState } from "../authoring-state/normalize.ts";
import type { AuthoringSummary, ConnectorDraftDocument, WorkflowDraftDocument } from "../types.ts";
import {
  computeActiveTarget,
  computeBlockedBy,
  computeNextAction,
  computeNextSuggestedTool,
  computeProgressLabel,
  computeReadiness,
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

describe("authoring target and optional-field boundaries", () => {
  it("keeps absent optional target fields null and preserves persisted workflow fallbacks", () => {
    const state = createEmptyState("workflow");
    state.persisted_resources = [
      {
        kind: "workflow",
        id: "w",
        slug: "saved",
        name: "Saved",
        version_id: "v",
        version: 1,
        environment: "prod",
        saved_at: new Date(FROZEN_NOW).toISOString(),
      },
    ];
    const target = computeActiveTarget(
      state,
      { driver: "http", auth_type: "none" },
      { name: "", steps: [] },
    );
    expect(target).toEqual({
      kind: "workflow",
      name: "Saved",
      slug: "saved",
      id: "w",
      environment: "prod",
      lifecycle_state: "persisted",
    });
    const connectorTarget = computeActiveTarget(
      createEmptyState("workflow"),
      { name: "C", driver: "http", auth_type: "none" },
      { name: "", steps: [] },
    );
    expect(connectorTarget).toEqual({
      kind: "connector",
      name: "C",
      slug: null,
      id: null,
      environment: null,
      lifecycle_state: "draft_only",
    });
  });

  it("keeps labels and final action branches separated when no blocker applies", () => {
    const state = createEmptyState("workflow");
    expect(
      computeProgressLabel(
        connector(),
        { ...connectorDraft(), template_name: "Template" },
        draft(),
      ),
    ).toBe("Connector draft from Template");
    expect(computeProgressLabel(connector(), connectorDraft(), draft())).toBe("Connector draft");
    expect(computeProgressLabel(workflow(), null, { name: "briefing", steps: [] })).toBe(
      "Workflow draft",
    );
    expect(
      computeProgressLabel({ ...workflow(), lifecycle_state: "persisted" }, null, {
        name: "briefing",
        steps: [],
      }),
    ).toBe("Saved workflow");
    expect(
      computeNextAction(state, { ...workflow(), lifecycle_state: "persisted" }, [], draft()),
    ).toContain("Run the saved workflow");
    expect(
      computeNextSuggestedTool(state, { ...workflow(), lifecycle_state: "persisted" }, [], draft()),
    ).toBe("run_workflow");
  });

  it("prioritizes inactive saved drafts, execution diagnosis, and reruns independently", () => {
    const inactive = createEmptyState("workflow");
    inactive.persisted_resources = [
      {
        kind: "workflow",
        id: "w",
        slug: "saved",
        name: "Saved",
        version_id: "draft",
        draft_version_id: "draft",
        current_version_id: "active",
        version: 1,
        environment: "prod",
        saved_at: new Date(FROZEN_NOW).toISOString(),
        persistence_kind: "draft",
      },
    ];
    const saved = { ...workflow(), lifecycle_state: "persisted" as const };
    expect(computeNextAction(inactive, saved, [], draft())).toContain("human review");
    expect(computeNextSuggestedTool(inactive, saved, [], draft())).toBe(
      "review_workflow_automation",
    );
    inactive.latest_execution = {
      execution_id: "e",
      workflow_id: "w",
      workflow_version_id: "v",
      status: "ok",
      environment: "prod",
      warnings_count: 0,
      recorded_at: "now",
      diagnosis_available: true,
    };
    expect(computeNextAction(inactive, saved, [], draft())).toContain("human review");
    inactive.persisted_resources[0]!.version_id = "active";
    expect(computeNextAction(inactive, saved, [], draft())).toContain("Open diagnosis");
    expect(computeNextSuggestedTool(inactive, saved, [], draft())).toBe(
      "diagnose_latest_execution",
    );
    inactive.latest_execution.diagnosis_available = false;
    expect(computeNextAction(inactive, saved, [], draft())).toContain(
      "Review the latest execution",
    );
    expect(computeNextSuggestedTool(inactive, saved, [], draft())).toBe("run_workflow");
  });

  it("does not let a stale connector checkpoint impersonate a fresh stage", () => {
    const state = createEmptyState("connector");
    state.checkpoints.connector_inspected = checkpoint("connector_inspected");
    expect(computeStage(state, connector())).toBe("connector_inspected");
    state.connector_mutation_seq = 1;
    expect(computeStage(state, connector())).toBe("connector_draft_started");
    state.checkpoints.connector_validated = checkpoint("connector_validated", 1);
    expect(computeStage(state, connector())).toBe("connector_validated");
  });

  it("does not route an inactive workflow draft to review for a connector target", () => {
    const state = createEmptyState("workflow");
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
        environment: "prod",
        saved_at: new Date(FROZEN_NOW).toISOString(),
        persistence_kind: "draft",
      },
    ];
    const savedConnector = { ...connector(), lifecycle_state: "persisted" as const };
    expect(computeNextAction(state, savedConnector, [], draft())).toBe(
      "Continue the conversation.",
    );
    expect(computeNextSuggestedTool(state, savedConnector, [], draft())).toBeNull();
    expect(computeNextAction(state, none(), [], draft())).toBe("Continue the conversation.");
    expect(computeNextSuggestedTool(state, none(), [], draft())).toBeNull();
  });

  it("keeps an inactive resource from replacing the active workflow draft save tool", () => {
    const state = createEmptyState("workflow");
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
        environment: "prod",
        saved_at: new Date(FROZEN_NOW).toISOString(),
        persistence_kind: "draft",
      },
    ];
    expect(computeNextAction(state, workflow(), [], draft())).toContain("Commit the workflow");
    expect(computeNextSuggestedTool(state, workflow(), [], draft())).toBe("save_workflow_draft");
  });

  it("maps every target-lifecycle combination to only its permitted post-blocker tool", () => {
    const blank = { name: "", steps: [] } as WorkflowDraftDocument;
    const connectorDraftTarget = connector();
    const connectorSavedTarget = { ...connector(), lifecycle_state: "persisted" as const };
    const workflowDraftTarget = workflow();
    const workflowSavedTarget = { ...workflow(), lifecycle_state: "persisted" as const };
    const ordinary = createEmptyState("workflow");
    const inactive = createEmptyState("workflow");
    inactive.persisted_resources = [
      {
        kind: "workflow",
        id: "w",
        slug: "saved",
        name: "Saved",
        version_id: "draft",
        draft_version_id: "draft",
        current_version_id: "active",
        version: 1,
        environment: "prod",
        saved_at: new Date(FROZEN_NOW).toISOString(),
        persistence_kind: "draft",
      },
    ];
    const cases: Array<
      [
        ReturnType<typeof createEmptyState>,
        AuthoringSummary["active_target"],
        WorkflowDraftDocument,
        string | null,
      ]
    > = [
      [ordinary, connectorDraftTarget, blank, "save_connector_draft"],
      [ordinary, connectorSavedTarget, blank, "author_workflow"],
      [ordinary, connectorSavedTarget, draft(), null],
      [ordinary, workflowDraftTarget, blank, "save_workflow_draft"],
      [ordinary, workflowSavedTarget, blank, "run_workflow"],
      [inactive, workflowSavedTarget, blank, "review_workflow_automation"],
      [inactive, none(), blank, null],
    ];
    for (const [state, target, document, expectedTool] of cases) {
      expect(computeNextSuggestedTool(state, target, [], document)).toBe(expectedTool);
    }
  });

  it("does not treat an unmaterialized connector or workflow target as a saveable draft", () => {
    const state = createEmptyState("workflow");
    const connectorNone: AuthoringSummary["active_target"] = {
      ...connector(),
      lifecycle_state: "none",
    };
    const workflowNone: AuthoringSummary["active_target"] = {
      ...workflow(),
      lifecycle_state: "none",
    };
    expect(computeNextAction(state, connectorNone, [], draft())).toBe("Continue the conversation.");
    expect(computeNextSuggestedTool(state, connectorNone, [], draft())).toBeNull();
    expect(computeNextAction(state, workflowNone, [], draft())).toBe("Continue the conversation.");
    expect(computeNextSuggestedTool(state, workflowNone, [], draft())).toBeNull();
  });

  it("preserves null connector and absent validation boundaries", () => {
    const connectorFocus = createEmptyState("workflow");
    connectorFocus.authoring_focus = "connector";
    expect(computeActiveTarget(connectorFocus, null, { name: "", steps: [] })).toEqual({
      ...none(),
      kind: "connector",
    });
    expect(
      computeBlockedBy(
        createEmptyState("connector"),
        { name: "C", driver: "http", environment: "dev", auth_type: "none" },
        { name: "", steps: [] },
        null,
        connector(),
      ),
    ).toContain("validate_connector_draft");
  });

  it("keeps probe, workflow, and persisted readiness gates scoped to their target", () => {
    const connectorState = freshConnector(
      "connector_inspected",
      "connector_validated",
      "connector_authenticated",
      "connector_probed",
    );
    const { latest_probe: _probe, ...unprobed } = connectorDraft();
    expect(
      computeBlockedBy(connectorState, unprobed, { name: "", steps: [] }, null, connector()),
    ).toEqual(["probe_connector_draft"]);
    expect(
      computeBlockedBy(createEmptyState("workflow"), null, draft(), null, connector()),
    ).toEqual(["inspect_connector_draft", "validate_connector_draft", "probe_connector_draft"]);
    expect(
      computeReadiness({ ...connector(), lifecycle_state: "persisted" }, ["dry_run_workflow"]),
    ).toBe("saved");
  });

  it("keeps null-safe workflow projections when no persisted resource or connector exists", () => {
    const steppedBlank = { name: "", steps: draft().steps };
    expect(computeActiveTarget(createEmptyState("workflow"), null, steppedBlank)).toEqual({
      kind: "workflow",
      name: null,
      slug: null,
      id: null,
      environment: null,
      lifecycle_state: "draft_only",
    });
    const persisted = createEmptyState("workflow");
    persisted.persisted_resources = [
      {
        kind: "workflow",
        id: "w",
        slug: null,
        name: null,
        version_id: "v",
        version: 1,
        environment: "prod",
        saved_at: new Date(FROZEN_NOW).toISOString(),
      },
    ];
    expect(computeActiveTarget(persisted, null, { name: "", steps: [] })).toMatchObject({
      kind: "workflow",
      environment: "prod",
    });
    const withoutEnvironment = createEmptyState("workflow");
    withoutEnvironment.persisted_resources = [
      {
        kind: "workflow",
        id: "w",
        slug: null,
        name: null,
        version_id: "v",
        version: 1,
        environment: null,
        saved_at: new Date(FROZEN_NOW).toISOString(),
      },
    ];
    expect(computeActiveTarget(withoutEnvironment, null, { name: "", steps: [] })).toMatchObject({
      environment: null,
    });
  });
});
