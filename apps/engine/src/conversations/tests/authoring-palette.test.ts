import { describe, expect, test } from "bun:test";
import {
  createEmptyDraftDocument,
  withConnectorDraft,
  withConnectorInspection,
  withConnectorPersisted,
  withConnectorProbe,
  withConnectorValidation,
  withLatestPreview,
  withWorkflowDiagnosis,
  withWorkflowDraft,
  withWorkflowExecution,
  withWorkflowInspection,
  withWorkflowPersisted,
  withWorkflowValidation,
} from "../authoring-state.ts";
import { validateConnectorDraft } from "../connector-draft.ts";
import { filterByAuthoringPalette } from "../tools/authoring-palette.ts";
import { listTools } from "../tools/index.ts";

describe("authoring tool palette", () => {
  test("keeps the broad palette outside focused authoring", () => {
    const visible = filterByAuthoringPalette(listTools(), createEmptyDraftDocument()).map(
      (tool) => tool.name,
    );
    expect(visible).toContain("create_api_key");
    expect(visible).toContain("list_users");
    expect(visible).toContain("start_connector_from_description");
  });

  test("hides unrelated admin tools during focused connector authoring", () => {
    const draft = withConnectorDraft(
      createEmptyDraftDocument(),
      {
        name: "Focused API",
        slug: "focused-api",
        driver: "http",
        environment: "dev",
        base_url: "https://api.example.com",
        auth_type: "none",
        config: {},
        docs: [],
        latest_probe: null,
        saved_connector_id: null,
        validation: validateConnectorDraft({
          name: "Focused API",
          slug: "focused-api",
          driver: "http",
          environment: "dev",
          base_url: "https://api.example.com",
          auth_type: "none",
          config: {},
          docs: [],
          latest_probe: null,
          saved_connector_id: null,
        }),
      },
      "connector_started_from_description",
    );
    const visible = filterByAuthoringPalette(listTools(), draft).map((tool) => tool.name);
    expect(visible).toContain("inspect_connector_draft");
    expect(visible).toContain("probe_connector_draft");
    expect(visible).not.toContain("save_connector_draft");
    expect(visible).not.toContain("build_workflow");
    expect(visible).not.toContain("create_api_key");
    expect(visible).not.toContain("delete_workflow");
    expect(visible).not.toContain("list_users");
  });

  test("shows save only after connector checkpoints are fresh", () => {
    let draft = withConnectorDraft(
      createEmptyDraftDocument(),
      {
        name: "Focused API",
        slug: "focused-api",
        driver: "http",
        environment: "dev",
        base_url: "https://api.example.com",
        auth_type: "none",
        config: {},
        docs: [],
        latest_probe: null,
        saved_connector_id: null,
        validation: validateConnectorDraft({
          name: "Focused API",
          slug: "focused-api",
          driver: "http",
          environment: "dev",
          base_url: "https://api.example.com",
          auth_type: "none",
          config: {},
          docs: [],
          latest_probe: null,
          saved_connector_id: null,
        }),
      },
      "connector_started_from_description",
    );
    draft = withConnectorInspection(draft);
    draft = withConnectorValidation(
      draft,
      {
        ...draft.connector,
        validation: { ok: true, missing_fields: [], errors: [] },
      },
      true,
      "Connector draft valid.",
    );
    draft = withConnectorProbe(
      draft,
      {
        ...draft.connector,
        latest_probe: {
          ok: true,
          method: "GET",
          path: "/ping",
          environment: "dev",
          status_code: 200,
          summary: "Probe ok.",
        },
      },
      true,
      "Probe ok.",
    );
    const visible = filterByAuthoringPalette(listTools(), draft).map((tool) => tool.name);
    expect(visible).toContain("save_connector_draft");
    expect(visible).toContain("build_workflow");
    expect(visible).toContain("dry_run_step");
  });

  test("opens workflow start tools after connector persistence", () => {
    let draft = withConnectorDraft(
      createEmptyDraftDocument(),
      {
        name: "Focused API",
        slug: "focused-api",
        driver: "http",
        environment: "dev",
        base_url: "https://api.example.com",
        auth_type: "none",
        config: {},
        docs: [],
        latest_probe: null,
        saved_connector_id: "connector_123",
        validation: { ok: true, missing_fields: [], errors: [] },
      },
      "connector_started_from_description",
    );
    draft = withConnectorPersisted(draft, draft.connector ?? null, {
      kind: "connector",
      id: "connector_123",
      name: "Focused API",
      slug: "focused-api",
      version_id: null,
      version: null,
      environment: "dev",
      saved_at: "2026-04-23T10:00:00.000Z",
    });
    const visible = filterByAuthoringPalette(listTools(), draft).map((tool) => tool.name);
    expect(visible).toContain("start_workflow_from_goal");
    expect(visible).toContain("build_workflow");
    expect(visible).toContain("inspect_workflow_draft");
    expect(visible).toContain("submit_connector_credential");
    expect(visible).not.toContain("save_connector_draft");
  });

  test("shows commit only after workflow preview is fresh", () => {
    let draft = withWorkflowDraft(
      createEmptyDraftDocument(),
      {
        name: "Focused Workflow",
        slug: "focused-workflow",
        steps: [{ id: "shape", kind: "transform", expression: "$input", language: "jsonata" }],
      },
      "workflow_seeded_from_goal",
    );
    let visible = filterByAuthoringPalette(listTools(), draft).map((tool) => tool.name);
    expect(visible).not.toContain("commit_draft");

    draft = withWorkflowInspection(draft);
    draft = withWorkflowValidation(draft, true, "Workflow valid.");
    draft = withLatestPreview(draft, {
      ok: true,
      step_id: "shape",
      summary: "Preview ok.",
    });
    visible = filterByAuthoringPalette(listTools(), draft).map((tool) => tool.name);
    expect(visible).toContain("commit_draft");
    expect(visible).not.toContain("run_workflow");
  });

  test("shows execution and diagnosis tools only when the persisted workflow state allows them", () => {
    let draft = withWorkflowDraft(
      createEmptyDraftDocument(),
      {
        name: "Focused Workflow",
        slug: "focused-workflow",
        steps: [{ id: "shape", kind: "transform", expression: "$input", language: "jsonata" }],
      },
      "workflow_seeded_from_goal",
    );
    draft = withWorkflowPersisted(draft, {
      kind: "workflow",
      id: "workflow_123",
      name: "Focused Workflow",
      slug: "focused-workflow",
      version_id: "version_1",
      version: 1,
      environment: "dev",
      saved_at: "2026-04-23T10:00:00.000Z",
    });
    const visible = filterByAuthoringPalette(listTools(), draft).map((tool) => tool.name);
    expect(visible).toContain("run_workflow");
    expect(visible).not.toContain("diagnose_latest_execution");
    expect(visible).toContain("list_connectors");
    expect(visible).toContain("build_workflow");
    expect(visible).not.toContain("commit_draft");
    expect(visible).not.toContain("start_connector_from_description");
    expect(visible).not.toContain("create_api_key");
    expect(visible).not.toContain("list_users");

    draft = withWorkflowExecution(draft, {
      execution_id: "exec_123",
      workflow_id: "workflow_123",
      workflow_version_id: "version_1",
      status: "succeeded",
      environment: "dev",
      warnings_count: 1,
      recorded_at: "2026-04-23T10:05:00.000Z",
      diagnosis_available: true,
    });
    const executionVisible = filterByAuthoringPalette(listTools(), draft).map((tool) => tool.name);
    expect(executionVisible).toContain("run_workflow");
    expect(executionVisible).toContain("diagnose_latest_execution");

    draft = withWorkflowDiagnosis(draft, {
      execution_id: "exec_123",
      recorded_at: "2026-04-23T10:06:00.000Z",
      reason: "Missing .data in transform scope path.",
      warning_sources: [],
      steps: [],
    });
    const diagnosisVisible = filterByAuthoringPalette(listTools(), draft).map((tool) => tool.name);
    expect(diagnosisVisible).not.toContain("run_workflow");
    expect(diagnosisVisible).not.toContain("diagnose_latest_execution");
    expect(diagnosisVisible).toContain("build_workflow");
  });
});
