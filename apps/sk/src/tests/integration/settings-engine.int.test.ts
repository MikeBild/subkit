// Settings UI ↔ engine integration via the draft store.
//
// Verifies the survival contract: a partial draft persists across
// SettingsApp open/close cycles within a session, scoped per
// (profile, tenant). No live engine call needed — this exercises the
// draft store directly, since SettingsApp doesn't expose its internal
// state on unmount yet.

import { afterEach, beforeEach, describe, expect, test } from "bun:test";

import {
  _resetDraftStoreForTests,
  loadDraft,
  saveDraft,
} from "../../settings-ui/lib/draft-store.ts";

beforeEach(() => _resetDraftStoreForTests());
afterEach(() => _resetDraftStoreForTests());

describe("integration: settings draft survives close+reopen", () => {
  test("partial edits round-trip across simulated open cycles", () => {
    saveDraft("admin", "t-x", {
      partialFieldEdits: { "model.default": "claude-haiku" },
      scrollTop: 12,
      expandedKeys: ["model"],
    });
    // Simulate a close+reopen cycle.
    const snap1 = loadDraft("admin", "t-x");
    expect(snap1.partialFieldEdits["model.default"]).toBe("claude-haiku");
    expect(snap1.scrollTop).toBe(12);
    expect(snap1.expandedKeys).toEqual(["model"]);
    const snap2 = loadDraft("admin", "t-x");
    expect(snap2).toEqual(snap1);
  });

  test("draft is keyed per (profile, tenant) — no cross-bleed", () => {
    saveDraft("admin", "t-1", { partialFieldEdits: { foo: 1 }, scrollTop: 0, expandedKeys: [] });
    saveDraft("admin", "t-2", { partialFieldEdits: { foo: 2 }, scrollTop: 0, expandedKeys: [] });
    saveDraft("user", "t-1", { partialFieldEdits: { foo: 3 }, scrollTop: 0, expandedKeys: [] });
    expect(loadDraft("admin", "t-1").partialFieldEdits.foo).toBe(1);
    expect(loadDraft("admin", "t-2").partialFieldEdits.foo).toBe(2);
    expect(loadDraft("user", "t-1").partialFieldEdits.foo).toBe(3);
  });

  test("loaded snapshot is defensively copied (mutating it doesn't leak back)", () => {
    saveDraft("p", "t", { partialFieldEdits: { a: "x" }, scrollTop: 0, expandedKeys: ["k"] });
    const snap = loadDraft("p", "t");
    snap.partialFieldEdits.a = "y";
    snap.expandedKeys.push("z");
    expect(loadDraft("p", "t").partialFieldEdits.a).toBe("x");
    expect(loadDraft("p", "t").expandedKeys).toEqual(["k"]);
  });
});
