// Unit tests for the authoring-intent detector — the single source of
// truth for "the user wants to author a new workflow" pattern matching,
// consumed by `conversations/intent-detector.ts` for its
// `startNewWorkflow` signal.
//
// This detector no longer picks a model. It used to: a match seeded the
// whole turn on a hard-coded top-tier literal, overriding the configured
// `llm.model`. That is gone — see the file header of
// `authoring-intent.ts`. What survives here is the narrowness the
// detector always needed, now for a different reason: a false positive
// resets an authoring target rather than inflating a bill.

import { describe, expect, it } from "bun:test";
import { detectAuthoringIntent } from "./authoring-intent.ts";

describe("detectAuthoringIntent — authoring phrases", () => {
  it("matches 'build a workflow'", () => {
    expect(detectAuthoringIntent("build a workflow that fetches Stripe customers")).toBe(true);
  });

  it("matches 'create a workflow'", () => {
    expect(detectAuthoringIntent("create a workflow called daily-report")).toBe(true);
  });

  it("matches 'create workflow' (no article)", () => {
    expect(detectAuthoringIntent("create workflow for HubSpot sync")).toBe(true);
  });

  it("matches 'erstelle einen workflow' (German)", () => {
    expect(detectAuthoringIntent("erstelle einen workflow für den Tagesbericht")).toBe(true);
  });

  it("matches 'baue mir einen workflow' (German)", () => {
    expect(detectAuthoringIntent("baue mir einen workflow der Stripe daten holt")).toBe(true);
  });

  it("matches 'generate a workflow'", () => {
    expect(detectAuthoringIntent("generate a workflow that runs every morning")).toBe(true);
  });

  it("matches 'design a workflow'", () => {
    expect(detectAuthoringIntent("design a workflow with three steps")).toBe(true);
  });

  it("matches 'author a new workflow'", () => {
    expect(detectAuthoringIntent("author a new workflow for the team")).toBe(true);
  });

  it("matches noun-first phrasing", () => {
    expect(detectAuthoringIntent("a workflow I'd like to build")).toBe(true);
  });

  it("matches mixed case", () => {
    expect(detectAuthoringIntent("BUILD a Workflow Called X")).toBe(true);
  });

  it("matches 'erzeuge einen workflow'", () => {
    expect(detectAuthoringIntent("erzeuge einen workflow der täglich läuft")).toBe(true);
  });
});

describe("detectAuthoringIntent — non-authoring phrases", () => {
  it("does NOT match 'list my workflows'", () => {
    expect(detectAuthoringIntent("list my workflows")).toBe(false);
  });

  it("does NOT match 'show me all workflows'", () => {
    expect(detectAuthoringIntent("show me all workflows")).toBe(false);
  });

  it("does NOT match 'run workflow X'", () => {
    expect(detectAuthoringIntent("run workflow X")).toBe(false);
  });

  it("does NOT match 'delete the workflow'", () => {
    expect(detectAuthoringIntent("delete the workflow")).toBe(false);
  });

  it("does NOT match 'inspect this workflow'", () => {
    expect(detectAuthoringIntent("inspect this workflow")).toBe(false);
  });

  it("does NOT match 'what workflows do I have'", () => {
    expect(detectAuthoringIntent("what workflows do I have")).toBe(false);
  });

  it("does NOT match an empty string", () => {
    expect(detectAuthoringIntent("")).toBe(false);
  });

  it("does NOT match whitespace only", () => {
    expect(detectAuthoringIntent("   \n\t  ")).toBe(false);
  });

  it("does NOT match null", () => {
    expect(detectAuthoringIntent(null)).toBe(false);
  });

  it("does NOT match undefined", () => {
    expect(detectAuthoringIntent(undefined)).toBe(false);
  });

  it("does NOT match a verb without the workflow noun", () => {
    expect(detectAuthoringIntent("build a connector for HubSpot")).toBe(false);
  });

  it("does NOT match the noun without an authoring verb", () => {
    expect(detectAuthoringIntent("my workflow")).toBe(false);
  });

  it("does NOT match 'I want to run the workflow tomorrow'", () => {
    // "run" is not in the authoring-verb set
    expect(detectAuthoringIntent("I want to run the workflow tomorrow")).toBe(false);
  });

  // SHOULD-FIX 3 (6.0.3 review) — proximity-window + connector-object
  // reject. The previous 40-char window matched enumeration phrases
  // like "list my workflows that build X" because "workflows" precedes
  // "build" within 40 characters. The new 20-char window misses these.
  // Independently, when the authoring verb's object is a CONNECTOR
  // (before the workflow noun) the match must reject — the user wants
  // to build a connector for an existing workflow, not author a new
  // workflow.

  it("does NOT match 'list my workflows that build X' (enumeration phrase)", () => {
    // "workflows" precedes "build" with > 20 chars of intervening
    // tokens; the noun→verb window misses, and the verb→noun direction
    // does not fire because "build" comes after "workflows".
    expect(detectAuthoringIntent("list my workflows that build X")).toBe(false);
  });

  it("does NOT match 'search workflows that build invoices'", () => {
    expect(detectAuthoringIntent("search workflows that build invoices")).toBe(false);
  });

  it("does NOT match 'build a connector for the daily-report workflow'", () => {
    // The verb's object is a connector noun, so even though "workflow"
    // appears within the window the connector-object reject fires.
    expect(detectAuthoringIntent("build a connector for the daily-report workflow")).toBe(false);
  });

  it("does NOT match 'create a new connector that feeds the invoices workflow'", () => {
    expect(detectAuthoringIntent("create a new connector that feeds the invoices workflow")).toBe(
      false,
    );
  });

  it("does NOT match 'erstelle einen connector für den workflow'", () => {
    expect(detectAuthoringIntent("erstelle einen connector für den workflow")).toBe(false);
  });

  it("does not bridge a workflow noun and creation verb across sentence boundaries", () => {
    expect(
      detectAuthoringIntent(
        "Bearbeite den bestehenden Workflow als neue persistierte Workflow-Version. Erzeuge ausdrücklich keinen neuen Workflow.",
      ),
    ).toBe(false);
  });
});
