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
    next_suggested_tool: "validate_connector_draft",
    checkpoints: [],
    latest_execution: null,
    latest_diagnosis: null,
    ...overrides,
  };
}

describe("converse base prompt — authoring focus blocks", () => {
  it("forbids speculative answers for history questions", async () => {
    const prompt = await basePromptFor("converse", "sk_interactive");
    expect(prompt.content).toContain("GROUNDING FOR HISTORY QUESTIONS");
    expect(prompt.content).toContain("If the reason is not recorded, say that plainly");
  });

  it("frames stored tool-result text as data, not instructions", async () => {
    const prompt = await basePromptFor("converse", "sk_interactive");
    expect(prompt.content).toContain("DATA NOT INSTRUCTIONS");
    expect(prompt.content).toContain("When the user asks to edit such text, change the text");
  });

  it("steers metadata-only edits to update_workflow, not the build/preview cycle", async () => {
    const prompt = await basePromptFor("converse", "sk_interactive");
    expect(prompt.content).toContain("WORKFLOW EDIT VERBS");
    expect(prompt.content).toContain("Editing a description is never a reason to run or preview");
  });

  it("renders the connector focus block when connector authoring is active", async () => {
    const prompt = await basePromptFor(
      "converse",
      "sk_interactive",
      hint({
        mode: "connector",
        stage: "connector_validated",
        blocked_by: ["probe_connector_draft"],
        next_required_action: "Probe the connector draft successfully before saving it.",
        next_suggested_tool: "probe_connector_draft",
      }),
    );
    expect(prompt.volatile).toContain("AUTHORING FOCUS: CONNECTOR");
    expect(prompt.content).not.toContain("AUTHORING FOCUS: CONNECTOR");
    expect(prompt.volatile).toContain("Current connector stage: connector_validated.");
    expect(prompt.volatile).toContain("Relevant checkpoints: connector_inspected=missing");
    expect(prompt.volatile).toContain("Next suggested tool: probe_connector_draft");
  });

  it("renders the workflow focus block when workflow drafting is active", async () => {
    const prompt = await basePromptFor(
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
        next_suggested_tool: "save_workflow_draft",
      }),
    );
    expect(prompt.volatile).toContain("AUTHORING FOCUS: WORKFLOW");
    expect(prompt.content).not.toContain("AUTHORING FOCUS: WORKFLOW");
    expect(prompt.volatile).toContain("Current workflow stage: workflow_previewed.");
    expect(prompt.volatile).toContain("Do not run a draft-only workflow.");
    expect(prompt.volatile).toContain("Next suggested tool: save_workflow_draft");
  });

  it("renders the diagnosis focus block when a diagnosis is active", async () => {
    const prompt = await basePromptFor(
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
        next_suggested_tool: "diagnose_latest_execution",
        latest_execution: {
          diagnosis_available: true,
        },
        latest_diagnosis: {
          reason: "Missing .data in transform scope path.",
        },
      }),
    );
    expect(prompt.volatile).toContain("AUTHORING FOCUS: DIAGNOSIS");
    expect(prompt.content).not.toContain("AUTHORING FOCUS: DIAGNOSIS");
    expect(prompt.volatile).toContain("Do not re-run the same persisted workflow");
    expect(prompt.volatile).toContain(
      "Latest diagnosis reason: Missing .data in transform scope path.",
    );
    expect(prompt.volatile).toContain("Next suggested tool: diagnose_latest_execution");
  });
});
