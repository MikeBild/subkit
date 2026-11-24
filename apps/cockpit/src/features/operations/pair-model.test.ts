import { describe, expect, test } from "bun:test";
import {
  needsPair,
  needsTwoApprovers,
  openPairs,
  PAIR_REFUSALS,
  type PairApproval,
  type PairRefusal,
  type PairRefusalClass,
  pairFailure,
  pairRefusal,
  pairRequestBody,
  pairState,
  pairView,
  pairVisibility,
} from "./pair-model";

const NOW = Date.parse("2026-11-21T12:00:00.000Z");
const pair = (over: Partial<PairApproval> = {}): PairApproval => ({
  id: "p1",
  state: "pending",
  stale_reason: null,
  first_approver: { user_id: "lena", name: "Lena Hoffmann" },
  second_approver: null,
  expires_at: "2026-11-23T12:00:00.000Z",
  viewer_can_approve: true,
  ...over,
});

describe("pair approval", () => {
  test("a pending request past its expiry reads as expired", () => {
    expect(pairState(pair(), NOW)).toBe("pending");
    expect(pairState(pair({ expires_at: "2026-11-21T12:00:00.000Z" }), NOW)).toBe("expired");
    expect(pairState(pair({ state: "declined", expires_at: "2020-01-01T00:00:00Z" }), NOW)).toBe(
      "declined",
    );
  });

  test("the first slot holds the first approver, the second stays empty while it waits", () => {
    const view = pairView(pair(), "max", NOW);
    expect(view.slots).toEqual([
      { name: "Lena Hoffmann", filled: true },
      { name: null, filled: false },
    ]);
    expect(view.tone).toBe("info");
  });

  test("another person may approve or decline, the first approver may only withdraw", () => {
    expect(pairView(pair(), "max", NOW).actions).toEqual(["approve", "decline"]);
    expect(pairView(pair(), "lena", NOW).actions).toEqual(["withdraw"]);
    expect(pairView(pair({ viewer_can_approve: false }), "max", NOW).actions).toEqual([]);
  });

  test("a closed request offers nothing", () => {
    for (const state of ["approved", "declined", "withdrawn", "stale"] as const)
      expect(pairView(pair({ state }), "max", NOW).actions).toEqual([]);
    expect(pairView(pair({ expires_at: "2026-11-20T00:00:00Z" }), "max", NOW).actions).toEqual([]);
  });

  test("an approved request fills both slots", () => {
    const view = pairView(
      pair({ state: "approved", second_approver: { user_id: "max", name: "Max Weber" } }),
      "lena",
      NOW,
    );
    expect(view.slots[1]).toEqual({ name: "Max Weber", filled: true });
    expect(view.tone).toBe("success");
  });

  test("stale and expired requests warn, a declined one is red, a withdrawn one grey", () => {
    expect(pairView(pair({ state: "stale" }), "max", NOW).tone).toBe("warning");
    expect(pairView(pair({ state: "declined" }), "max", NOW).tone).toBe("danger");
    expect(pairView(pair({ state: "withdrawn" }), "max", NOW).tone).toBe("neutral");
  });

  test("only open requests are listed as waiting", () => {
    const list = [
      pair(),
      pair({ id: "p2", state: "approved" }),
      pair({ id: "p3", expires_at: "2026-11-01T00:00:00Z" }),
    ];
    expect(openPairs(list, NOW).map((p) => p.id)).toEqual(["p1"]);
  });

  test("the grant route's 409 sends the dialog to pair approvals", () => {
    expect(needsPair({ code: "pair_approval_required" })).toBe(true);
    expect(needsPair({ code: "authority_manifest_changed" })).toBe(false);
    expect(needsPair(null)).toBe(false);
  });
});

