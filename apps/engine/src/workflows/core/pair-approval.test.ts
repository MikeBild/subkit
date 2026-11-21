import { describe, expect, test } from "bun:test";
import {
  decidePair,
  effectivePairState,
  PAIR_REQUEST_TTL_MS,
  type PairFacts,
  pairExpiry,
  viewerCanApprove,
} from "./pair-approval.ts";

const created = new Date("2026-11-21T10:00:00.000Z");
const later = (ms: number) => new Date(created.getTime() + ms);
const pending: PairFacts = {
  state: "pending",
  first_approver_id: "anna",
  expires_at: later(PAIR_REQUEST_TTL_MS),
};

describe("a half-approved pair request", () => {
  test("waits 72 hours, or less when the approval itself ends earlier", () => {
    expect(pairExpiry(created, null)).toEqual(later(PAIR_REQUEST_TTL_MS));
    expect(pairExpiry(created, later(3_600_000))).toEqual(later(3_600_000));
    expect(pairExpiry(created, later(PAIR_REQUEST_TTL_MS * 2))).toEqual(later(PAIR_REQUEST_TTL_MS));
  });

  test("expires by the clock without anyone touching it", () => {
    expect(effectivePairState(pending, later(PAIR_REQUEST_TTL_MS - 1))).toBe("pending");
    expect(effectivePairState(pending, later(PAIR_REQUEST_TTL_MS))).toBe("expired");
    expect(effectivePairState({ ...pending, state: "approved" }, later(PAIR_REQUEST_TTL_MS))).toBe(
      "approved",
    );
  });

  test("one person can never fill both slots", () => {
    expect(decidePair(pending, { kind: "approve" }, "anna", created)).toEqual({
      ok: false,
      code: "pair_same_person",
    });
    expect(decidePair(pending, { kind: "decline" }, "anna", created)).toEqual({
      ok: false,
      code: "pair_same_person",
    });
    expect(decidePair(pending, { kind: "approve" }, "bert", created)).toEqual({ ok: true });
  });

  test("only the requester or an administrator withdraws", () => {
    expect(decidePair(pending, { kind: "withdraw", admin: false }, "anna", created).ok).toBe(true);
    expect(decidePair(pending, { kind: "withdraw", admin: false }, "bert", created)).toEqual({
      ok: false,
      code: "pair_not_requester",
    });
    expect(decidePair(pending, { kind: "withdraw", admin: true }, "bert", created).ok).toBe(true);
  });

  test("a closed or expired request takes no further decision", () => {
    expect(decidePair(pending, { kind: "approve" }, "bert", later(PAIR_REQUEST_TTL_MS))).toEqual({
      ok: false,
      code: "pair_request_expired",
    });
    for (const state of ["approved", "declined", "withdrawn", "expired", "stale"] as const) {
      expect(decidePair({ ...pending, state }, { kind: "approve" }, "bert", created)).toEqual({
        ok: false,
        code: "pair_request_closed",
      });
    }
  });

  test("the viewer may approve only with the permission and as the second person", () => {
    expect(viewerCanApprove(pending, "bert", true, created)).toBe(true);
    expect(viewerCanApprove(pending, "bert", false, created)).toBe(false);
    expect(viewerCanApprove(pending, "anna", true, created)).toBe(false);
  });
});
