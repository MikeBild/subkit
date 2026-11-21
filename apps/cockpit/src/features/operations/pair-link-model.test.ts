import { describe, expect, test } from "bun:test";
import { pairLinkId, pairLinkTarget, shownPair } from "./pair-link-model";
import type { PairApproval } from "./pair-model";

const NOW = Date.parse("2026-11-21T12:00:00Z");

const pair = (over: Partial<PairApproval> = {}): PairApproval => ({
  id: "req-1",
  state: "pending",
  stale_reason: null,
  first_approver: { user_id: "u1", name: "Anna Berg" },
  second_approver: null,
  expires_at: "2026-11-22T12:00:00Z",
  decided_at: null,
  viewer_can_approve: true,
  ...over,
});

describe("pair link id", () => {
  test("reads the pair request id from the query", () => {
    expect(pairLinkId("?pair=req-1")).toBe("req-1");
    expect(pairLinkId("?pair=req%2F2")).toBe("req/2");
  });

  test("no or empty pair means no link", () => {
    expect(pairLinkId("")).toBeNull();
    expect(pairLinkId("?pair=")).toBeNull();
    expect(pairLinkId("?pair=%20%20")).toBeNull();
    expect(pairLinkId("?tab=schedule")).toBeNull();
  });
});

describe("pair link target", () => {
  test("a list that failed to load reveals nothing yet", () => {
    expect(pairLinkTarget("req-1", null, NOW)).toMatchObject({ kind: "loading" });
  });

  test("without a link nothing is targeted", () => {
    expect(pairLinkTarget(null, [pair()], NOW)).toEqual({ kind: "none" });
  });

  test("while the list loads the target waits", () => {
    expect(pairLinkTarget("req-1", null, NOW)).toEqual({ kind: "loading", id: "req-1" });
  });

  test("an id that is not in the list is missing", () => {
    expect(pairLinkTarget("other", [pair()], NOW)).toEqual({ kind: "missing", id: "other" });
    expect(pairLinkTarget("req-1", [], NOW)).toEqual({ kind: "missing", id: "req-1" });
  });

  test("an open request is the card to show", () => {
    const open = pair();
    expect(pairLinkTarget("req-1", [pair({ id: "x" }), open], NOW)).toEqual({
      kind: "open",
      pair: open,
    });
  });

  test("approved adds no rows, the current approval already names who and when", () => {
    const target = pairLinkTarget(
      "req-1",
      [
        pair({
          state: "approved",
          second_approver: { user_id: "u2", name: "Bert Koch" },
          decided_at: "2026-11-21T10:00:00Z",
        }),
      ],
      NOW,
    );
    expect(target).toMatchObject({
      kind: "closed",
      state: "approved",
      rows: [],
    });
  });

  test("declined and withdrawn only show when", () => {
    for (const state of ["declined", "withdrawn"] as const) {
      expect(
        pairLinkTarget("req-1", [pair({ state, decided_at: "2026-11-21T09:00:00Z" })], NOW),
      ).toMatchObject({ kind: "closed", state, rows: [{ key: "at", at: "2026-11-21T09:00:00Z" }] });
    }
  });

  test("a pending request past its time counts as expired at its deadline", () => {
    expect(
      pairLinkTarget("req-1", [pair({ expires_at: "2026-11-21T11:00:00Z" })], NOW),
    ).toMatchObject({
      kind: "closed",
      state: "expired",
      rows: [{ key: "at", at: "2026-11-21T11:00:00Z" }],
    });
  });

  test("stale names the reason", () => {
    expect(
      pairLinkTarget(
        "req-1",
        [pair({ state: "stale", stale_reason: "manifest_changed", decided_at: null })],
        NOW,
      ),
    ).toMatchObject({
      kind: "closed",
      state: "stale",
      rows: [{ key: "reason", reason: "manifest_changed" }],
    });
  });

  test("after the viewer acted on it, the closed request shows no notice", () => {
    const approved = [pair({ state: "approved", decided_at: "2026-11-21T11:30:00Z" })];
    expect(pairLinkTarget("req-1", approved, NOW, "req-1")).toEqual({ kind: "none" });
    expect(pairLinkTarget("req-1", [pair()], NOW, "req-1")).toMatchObject({ kind: "open" });
    expect(pairLinkTarget("req-1", approved, NOW, "other")).toMatchObject({ kind: "closed" });
  });

  test("a closed request without a decision time shows no time row", () => {
    expect(pairLinkTarget("req-1", [pair({ state: "declined" })], NOW)).toMatchObject({
      rows: [],
    });
  });
});

describe("shown pair", () => {
  const fallback = pair({ id: "first-open" });

  test("the linked open request wins over the first open one", () => {
    const linked = pair({ id: "linked" });
    expect(shownPair({ kind: "open", pair: linked }, fallback)).toBe(linked);
  });

  test("otherwise the first open request stays", () => {
    expect(shownPair({ kind: "none" }, fallback)).toBe(fallback);
    expect(shownPair({ kind: "missing", id: "x" }, fallback)).toBe(fallback);
    expect(shownPair({ kind: "loading", id: "x" }, null)).toBeNull();
  });
});
