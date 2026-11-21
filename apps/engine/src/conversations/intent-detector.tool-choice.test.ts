import { describe, expect, test } from "bun:test";
import {
  detectEnvelopeResolution,
  detectUserIntent,
  inferStateDrivenFollowUpTool,
  resolvePreferredTool,
  turnToolChoice,
} from "./intent-detector.ts";
import type { AuthoringSummary } from "./types.ts";

function summary(overrides: Partial<AuthoringSummary> = {}): AuthoringSummary {
  return {
    readiness: "ready_to_save",
    next_action: "Commit the workflow now that inspection, validation, and preview are fresh.",
    next_required_action:
      "Commit the workflow now that inspection, validation, and preview are fresh.",
    next_suggested_tool: "save_workflow_draft",
    missing_fields: [],
    last_action: null,
    progress_label: "1 workflow step",
    mode: "workflow",
    stage: "workflow_previewed",
    lifecycle_state: "draft_only",
    active_target: {
      kind: "workflow",
      name: "ready-flow",
      slug: "ready-flow",
      id: null,
      environment: null,
      lifecycle_state: "draft_only",
    },
    blocked_by: [],
    checkpoints: [],
    persisted_resources: [],
    latest_execution: null,
    latest_diagnosis: null,
    ...overrides,
  };
}

describe("detectEnvelopeResolution", () => {
  test("resolves 'approve' to approve", () => {
    expect(detectEnvelopeResolution("approve")).toBe("approve");
    expect(detectEnvelopeResolution("ok")).toBe("approve");
    expect(detectEnvelopeResolution("ja")).toBe("approve");
    expect(detectEnvelopeResolution("yes")).toBe("approve");
    expect(detectEnvelopeResolution("bestätige")).toBe("approve");
  });

  test("resolves 'reject' to reject", () => {
    expect(detectEnvelopeResolution("reject")).toBe("reject");
    expect(detectEnvelopeResolution("nein")).toBe("reject");
    expect(detectEnvelopeResolution("cancel")).toBe("reject");
    expect(detectEnvelopeResolution("abbrechen")).toBe("reject");
  });

  test("ignores long messages (not a one-word ack)", () => {
    expect(
      detectEnvelopeResolution(
        "ja aber bevor du das ausführst solltest du noch überlegen ob das korrekt ist",
      ),
    ).toBeNull();
  });

  test("ignores unrelated text", () => {
    expect(detectEnvelopeResolution("was ist der status?")).toBeNull();
    expect(detectEnvelopeResolution("zeige mir details")).toBeNull();
  });

  test("handles null / empty input", () => {
    expect(detectEnvelopeResolution(null)).toBeNull();
    expect(detectEnvelopeResolution("")).toBeNull();
    expect(detectEnvelopeResolution("   ")).toBeNull();
  });
});

describe("inferStateDrivenFollowUpTool", () => {
  test("maps a short approval onto save_workflow_draft for a ready workflow draft ", () => {
    expect(
      inferStateDrivenFollowUpTool({
        latestUserText: "yes",
        ask_before_writing: false,
        summary: summary(),
      }),
    ).toBe("save_workflow_draft");
  });

  test("maps a short approval onto save_connector_draft for a ready connector draft ", () => {
    expect(
      inferStateDrivenFollowUpTool({
        latestUserText: "ja",
        ask_before_writing: false,
        summary: summary({
          mode: "connector",
          stage: "connector_probed",
          next_action: "Save the connector now that inspection, validation, and probe are fresh.",
          next_required_action:
            "Save the connector now that inspection, validation, and probe are fresh.",
          next_suggested_tool: "save_connector_draft",
          active_target: {
            kind: "connector",
            name: "Acme API",
            slug: "acme-api",
            id: null,
            environment: "dev",
            lifecycle_state: "draft_only",
          },
        }),
      }),
    ).toBe("save_connector_draft");
  });

  test("does not force a follow-up tool when the person asks before writing", () => {
    expect(
      inferStateDrivenFollowUpTool({
        latestUserText: "yes",
        ask_before_writing: true,
        summary: summary(),
      }),
    ).toBeNull();
  });

  test("does not force a follow-up tool for non-save suggestions", () => {
    expect(
      inferStateDrivenFollowUpTool({
        latestUserText: "yes",
        ask_before_writing: false,
        summary: summary({
          lifecycle_state: "persisted",
          stage: "workflow_persisted",
          next_action: "Run the saved workflow to verify the persisted version.",
          next_required_action: "Run the saved workflow to verify the persisted version.",
          next_suggested_tool: "run_workflow",
          active_target: {
            kind: "workflow",
            name: "ready-flow",
            slug: "ready-flow",
            id: "wf_123",
            environment: null,
            lifecycle_state: "persisted",
          },
        }),
      }),
    ).toBeNull();
  });
});

