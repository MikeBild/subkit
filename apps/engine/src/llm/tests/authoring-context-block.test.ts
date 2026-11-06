import { describe, expect, test } from "bun:test";
import {
  createEmptyDraftDocument,
  withConnectorDraft,
  withWorkflowDiagnosis,
  withWorkflowDraft,
  withWorkflowExecution,
  withWorkflowPersisted,
} from "../../conversations/authoring-state/index.ts";
import type { DraftDocument } from "../../conversations/types.ts";
import { renderAuthoringContextBlock } from "../core/authoring-context-block.ts";

function draft(overrides: Partial<DraftDocument> = {}): DraftDocument {
  return {
    workflow: { name: "new-workflow", steps: [] },
    ...overrides,
  } as DraftDocument;
}

describe("renderAuthoringContextBlock", () => {
  test("returns null when there is nothing to render", () => {
    expect(renderAuthoringContextBlock({ draft: null })).toBeNull();
  });

  test("renders mode and readiness when present", () => {
    const currentDraft = withConnectorDraft(createEmptyDraftDocument(), {
      name: "Acme",
      slug: "acme",
      driver: "http",
      environment: "dev",
      auth_type: "bearer",
    });
    const block = renderAuthoringContextBlock({
      draft: currentDraft,
    });
    expect(block).not.toBeNull();
    expect(block!).toContain("Mode: connector_authoring");
    expect(block!).toContain("Surface mode: connector");
    expect(block!).toContain("Stage: connector_draft_started");
    expect(block!).toContain("Lifecycle: draft_only");
    expect(block!).toContain("Readiness: needs_input");
    expect(block!).toContain('Active target: kind=connector name="Acme" slug=acme env=dev');
    expect(block!).toContain("Next recommended action");
    expect(block!).toContain("Missing: base_url");
    expect(block!).toContain("Blocked by: missing:base_url");
    expect(block!).toContain("Checkpoints: connector_inspected=missing");
  });

  test("renders connector fields without leaking secrets", () => {
    const block = renderAuthoringContextBlock({
      draft: draft({
        mode: "connector_authoring",
        connector: {
          name: "Acme",
          slug: "acme",
          driver: "http",
          environment: "dev",
          auth_type: "bearer",
          base_url: "https://api.example.com",
          dsn: "postgres://user:pass@host/db",
          config: { secret_token: "hunter2" },
        },
      }),
    });
    expect(block).not.toBeNull();
    expect(block!).toContain("Acme");
    expect(block!).toContain("driver=http");
    expect(block!).toContain("base_url=https://api.example.com");
    expect(block!).not.toContain("hunter2");
    expect(block!).not.toContain("postgres://");
  });

  test("renders step summary for workflow drafts", () => {
    const steps = Array.from({ length: 8 }, (_, i) => ({
      id: `s${i + 1}`,
      kind: i % 2 === 0 ? "request" : "transform",
    }));
    const block = renderAuthoringContextBlock({
      draft: draft({
        mode: "workflow_authoring",
        workflow: { name: "my-flow", steps },
      }),
    });
    expect(block).not.toBeNull();
    expect(block!).toContain('Workflow draft: "my-flow"');
    expect(block!).toContain("with 8 steps");
    expect(block!).toContain("s1: request");
    expect(block!).toContain("and 2 more");
    expect(block!).not.toContain("s7:");
  });

  test("renders execution and diagnosis summaries when present", () => {
    let currentDraft = withWorkflowDraft(createEmptyDraftDocument(), {
      name: "my-flow",
      slug: "my-flow",
      steps: [{ id: "s1", kind: "request" }],
    });
    currentDraft = withWorkflowPersisted(currentDraft, {
      kind: "workflow",
      id: "workflow_123",
      slug: "my-flow",
      name: "my-flow",
      version_id: "version_1",
      version: 1,
      environment: "dev",
      saved_at: "2026-04-23T10:00:00.000Z",
    });
    currentDraft = withWorkflowExecution(currentDraft, {
      execution_id: "exec_123",
      workflow_id: "workflow_123",
      workflow_version_id: "version_1",
      status: "succeeded",
      environment: "dev",
      warnings_count: 2,
      recorded_at: "2026-04-23T10:05:00.000Z",
      diagnosis_available: true,
    });
    currentDraft = withWorkflowDiagnosis(currentDraft, {
      execution_id: "exec_123",
      recorded_at: "2026-04-23T10:06:00.000Z",
      reason: "Missing .data in transform scope path.",
      warning_sources: [],
      steps: [],
    });
    const block = renderAuthoringContextBlock({
      draft: currentDraft,
    });
    expect(block).not.toBeNull();
    expect(block!).toContain("Surface mode: diagnosis");
    expect(block!).toContain("Stage: diagnosing");
    expect(block!).toContain("Persisted resources: workflow:workflow_123@v1@dev");
    expect(block!).toContain(
      "Latest execution: status=succeeded env=dev warnings=2 diagnosis_available=true",
    );
    expect(block!).toContain("Latest diagnosis: Missing .data in transform scope path.");
    expect(block!).toContain("This run: execution exec_123 of workflow");
  });

  test("includes a guided-next-step section", () => {
    const block = renderAuthoringContextBlock({
      draft: draft({
        mode: "connector_authoring",
        connector: { name: "X", driver: "http", auth_type: "none" },
      }),
    });
    expect(block).not.toBeNull();
    expect(block!).toContain("## Guided next step");
    expect(block!).toContain("Action:");
    expect(block!).toContain("Why:");
  });

  test("includes turn routing guidance for non-authoring requests", () => {
    const block = renderAuthoringContextBlock({
      draft: draft(),
      user_message: "archive new-workflow",
    });
    expect(block).not.toBeNull();
    expect(block!).toContain("## Turn routing");
    expect(block!).toContain("Intent: unsupported_or_unavailable");
    expect(block!).toContain("delete_workflow");
    expect(block!).toContain("Forbidden fallbacks");
    expect(block!).not.toContain("## Guided next step");
  });
});

describe("renderAuthoringContextBlock · consistency warnings", () => {
  test("the authoring context lists warnings with their rule_id only when there are some", () => {
    const draft = {
      workflow: {
        name: "Ops daily digest",
        slug: "ops-daily-digest",
        steps: [{ id: "shape", kind: "transform", expression: "return 1;" }],
      },
    } as unknown as DraftDocument;
    const clean = renderAuthoringContextBlock({
      draft,
      user_message: "",
      workflow_validation: { ok: true, errors: [], warnings: [] },
    });
    expect(clean).not.toContain("Consistency warnings");
    const flagged = renderAuthoringContextBlock({
      draft,
      user_message: "",
      workflow_validation: {
        ok: true,
        errors: [],
        warnings: [{ path: "slug", rule_id: "slug-prefix", message: "slug breaks the prefix" }],
      },
    });
    expect(flagged).toContain("- Validation: ok (0 errors)");
    expect(flagged).toContain("- Consistency warnings: 1 (not blocking");
    expect(flagged).toContain("[slug-prefix] slug: slug breaks the prefix");
  });
});
