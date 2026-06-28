// Unit tests for the authoring-intent detector — the seed for FIX 2 of
// the 6.0.3 hotfix. The detector decides whether the FIRST step of a
// conversation loop should run on Sonnet 4.6 (authoring-quality) or
// stick with the tenant default (Haiku 4.5 per 2026-05-22 cost
// change). Anything that lets a non-authoring phrase ("list my
// workflows") fall into the authoring branch costs the tenant in
// Sonnet tokens — the detector must stay narrow.

import { describe, expect, it } from "bun:test";
import {
  AUTHORING_INITIAL_MODEL,
  detectAuthoringIntent,
  resolveInitialModel,
} from "./authoring-intent.ts";

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
});

describe("AUTHORING_INITIAL_MODEL constant", () => {
  it("seeds Opus 4.8 (the ladder top)", () => {
    // Hard-wired here so a future rename surfaces as a failing test
    // instead of a silent drift. Raised Sonnet 4.6 → Opus 4.7 → Opus 4.8:
    // Sonnet-seeded authoring turns mis-selected run_workflow, and the
    // ladder now tops out at opus-4-8 so the seed sits at the top tier.
    expect(AUTHORING_INITIAL_MODEL).toBe("claude-opus-4-8");
  });
});

// 6.0.3 hotfix — FIX 2 loop-seeding test. Verifies the precedence
// order documented on `resolveInitialModel`:
//   override > authoring-intent seed > tenant default.
// The tenant default here is `claude-haiku-4-5` to mirror the
// production engine config (memory: project_engine_llm_default_haiku,
// set 2026-05-22 for cost). An authoring turn must not run on Haiku;
// a list/run/delete turn must.
describe("resolveInitialModel — FIX 2 loop seeding", () => {
  const tenantDefault = "claude-haiku-4-5";

  it("seeds the authoring model when initial_message expresses authoring intent", () => {
    const decision = resolveInitialModel({
      modelOverride: null,
      tenantDefault,
      recentUserMessage: "build a workflow called daily-report",
    });
    expect(decision.modelId).toBe("claude-opus-4-8");
    expect(decision.authoringSeeded).toBe(true);
  });

  it("seeds the authoring model for the German equivalent", () => {
    const decision = resolveInitialModel({
      modelOverride: null,
      tenantDefault,
      recentUserMessage: "erstelle einen workflow für den Tagesbericht",
    });
    expect(decision.modelId).toBe("claude-opus-4-8");
    expect(decision.authoringSeeded).toBe(true);
  });

  it("uses the tenant default (Haiku) for 'list my workflows'", () => {
    const decision = resolveInitialModel({
      modelOverride: null,
      tenantDefault,
      recentUserMessage: "list my workflows",
    });
    expect(decision.modelId).toBe(tenantDefault);
    expect(decision.authoringSeeded).toBe(false);
  });

  it("uses the tenant default for 'run workflow X'", () => {
    const decision = resolveInitialModel({
      modelOverride: null,
      tenantDefault,
      recentUserMessage: "run workflow X",
    });
    expect(decision.modelId).toBe(tenantDefault);
    expect(decision.authoringSeeded).toBe(false);
  });

  it("uses the tenant default for 'delete the workflow'", () => {
    const decision = resolveInitialModel({
      modelOverride: null,
      tenantDefault,
      recentUserMessage: "delete the workflow",
    });
    expect(decision.modelId).toBe(tenantDefault);
    expect(decision.authoringSeeded).toBe(false);
  });

  it("uses the tenant default when there is no user message (e.g. elicitation continuation)", () => {
    const decision = resolveInitialModel({
      modelOverride: null,
      tenantDefault,
      recentUserMessage: null,
    });
    expect(decision.modelId).toBe(tenantDefault);
    expect(decision.authoringSeeded).toBe(false);
  });

  it("explicit modelOverride wins over authoring intent (operator pick is sacred)", () => {
    const decision = resolveInitialModel({
      modelOverride: "claude-opus-4-7",
      tenantDefault,
      recentUserMessage: "build a workflow called X",
    });
    expect(decision.modelId).toBe("claude-opus-4-7");
    expect(decision.authoringSeeded).toBe(false);
  });

  it("explicit modelOverride wins even when it equals the tenant default", () => {
    const decision = resolveInitialModel({
      modelOverride: tenantDefault,
      tenantDefault,
      recentUserMessage: "build a workflow called X",
    });
    expect(decision.modelId).toBe(tenantDefault);
    expect(decision.authoringSeeded).toBe(false);
  });
});
