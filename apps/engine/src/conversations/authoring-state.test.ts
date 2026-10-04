import { describe, expect, test } from "bun:test";
import {
  bindPersistedWorkflow,
  createEmptyDraftDocument,
  normalizeDraftDocument,
  startNewWorkflowDraft,
  withConnectorDraft,
  withConnectorInspection,
  withConnectorProbe,
  withConnectorValidation,
  withLatestPreview,
  withWorkflowDraft,
  withWorkflowInspection,
  withWorkflowValidation,
} from "./authoring-state.ts";

describe("authoring-state", () => {
  test("createEmptyDraftDocument stores the workflow only in draft.workflow", () => {
    const draft = createEmptyDraftDocument();
    expect(draft.workflow.name).toBe("new-workflow");
    expect(draft.workflow.steps).toEqual([]);
    expect("name" in (draft as unknown as Record<string, unknown>)).toBe(false);
    expect("steps" in (draft as unknown as Record<string, unknown>)).toBe(false);
  });

  test("normalizeDraftDocument prefers the nested workflow shape", () => {
    const draft = normalizeDraftDocument({
      name: "stale-top-level",
      steps: [{ id: "top", kind: "wait", duration_ms: 1 }],
      workflow: {
        name: "nested-workflow",
        steps: [{ id: "nested", kind: "wait", duration_ms: 2 }],
      },
    });
    expect(draft.workflow.name).toBe("nested-workflow");
    expect(draft.workflow.steps[0]).toEqual({ id: "nested", kind: "wait", duration_ms: 2 });
  });

  test("normalizeDraftDocument ignores top-level workflow fields without draft.workflow", () => {
    const draft = normalizeDraftDocument({
      name: "earlier-top-level",
      steps: [{ id: "top", kind: "wait", duration_ms: 1 }],
    });
    expect(draft.workflow).toEqual({
      name: "new-workflow",
      steps: [],
    });
  });

  test("normalizeDraftDocument ignores connector.template_id aliases", () => {
    const draft = normalizeDraftDocument({
      connector: {
        name: "earlier-template-id",
        template_id: "old-template",
      },
    });
    expect(draft.connector?.name).toBe("earlier-template-id");
    expect(draft.connector?.template_slug).toBeUndefined();
  });

  test("normalizeDraftDocument does not synthesize checkpoints from draft fields", () => {
    const draft = normalizeDraftDocument({
      connector: {
        name: "earlier-connector",
        environment: "dev",
        saved_connector_id: "connector_123",
        validation: { ok: true, missing_fields: [], errors: [] },
        latest_probe: {
          ok: true,
          method: "GET",
          path: "/health",
          environment: "dev",
          summary: "Probe ok.",
        },
      },
      workflow: {
        name: "earlier-workflow",
        steps: [{ id: "fetch", kind: "request", url: "https://example.com" }],
      },
      latest_preview: {
        ok: true,
        step_id: "fetch",
        summary: "Preview ok.",
      },
    });
    expect(draft.state?.checkpoints).toEqual({});
    expect(draft.summary?.checkpoints.every((checkpoint) => checkpoint.status === "missing")).toBe(
      true,
    );
    expect(draft.summary?.persisted_resources).toEqual([]);
  });

  test("withWorkflowDraft keeps the canonical nested shape", () => {
    const draft = withWorkflowDraft(createEmptyDraftDocument(), {
      name: "daily-sync",
      slug: "daily-sync",
      steps: [{ id: "fetch", kind: "request", url: "https://example.com" }],
    });
    expect(draft.workflow.slug).toBe("daily-sync");
    expect("slug" in (draft as unknown as Record<string, unknown>)).toBe(false);
  });

  test("bindPersistedWorkflow keeps a saved workflow active without local steps", () => {
    const draft = bindPersistedWorkflow(createEmptyDraftDocument(), {
      kind: "workflow",
      id: "wf_123",
      slug: "berlin-weather",
      name: "Berlin Weather",
      version_id: "wfv_123",
      version: 1,
      environment: null,
      saved_at: "2026-04-25T08:00:00.000Z",
    });
    expect(draft.summary?.active_target).toEqual({
      kind: "workflow",
      id: "wf_123",
      slug: "berlin-weather",
      name: "Berlin Weather",
      environment: null,
      lifecycle_state: "persisted",
    });
    expect(draft.summary?.missing_fields).not.toContain("workflow.steps");
  });

  test("startNewWorkflowDraft clears the saved workflow binding and resets workflow state", () => {
    const persisted = bindPersistedWorkflow(
      withWorkflowDraft(createEmptyDraftDocument(), {
        name: "berlin-weather",
        slug: "berlin-weather",
        steps: [{ id: "fetch", kind: "wait", duration_ms: 1 }],
      }),
      {
        kind: "workflow",
        id: "wf_123",
        slug: "berlin-weather",
        name: "Berlin Weather",
        version_id: "wfv_123",
        version: 4,
        environment: null,
        saved_at: "2026-04-25T08:00:00.000Z",
      },
    );

    const draft = startNewWorkflowDraft(persisted);
    expect(draft.workflow).toEqual({
      name: "new-workflow",
      steps: [],
    });
    expect(draft.summary?.active_target).toEqual({
      kind: "none",
      id: null,
      slug: null,
      name: null,
      environment: null,
      lifecycle_state: "none",
    });
    expect(draft.summary?.persisted_resources).toEqual([]);
    expect(draft.summary?.missing_fields).toContain("workflow.steps");
  });

  test("ready connector drafts surface save_connector_draft as the next suggested tool", () => {
    let draft = withConnectorDraft(createEmptyDraftDocument(), {
      name: "Acme API",
      slug: "acme-api",
      driver: "http",
      environment: "dev",
      base_url: "https://api.example.com",
      auth_type: "none",
      config: {},
      docs: [],
      latest_probe: null,
      saved_connector_id: null,
      validation: { ok: true, missing_fields: [], errors: [] },
    });
    draft = withConnectorInspection(draft);
    const connector = draft.connector;
    if (!connector) throw new Error("connector draft missing");
    draft = withConnectorValidation(
      draft,
      {
        ...connector,
        validation: { ok: true, missing_fields: [], errors: [] },
      },
      true,
      "Connector draft valid.",
    );
    draft = withConnectorProbe(
      draft,
      {
        ...connector,
        latest_probe: {
          ok: true,
          method: "GET",
          path: "/health",
          environment: "dev",
          status_code: 200,
          summary: "Probe ok.",
        },
      },
      true,
      "Probe ok.",
    );

    expect(draft.summary?.next_action).toContain("Save the connector");
    expect(draft.summary?.next_suggested_tool).toBe("save_connector_draft");
  });

  test("ready workflow drafts surface save_workflow_draft as the next suggested tool", () => {
    let draft = withWorkflowDraft(createEmptyDraftDocument(), {
      name: "daily-sync",
      slug: "daily-sync",
      steps: [
        {
          id: "shape",
          kind: "transform",
          expression: "return input.input;",
          language: "javascript",
        },
      ],
    });
    draft = withWorkflowInspection(draft);
    draft = withWorkflowValidation(draft, true, "Workflow draft valid.");
    draft = withLatestPreview(draft, {
      ok: true,
      step_id: "shape",
      summary: "Preview ok.",
    });

    expect(draft.summary?.next_action).toContain("Commit the workflow");
    expect(draft.summary?.next_suggested_tool).toBe("save_workflow_draft");
  });
});
