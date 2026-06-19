// Tests for the conversation loop's user-intent detector.
//
// Covers the specific failure modes from sessions ba4e8898 / f44bf9b4:
//   • "führe ... aus" must force run_workflow, not narrate
//   • a long narrative user message must NOT get hijacked
//   • "approve" alone resolves a pending envelope
//
// The loop layer wires these signals — tests here only exercise the
// pure classifier so failures are easy to pinpoint.

import { describe, expect, test } from "bun:test";
import {
  detectEnvelopeResolution,
  detectMultiArtifactIntent,
  detectUserIntent,
  inferStateDrivenFollowUpTool,
} from "./intent-detector.ts";
import type { AuthoringSummary } from "./types.ts";

describe("detectMultiArtifactIntent", () => {
  test("matches the canonical 'connector and a workflow' phrasing from session 1222158a", () => {
    expect(
      detectMultiArtifactIntent(
        "create a connector and a workflow to by weather api without api-key for tomorrow weather forecast in berlin germany",
      ),
    ).toBe(true);
  });

  test("matches the reverse order ('workflow ... and a connector')", () => {
    expect(detectMultiArtifactIntent("build a workflow and a connector for the GitHub API")).toBe(
      true,
    );
  });

  test("matches the German 'connector und einen workflow'", () => {
    expect(
      detectMultiArtifactIntent("erstelle einen connector und einen workflow für openweather"),
    ).toBe(true);
  });

  test("returns false when only one artifact is mentioned", () => {
    expect(detectMultiArtifactIntent("create a connector for github")).toBe(false);
    expect(detectMultiArtifactIntent("build me a workflow that hits the API")).toBe(false);
  });

  test("returns false on empty / nullish input", () => {
    expect(detectMultiArtifactIntent("")).toBe(false);
    expect(detectMultiArtifactIntent(null)).toBe(false);
    expect(detectMultiArtifactIntent(undefined)).toBe(false);
  });
});

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

describe("detectUserIntent", () => {
  test("recognizes German 'führe ... aus' as run intent", () => {
    const res = detectUserIntent("führe meine github workflow aus");
    expect(res.forceTool).toBe("run_workflow");
    expect(res.reason).toBe("explicit_run_intent");
  });

  test("recognizes 'run' verb + tool noun as run intent", () => {
    const res = detectUserIntent("please run this workflow");
    expect(res.forceTool).toBe("run_workflow");
  });

  test("recognizes bare 'ausführen' as run intent", () => {
    const res = detectUserIntent("ausführen");
    expect(res.forceTool).toBe("run_workflow");
  });

  test("recognizes 'welche workflows habe ich' as enumeration → force no-tools", () => {
    const res = detectUserIntent("welche workflows habe ich");
    expect(res.forceTool).toBeUndefined();
    expect(res.forceNoTools).toBe(true);
    expect(res.reason).toBe("enumeration_answer_from_snapshot");
  });

  test("recognizes 'zeige alle meine workflows' as enumeration → force no-tools", () => {
    const res = detectUserIntent("zeige alle meine workflows");
    expect(res.forceNoTools).toBe(true);
  });

  test("recognizes 'wieviele connectors habe ich' as enumeration → force no-tools", () => {
    const res = detectUserIntent("wieviele connectors habe ich");
    expect(res.forceNoTools).toBe(true);
  });

  test("'wieviele executions' is NOT enumeration — executions are not in the snapshot", () => {
    const res = detectUserIntent("wieviele executions gibt es?");
    expect(res.forceNoTools).toBeUndefined();
    expect(res.forceTool).toBeUndefined();
    expect(res.reason).toBe("no_strong_intent");
  });

  test("recognizes 'speichere den workflow' as commit intent", () => {
    const res = detectUserIntent("speichere den aktualisierten workflow");
    expect(res.forceTool).toBe("save_workflow_draft");
  });

  test("recognizes explicit new-workflow phrasing", () => {
    const res = detectUserIntent("create a workflow that gives me my private repos");
    expect(res.startNewWorkflow).toBe(true);
    expect(res.reason).toBe("explicit_new_workflow_intent");
  });

  test("returns no_strong_intent for ambiguous narrative", () => {
    const res = detectUserIntent(
      "ich glaube der Filter ist schon korrekt, vielleicht sollte ich nochmal schauen",
    );
    expect(res.forceTool).toBeUndefined();
    expect(res.reason).toBe("no_strong_intent");
  });

  test("returns no_user_text for null input", () => {
    expect(detectUserIntent(null).reason).toBe("no_user_text");
    expect(detectUserIntent(undefined).reason).toBe("no_user_text");
  });
});

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
  test("maps a short approval onto save_workflow_draft for a ready workflow draft in auto mode", () => {
    expect(
      inferStateDrivenFollowUpTool({
        latestUserText: "yes",
        permission_mode: "auto",
        summary: summary(),
      }),
    ).toBe("save_workflow_draft");
  });

  test("maps a short approval onto save_connector_draft for a ready connector draft in auto mode", () => {
    expect(
      inferStateDrivenFollowUpTool({
        latestUserText: "ja",
        permission_mode: "auto",
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

  test("does not force a follow-up tool outside auto mode", () => {
    expect(
      inferStateDrivenFollowUpTool({
        latestUserText: "yes",
        permission_mode: "ask",
        summary: summary(),
      }),
    ).toBeNull();
  });

  test("does not force a follow-up tool for non-save suggestions", () => {
    expect(
      inferStateDrivenFollowUpTool({
        latestUserText: "yes",
        permission_mode: "auto",
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
