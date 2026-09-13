import { afterEach, beforeEach, describe, expect, test } from "bun:test";

import {
  _resetDraftStoreForTests,
  clearDraft,
  loadDraft,
  saveDraft,
} from "../settings-ui/lib/draft-store.ts";

beforeEach(() => _resetDraftStoreForTests());
afterEach(() => _resetDraftStoreForTests());

describe("settings draft store", () => {
  test("loadDraft returns empty defaults when nothing has been saved", () => {
    const snap = loadDraft("default", "t-abc");
    expect(snap.scrollTop).toBe(0);
    expect(snap.expandedKeys).toEqual([]);
    expect(snap.partialFieldEdits).toEqual({});
  });

  test("saveDraft + loadDraft round-trip preserves every field", () => {
    saveDraft("default", "t-abc", {
      partialFieldEdits: { "model.default": "claude-haiku" },
      scrollTop: 42,
      expandedKeys: ["model", "providers"],
    });
    const snap = loadDraft("default", "t-abc");
    expect(snap.partialFieldEdits).toEqual({ "model.default": "claude-haiku" });
    expect(snap.scrollTop).toBe(42);
    expect(snap.expandedKeys).toEqual(["model", "providers"]);
  });

  test("drafts are scoped per (profile, tenant)", () => {
    saveDraft("admin", "t-1", {
      partialFieldEdits: { foo: 1 },
      scrollTop: 0,
      expandedKeys: [],
    });
    saveDraft("admin", "t-2", {
      partialFieldEdits: { foo: 2 },
      scrollTop: 0,
      expandedKeys: [],
    });
    expect(loadDraft("admin", "t-1").partialFieldEdits.foo).toBe(1);
    expect(loadDraft("admin", "t-2").partialFieldEdits.foo).toBe(2);
  });

  test("loadDraft returns a defensive copy (mutations don't leak back)", () => {
    saveDraft("default", "t-1", {
      partialFieldEdits: { a: "x" },
      scrollTop: 0,
      expandedKeys: ["k"],
    });
    const snap = loadDraft("default", "t-1");
    snap.partialFieldEdits.a = "y";
    snap.expandedKeys.push("z");
    const second = loadDraft("default", "t-1");
    expect(second.partialFieldEdits.a).toBe("x");
    expect(second.expandedKeys).toEqual(["k"]);
  });

  test("clearDraft drops the entry", () => {
    saveDraft("default", "t-1", {
      partialFieldEdits: { a: 1 },
      scrollTop: 7,
      expandedKeys: [],
    });
    clearDraft("default", "t-1");
    expect(loadDraft("default", "t-1").partialFieldEdits).toEqual({});
  });

  test("null/undefined tenant collapses to a single bucket", () => {
    saveDraft("default", null, {
      partialFieldEdits: { a: 1 },
      scrollTop: 0,
      expandedKeys: [],
    });
    expect(loadDraft("default", undefined).partialFieldEdits.a).toBe(1);
  });
});
