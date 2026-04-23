import { describe, expect, it } from "bun:test";
import type { AuthoringPromptHint } from "../../types.ts";
import { basePromptFor } from "../context-assembler.ts";

function hint(overrides: Partial<AuthoringPromptHint>): AuthoringPromptHint {
  return {
    mode: "connector",
    stage: "connector_draft_started",
    lifecycle_state: "draft_only",
    active_target: {
      kind: "connector",
      lifecycle_state: "draft_only",
    },
    blocked_by: ["inspect_connector_draft", "validate_connector_draft"],
    next_required_action: "Validate the connector draft again before saving.",
    checkpoints: [],
    latest_execution: null,
    latest_diagnosis: null,
    ...overrides,
  };
}

describe("converse base prompt — authoring focus blocks", () => {
  it("renders the connector focus block when connector authoring is active", () => {
    const prompt = basePromptFor(
      "converse",
      "sk_interactive",
      hint({
        mode: "connector",
        stage: "connector_validated",
        blocked_by: ["probe_connector_draft"],
        next_required_action: "Probe the connector draft successfully before saving it.",
      }),
    );
    expect(prompt).toContain("AUTHORING FOCUS: CONNECTOR");
    expect(prompt).toContain("Current connector stage: connector_validated.");
    expect(prompt).toContain("Relevant checkpoints: connector_inspected=missing");
  });

  it("renders the workflow focus block when workflow drafting is active", () => {
    const prompt = basePromptFor(
      "converse",
      "sk_interactive",
      hint({
        mode: "workflow",
        stage: "workflow_previewed",
        lifecycle_state: "draft_only",
        active_target: {
          kind: "workflow",
          lifecycle_state: "draft_only",
        },
        blocked_by: [],
        next_required_action:
          "Commit the workflow now that inspection, validation, and preview are fresh.",
      }),
    );
    expect(prompt).toContain("AUTHORING FOCUS: WORKFLOW");
    expect(prompt).toContain("Current workflow stage: workflow_previewed.");
    expect(prompt).toContain("Do not run a draft-only workflow.");
  });

  it("renders the diagnosis focus block when a diagnosis is active", () => {
    const prompt = basePromptFor(
      "converse",
      "sk_interactive",
      hint({
        mode: "diagnosis",
        stage: "diagnosing",
        lifecycle_state: "persisted",
        active_target: {
          kind: "workflow",
          lifecycle_state: "persisted",
        },
        blocked_by: ["diagnose_latest_execution"],
        next_required_action:
          "Edit the workflow based on the diagnosis, then preview and re-run it.",
        latest_execution: {
          diagnosis_available: true,
        },
        latest_diagnosis: {
          reason: "Missing .data in transform scope path.",
        },
      }),
    );
    expect(prompt).toContain("AUTHORING FOCUS: DIAGNOSIS");
    expect(prompt).toContain("Do not re-run the same persisted workflow");
    expect(prompt).toContain("Latest diagnosis reason: Missing .data in transform scope path.");
  });
});
