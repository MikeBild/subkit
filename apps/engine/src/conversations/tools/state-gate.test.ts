// Unit tests for the state-gate helpers — each helper covers happy +
// sad cases. The helpers are pure: they take a draft / summary and
// return either `null` (caller proceeds) or a structured
// `tool_unavailable_in_state` envelope.

import { describe, expect, test } from "bun:test";

import type { AuthoringSummary, DraftDocument } from "../types.ts";
import {
  requireAuthoringStage,
  requireConnectorDraft,
  requirePersistedConnector,
  requirePersistedWorkflow,
  requireWorkflowDraft,
} from "./state-gate.ts";

function summary(over: Partial<AuthoringSummary>): AuthoringSummary {
  return {
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
    ...over,
  };
}

const EMPTY_DRAFT: DraftDocument = {
  workflow: { name: "", steps: [] } as never,
};

describe("requireAuthoringStage", () => {
  test("returns null when summary is at the required stage", () => {
    const result = requireAuthoringStage(
      summary({ stage: "connector_probed" }),
      "connector_probed",
      "save_connector_draft",
    );
    expect(result).toBeNull();
  });

  test("returns null when summary is past the required stage on the same axis", () => {
    const result = requireAuthoringStage(
      summary({ stage: "connector_persisted" }),
      "connector_probed",
      "save_connector_draft",
    );
    expect(result).toBeNull();
  });

  test("returns a structured envelope when stage is below required", () => {
    const result = requireAuthoringStage(
      summary({ stage: "connector_validated" }),
      "connector_probed",
      "save_connector_draft",
    );
    expect(result).not.toBeNull();
    expect(result!.ok).toBe(false);
    if (!result!.ok) {
      expect(result!.error_code).toBe("tool_unavailable_in_state");
      expect(result!.next_best_actions).toContain("probe_connector_draft");
    }
  });

  test("emits a structured envelope when summary is null", () => {
    const result = requireAuthoringStage(null, "connector_probed", "save_connector_draft");
    expect(result).not.toBeNull();
    expect(result!.ok).toBe(false);
  });

  test("workflow stage progression returns workflow-flavoured next_best_actions", () => {
    const result = requireAuthoringStage(
      summary({ mode: "workflow", stage: "workflow_validated" }),
      "workflow_previewed",
      "save_workflow_draft",
    );
    expect(result).not.toBeNull();
    if (result && !result.ok) {
      expect(result.next_best_actions).toContain("dry_run_workflow");
    }
  });
});

describe("requireConnectorDraft", () => {
  test("returns null when draft has a connector", () => {
    const draft: DraftDocument = {
      ...EMPTY_DRAFT,
      connector: {
        name: "x",
        slug: "x",
        driver: "http",
        environment: "dev",
        base_url: "https://x",
        auth_type: "none",
        config: {},
        docs: [],
        latest_probe: null,
        saved_connector_id: null,
      },
    };
    expect(requireConnectorDraft(draft, "save_connector_draft")).toBeNull();
  });

  test("returns envelope when no connector is attached", () => {
    const result = requireConnectorDraft(EMPTY_DRAFT, "save_connector_draft");
    expect(result).not.toBeNull();
    if (result && !result.ok) {
      expect(result.error_code).toBe("tool_unavailable_in_state");
      expect(result.next_best_actions).toContain("start_connector_from_description");
    }
  });
});

describe("requirePersistedConnector", () => {
  test("returns null when active target is a persisted connector", () => {
    const result = requirePersistedConnector(
      summary({
        mode: "connector",
        active_target: {
          kind: "connector",
          name: "x",
          slug: "x",
          id: "c-1",
          environment: "dev",
          lifecycle_state: "persisted",
        },
      }),
      "authenticate_oauth",
    );
    expect(result).toBeNull();
  });

  test("returns null when persisted_resources lists a connector", () => {
    const result = requirePersistedConnector(
      summary({
        persisted_resources: [
          {
            kind: "connector",
            id: "c-1",
            slug: "x",
            name: "x",
            version_id: null,
            version: null,
            environment: "dev",
            saved_at: "2026-04-26T00:00:00Z",
          },
        ],
      }),
      "authenticate_oauth",
    );
    expect(result).toBeNull();
  });

  test("returns envelope when no connector has been persisted", () => {
    const result = requirePersistedConnector(summary({}), "authenticate_oauth");
    expect(result).not.toBeNull();
    if (result && !result.ok) {
      expect(result.next_best_actions).toContain("save_connector_draft");
    }
  });
});

describe("requireWorkflowDraft", () => {
  test("returns null when the draft has at least one step", () => {
    const draft: DraftDocument = {
      workflow: {
        name: "wf",
        steps: [{ id: "s1", kind: "request" }],
      } as never,
    };
    expect(requireWorkflowDraft(draft, "save_workflow_draft")).toBeNull();
  });

  test("returns envelope when the draft has no steps", () => {
    const result = requireWorkflowDraft(EMPTY_DRAFT, "save_workflow_draft");
    expect(result).not.toBeNull();
    if (result && !result.ok) {
      expect(result.next_best_actions).toContain("author_workflow");
    }
  });
});

describe("requirePersistedWorkflow", () => {
  test("returns null when active target is a persisted workflow", () => {
    const result = requirePersistedWorkflow(
      summary({
        mode: "workflow",
        active_target: {
          kind: "workflow",
          name: "x",
          slug: "x",
          id: "wf-1",
          environment: "dev",
          lifecycle_state: "persisted",
        },
      }),
      "run_workflow",
    );
    expect(result).toBeNull();
  });

  test("returns null when latest_execution carries a workflow_id", () => {
    const result = requirePersistedWorkflow(
      summary({
        mode: "execution",
        latest_execution: {
          execution_id: "ex-1",
          workflow_id: "wf-1",
          workflow_version_id: "wfv-1",
          status: "succeeded",
          environment: "dev",
          warnings_count: 0,
          recorded_at: "2026-04-26T00:00:00Z",
          diagnosis_available: false,
        },
      }),
      "run_workflow",
    );
    expect(result).toBeNull();
  });

  test("returns envelope when no workflow has been persisted", () => {
    const result = requirePersistedWorkflow(summary({}), "run_workflow");
    expect(result).not.toBeNull();
    if (result && !result.ok) {
      expect(result.next_best_actions).toContain("save_workflow_draft");
    }
  });
});