describe("pair approval policy and failures", () => {
  test("one approver hides the setting but setup still offers inviting the second", () => {
    const invite = { setting: false, option: true, hints: false };
    expect(pairVisibility({ workflow_approvals: "single", eligible_approvers: 1 })).toEqual(invite);
    expect(pairVisibility({ workflow_approvals: "single", eligible_approvers: 0 })).toEqual(invite);
  });

  test("an unreadable policy hides every pair surface", () => {
    const hidden = { setting: false, option: false, hints: false };
    expect(pairVisibility(null)).toEqual(hidden);
    expect(pairVisibility(undefined)).toEqual(hidden);
  });

  test("two approvers offer the setting and the setup option, but no hints while it is off", () => {
    expect(pairVisibility({ workflow_approvals: "single", eligible_approvers: 2 })).toEqual({
      setting: true,
      option: true,
      hints: false,
    });
  });

  test("a workspace that switched pair on keeps every pair surface, even with one approver left", () => {
    const shown = { setting: true, option: true, hints: true };
    expect(pairVisibility({ workflow_approvals: "pair", eligible_approvers: 3 })).toEqual(shown);
    expect(pairVisibility({ workflow_approvals: "pair", eligible_approvers: 1 })).toEqual(shown);
  });

  test("an answer that already chose pair stays selectable without offering the setting", () => {
    expect(pairVisibility({ workflow_approvals: "single", eligible_approvers: 1 }, true)).toEqual({
      setting: false,
      option: true,
      hints: false,
    });
  });

  test("pair failure codes are recognised, others are left to the generic failure", () => {
    expect(pairFailure({ code: "pair_same_person", status: 403 })).toBe("pair_same_person");
    expect(pairFailure({ code: "pair_request_closed" })).toBe("pair_request_closed");
    expect(pairFailure({ code: "authority_manifest_changed" })).toBe("authority_manifest_changed");
    expect(pairFailure({ code: "rate_limited" })).toBeNull();
    expect(pairFailure(new Error("x"))).toBeNull();
    expect(pairFailure(null)).toBeNull();
  });

  test("a pair request never carries start_run or an activation", () => {
    const body = pairRequestBody({
      workflow_version_id: "v",
      valid_from: "2026-11-21T00:00:00Z",
      valid_until: null,
      max_runs: 3,
      start_run: true,
      activation: { expected_current_version_id: null },
    });
    expect(body).toEqual({
      workflow_version_id: "v",
      valid_from: "2026-11-21T00:00:00Z",
      valid_until: null,
      max_runs: 3,
    });
  });
});

describe("pair refusal codes", () => {
  const CLASSES: Record<PairRefusal, PairRefusalClass> = {
    pair_approval_required: "needs_pair",
    pair_needs_two_approvers: "needs_two_approvers",
    pair_same_person: "same_person",
    pair_not_requester: "not_requester",
    pair_not_required: "not_required",
    pair_request_not_found: "request_missing",
    pair_request_closed: "request_closed",
    pair_request_expired: "request_closed",
    pair_request_stale: "request_closed",
    authority_manifest_changed: "boundary_changed",
    pair_schedule_unsupported: "unsupported",
    pair_start_run_unsupported: "unsupported",
  };
  const SHOWN: readonly PairRefusal[] = [
    "pair_same_person",
    "pair_request_closed",
    "authority_manifest_changed",
    "pair_not_required",
    "pair_approval_required",
  ];

  test("every refusal the engine sends for pair approval has exactly one class", () => {
    expect<Record<PairRefusal, PairRefusalClass>>(PAIR_REFUSALS).toEqual(CLASSES);
    for (const code of Object.keys(CLASSES) as PairRefusal[]) {
      const kind = CLASSES[code];
      const error = { code, status: 409 };
      expect(pairRefusal(error)).toBe(code);
      expect(needsPair(error)).toBe(kind === "needs_pair");
      expect(needsTwoApprovers(error)).toBe(kind === "needs_two_approvers");
      expect(pairFailure(error) === code).toBe(SHOWN.includes(code));
    }
  });

  test("attention reasons and unrelated codes are not refusals", () => {
    for (const code of ["pair_approval_requested", "pair_approval_waiting", "rate_limited", ""])
      expect(pairRefusal({ code })).toBeNull();
    expect(pairRefusal({ code: 409 })).toBeNull();
    expect(pairRefusal("pair_same_person")).toBeNull();
    expect(pairRefusal(undefined)).toBeNull();
  });
});
