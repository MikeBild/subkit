import { describe, expect, test } from "bun:test";
import { translate } from "./i18n";
import {
  humaniseToolName,
  isStaleCall,
  STALE_AFTER_MS,
  toolLabel,
  toolOutcomeKey,
  toolTier,
  workflowSlugFromTool,
} from "./tool-presentation";

describe("toolLabel", () => {
  test("passes a saved workflow's own name through instead of mangling it", () => {
    // The slug is a name a person chose. Humanising it would render
    // `ga4-daily-report` as "Ga4 Daily Report" — a mangling of a name rather
    // than the name.
    expect(toolLabel("wf_ga4-daily-report")).toEqual({
      kind: "workflow",
      slug: "ga4-daily-report",
    });
  });

  test("names a registered read and a registered action from the catalog", () => {
    expect(toolLabel("list_workflows")).toEqual({
      kind: "background",
      words: {
        active: "tool.background.listWorkflows.active",
        past: "tool.background.listWorkflows.past",
      },
    });
    expect(toolLabel("run_workflow")).toEqual({ kind: "key", key: "tool.name.runWorkflow" });
  });

  test("falls back to a readable literal for a name nobody registered", () => {
    expect(toolLabel("some_future_tool")).toEqual({
      kind: "literal",
      text: "Some Future Tool",
    });
  });
});

describe("humaniseToolName", () => {
  test("drops a trailing version so the name describes the action, not our versioning", () => {
    expect(humaniseToolName("search_knowledge_v2")).toBe("Search Knowledge");
  });

  test("keeps a version-looking word that is part of the name", () => {
    expect(humaniseToolName("get_v2_report")).toBe("Get V2 Report");
  });
});

describe("toolTier", () => {
  test("a read is background, a run is an action", () => {
    expect(toolTier("list_workflows")).toBe("background");
    expect(toolTier("run_workflow")).toBe("action");
  });

  test("an unknown action gets a card — over-showing beats hiding", () => {
    expect(toolTier("some_future_tool")).toBe("action");
  });

  test("a versioned name is the same action, not an unregistered one", () => {
    // `search_knowledge_v2` fell out of the registry and got a card of its own,
    // which is exactly the noise the two tiers exist to remove.
    expect(toolTier("search_knowledge_v2")).toBe("background");
    expect(toolLabel("search_knowledge_v2")).toEqual({
      kind: "background",
      words: {
        active: "tool.background.searchKnowledge.active",
        past: "tool.background.searchKnowledge.past",
      },
    });
  });

  test("a saved workflow is always an action, never a background line", () => {
    expect(toolTier("wf_ga4-daily-report")).toBe("action");
  });
});

describe("workflowSlugFromTool", () => {
  test("returns null for a bare prefix and for a normal tool", () => {
    expect(workflowSlugFromTool("wf_")).toBeNull();
    expect(workflowSlugFromTool("run_workflow")).toBeNull();
  });
});

describe("toolOutcomeKey", () => {
  test("a human decision outranks the machine result", () => {
    // Someone who declined a call cares that they declined it, not that the
    // engine then reported nothing ran.
    expect(toolOutcomeKey({ confirmationState: "declined", outcome: "error" })).toBe(
      "tool.outcome.declined",
    );
  });

  test("a lost call reads as unfinished regardless of what else is set", () => {
    expect(toolOutcomeKey({ confirmationState: "confirmed", outcome: "ok", stale: true })).toBe(
      "tool.outcome.didNotComplete",
    );
  });

  test("falls through to the part's own state when the engine recorded neither", () => {
    expect(toolOutcomeKey({ confirmationState: null, outcome: null })).toBeNull();
  });

  test("every word it can return exists in both catalogs", () => {
    const states = [
      "proposed",
      "tested",
      "confirmed",
      "partial",
      "declined",
      "auto_declined",
      "oauth_success",
      "oauth_failure",
    ];
    const outcomes = ["ok", "error", "denied", "pending"];
    for (const confirmationState of states) {
      const key = toolOutcomeKey({ confirmationState });
      expect(key).not.toBeNull();
      if (!key) continue;
      for (const locale of ["en", "de"] as const) expect(translate(locale, key)).toBeTruthy();
    }
    for (const outcome of outcomes) {
      const key = toolOutcomeKey({ outcome });
      expect(key).not.toBeNull();
      if (!key) continue;
      for (const locale of ["en", "de"] as const) expect(translate(locale, key)).toBeTruthy();
    }
  });
});

describe("isStaleCall", () => {
  const now = Date.parse("2026-08-18T12:00:00.000Z");

  test("a call with no result older than the window is presumed lost", () => {
    const old = new Date(now - STALE_AFTER_MS - 1000).toISOString();
    expect(isStaleCall({ messageCreatedAt: old, hasResult: false, isStreaming: false, now })).toBe(
      true,
    );
  });

  test("a live turn is never stale, however long it has been running", () => {
    const old = new Date(now - STALE_AFTER_MS * 10).toISOString();
    expect(isStaleCall({ messageCreatedAt: old, hasResult: false, isStreaming: true, now })).toBe(
      false,
    );
  });

  test("a finished call is never stale", () => {
    const old = new Date(now - STALE_AFTER_MS * 10).toISOString();
    expect(isStaleCall({ messageCreatedAt: old, hasResult: true, isStreaming: false, now })).toBe(
      false,
    );
  });

  test("an unreadable or missing timestamp does not accuse a call of being lost", () => {
    expect(
      isStaleCall({ messageCreatedAt: "not a date", hasResult: false, isStreaming: false, now }),
    ).toBe(false);
    expect(isStaleCall({ messageCreatedAt: null, hasResult: false, isStreaming: false, now })).toBe(
      false,
    );
  });
});