describe("the turn's first-step tool choice", () => {
  const palette = (names: string[]) => (name: string) => names.includes(name);

  test("forces the detected tool when the palette carries it", () => {
    const tool = resolvePreferredTool(
      { forceTool: "list_workflows" },
      null,
      palette(["list_workflows"]),
    );
    expect(turnToolChoice(tool, false)).toEqual({ type: "tool", toolName: "list_workflows" });
  });

  test("a palette without list_workflows falls back to auto", () => {
    const tool = resolvePreferredTool(
      { forceTool: "list_workflows" },
      null,
      palette(["run_workflow"]),
    );
    expect(tool).toBeNull();
    expect(turnToolChoice(tool, false)).toBe("auto");
  });

  test("the state-driven follow-up only when the palette carries it", () => {
    expect(resolvePreferredTool({}, "save_workflow_draft", palette(["save_workflow_draft"]))).toBe(
      "save_workflow_draft",
    );
    expect(resolvePreferredTool({}, "save_workflow_draft", palette([]))).toBeNull();
  });

  test("an answer-from-snapshot turn withholds tools", () => {
    expect(turnToolChoice(null, true)).toBe("none");
  });
});

const PREPARE_WITHOUT_LIVE_EFFECTS =
  "Bereite diesen Ablauf für den automatischen Betrieb vor. Nicht aktivieren, keine Live-Wirkungen freigeben oder ausführen. Erlaubte Prüfungen selbst übernehmen; bei fehlender fachlicher Entscheidung kurze Frage mit Auswahl und Empfehlung.";

describe("live-effect suppression", () => {
  test("a no-activation, no-live-effects preparation suppresses only live execution", () => {
    const res = detectUserIntent(PREPARE_WITHOUT_LIVE_EFFECTS);
    expect(res.suppressLiveExecution).toBe(true);
    expect(res.suppressExecution).toBeUndefined();
    expect(res.forceTool).toBeUndefined();
  });

  test.each([
    "Bitte keinen Testlauf starten.",
    "Kein Probelauf, nur den Entwurf prüfen.",
    "No dry run please, just review the draft.",
    "Den Workflow bitte nicht testen.",
  ])("an explicit no-test instruction suppresses previews too: %s", (message) => {
    const res = detectUserIntent(message);
    expect(res.suppressExecution).toBe(true);
    expect(res.suppressLiveExecution).toBe(true);
  });

  test.each([
    "Do not activate it and no live effects.",
    "Nichts live auslösen, nur vorbereiten.",
    "Aktiviere den Workflow nicht.",
  ])("live-effect negations suppress live execution: %s", (message) => {
    expect(detectUserIntent(message)).toMatchObject({ suppressLiveExecution: true });
    expect(detectUserIntent(message).suppressExecution).toBeUndefined();
  });

  test("a question about activation is no instruction", () => {
    expect(
      detectUserIntent("Warum kann ich den Workflow nicht aktivieren?").suppressLiveExecution,
    ).toBeUndefined();
  });

  test("a plain run request suppresses nothing", () => {
    const res = detectUserIntent("Run the workflow");
    expect(res.suppressExecution).toBeUndefined();
    expect(res.suppressLiveExecution).toBeUndefined();
  });

  test("an explicit no-run instruction implies live suppression", () => {
    expect(detectUserIntent("Den Workflow nicht ausführen, sondern nur validieren.")).toMatchObject(
      { suppressExecution: true, suppressLiveExecution: true, reason: "explicit_no_run_intent" },
    );
  });
});
