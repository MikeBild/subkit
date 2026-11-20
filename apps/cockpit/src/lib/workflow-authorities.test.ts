import { describe, expect, test } from "bun:test";
import {
  untilRevokedOffer as coreUntilRevokedOffer,
  grantLimitOf,
  reviewGrantAction,
} from "@/lib/core/authority-decision";
import { translate } from "@/lib/i18n";
import {
  AUTHORITY_EFFECT_KEYS,
  AUTHORITY_STATE_KEYS,
  acceptReview,
  authorityGrantInput,
  DEFAULT_GRANT_LIMIT,
  grantLimitBounds,
  observedAuthorityState,
  type WorkflowAuthority,
  type WorkflowAuthorityPreview,
} from "./workflow-authorities";

const UNTIL = "2026-01-02T00:00:00.000Z";
const authority: WorkflowAuthority = {
  id: "00000000-0000-4000-8000-000000000001",
  workflow_id: "00000000-0000-4000-8000-000000000002",
  workflow_version_id: "00000000-0000-4000-8000-000000000003",
  effect_manifest_digest: "digest",
  effect_manifest: {
    schema_version: 1,
    tenant_id: "00000000-0000-4000-8000-000000000004",
    workflow_id: "00000000-0000-4000-8000-000000000002",
    workflow_version_id: "00000000-0000-4000-8000-000000000003",
    workflow_digest: "workflow",
    execution_environment: "dev",
    execution_options_digest: "options",
    effects: [],
    issues: [],
  },
  execution_environment: "dev",
  target_constraints: { targets: [] },
  valid_from: "2026-01-01T00:00:00.000Z",
  valid_until: UNTIL,
  max_runs: 2,
  reserved_runs: 1,
  remaining_runs: 1,
  created_by: "00000000-0000-4000-8000-000000000005",
  created_at: "2026-01-01T00:00:00.000Z",
  revoked_at: null,
  revoked_by: null,
  open_ended: false,
  inherited_from: null,
  superseded_by: null,
  active_version: true,
  ready_for_new_run: true,
  state: "approved",
};

test("authority core offers a bounded approval only when it is active and writable", () => {
  const now = Date.parse("2026-01-01T00:00:00.000Z");
  expect(coreUntilRevokedOffer(authority, now, true)).toEqual({ days: 1 });
  expect(coreUntilRevokedOffer(authority, now, false)).toBeNull();
  expect(coreUntilRevokedOffer({ ...authority, revoked_at: UNTIL }, now, true)).toBeNull();
  expect(coreUntilRevokedOffer({ ...authority, valid_until: null }, now, true)).toEqual({
    days: null,
  });
  expect(coreUntilRevokedOffer({ ...authority, max_runs: null }, now, true)).toEqual({ days: 1 });
  expect(
    coreUntilRevokedOffer({ ...authority, valid_until: null, max_runs: null }, now, true),
  ).toBeNull();
  expect(
    coreUntilRevokedOffer({ ...authority, valid_until: null, remaining_runs: 0 }, now, true),
  ).toBeNull();
  expect(
    coreUntilRevokedOffer({ ...authority, valid_until: null, revoked_at: UNTIL }, now, true),
  ).toBeNull();
  expect(coreUntilRevokedOffer({ ...authority, valid_until: null }, now, false)).toBeNull();
  expect(coreUntilRevokedOffer({ ...authority, state: "superseded" }, now, true)).toBeNull();
  expect(
    coreUntilRevokedOffer({ ...authority, valid_until: "2026-01-04T00:00:00.000Z" }, now, true),
  ).toEqual({ days: 3 });
});

describe("the grant the chat review card asks for", () => {
  const manual = {
    environment: "prod" as const,
    valid_from: "2026-01-01T00:00:00.000Z",
    valid_until: UNTIL,
    max_runs: 1,
  };
  test("starts at until revoked, whatever finite bounds were suggested", () => {
    expect(reviewGrantAction(manual, DEFAULT_GRANT_LIMIT)).toEqual({
      environment: "prod",
      valid_from: manual.valid_from,
      valid_until: null,
      max_runs: null,
    });
    const hooked = { ...manual, valid_until: "2026-01-31T00:00:00.000Z", max_runs: 100 };
    expect(reviewGrantAction(hooked, "until_revoked")).toEqual(
      reviewGrantAction(manual, "until_revoked"),
    );
  });
  test("a chosen duration counts from the suggested start and carries no run limit", () => {
    expect(reviewGrantAction({ ...manual, environment: "dev" }, "7d")).toEqual({
      environment: "dev",
      valid_from: manual.valid_from,
      valid_until: "2026-01-08T00:00:00.000Z",
      max_runs: null,
    });
    expect(reviewGrantAction(manual, "30d")).toMatchObject({
      valid_until: "2026-01-31T00:00:00.000Z",
      max_runs: null,
    });
  });
  test("an unreadable start yields no grant", () => {
    expect(reviewGrantAction({ ...manual, valid_from: "soon" }, "until_revoked")).toBeNull();
    expect(reviewGrantAction({ ...manual, valid_from: "soon" }, "7d")).toBeNull();
  });
  test("a selected grant maps back to the choice that shows it", () => {
    const from = manual.valid_from;
    expect(grantLimitOf({ valid_from: from, valid_until: null })).toBe("until_revoked");
    expect(grantLimitOf({ valid_from: from })).toBe("until_revoked");
    expect(grantLimitOf({ valid_from: from, valid_until: UNTIL })).toBe("7d");
    expect(grantLimitOf({ valid_from: from, valid_until: "2026-01-08T00:00:00.000Z" })).toBe("7d");
    expect(grantLimitOf({ valid_from: from, valid_until: "2026-01-08T00:00:00.001Z" })).toBe("30d");
    expect(grantLimitOf({ valid_from: from, valid_until: "2026-01-31T00:00:00.000Z" })).toBe("30d");
    for (const limit of ["until_revoked", "7d", "30d"] as const)
      expect(grantLimitOf(reviewGrantAction(manual, limit)!)).toBe(limit);
  });
});

const during = Date.parse("2026-01-01T12:00:00.000Z");

const preview: WorkflowAuthorityPreview = {
  manifest: authority.effect_manifest,
  schedules: [],
  digest: "a".repeat(64),
  eligible_for_repeated_runs: true,
  unavailable_steps: [],
  suggested_bounds: {
    valid_from: authority.valid_from,
    valid_until: UNTIL,
    max_runs: 1,
  },
  suggested_bounds_basis: { kind: "manual" },
  approval_carries_over: false,
  environments: { dev: { possible: true, reasons: [] }, prod: { possible: true, reasons: [] } },
  recommended_environment: { environment: "dev", reason: "started_manually" },
  execution_shape: { requests: [], iterations: [], run_limit_is_request_limit: false },
};
const expected = {
  workflowId: authority.workflow_id,
  versionId: authority.workflow_version_id,
  environment: "dev" as const,
};

describe("which review answer the dialog shows", () => {
  test("shows the latest answer to the question it asked", () => {
    expect(acceptReview(3, 3, expected, preview)).toBe("accept");
  });
  test("drops an answer to an older request, even one that matches", () => {
    expect(acceptReview(4, 3, expected, preview)).toBe("stale");
  });
  test("refuses an answer about another version or environment", () => {
    expect(acceptReview(1, 1, { ...expected, versionId: "other" }, preview)).toBe("mismatch");
    expect(acceptReview(1, 1, { ...expected, environment: "prod" }, preview)).toBe("mismatch");
    expect(acceptReview(1, 1, { ...expected, workflowId: "other" }, preview)).toBe("mismatch");
  });
  test("a stale answer is stale before it is anything else", () => {
    expect(acceptReview(2, 1, { ...expected, environment: "prod" }, preview)).toBe("stale");
  });
});

describe("exact grant input", () => {
  test("accepts inclusive count and hour limits and rejects past-start invalid durations", () => {
    const beforeStart = Date.parse(authority.valid_from) - 86_400_000;
    for (const runs of ["1", "10000"]) {
      for (const hours of ["1", "744"]) {
        expect(authorityGrantInput(preview, expected, runs, hours, beforeStart)).toMatchObject({
          max_runs: Number(runs),
          valid_until: hours === "1" ? "2026-01-01T01:00:00.000Z" : "2026-02-01T00:00:00.000Z",
        });
      }
    }
    for (const hours of ["0", "-1", "1.5"]) {
      expect(authorityGrantInput(preview, expected, "1", hours, beforeStart)).toBeNull();
    }
  });
  test("binds the reviewed digest, version, environment and original start time", () => {
    expect(authorityGrantInput(preview, expected, "2", "24", during)).toEqual({
      workflow_version_id: authority.workflow_version_id,
      execution_environment: "dev",
      expected_manifest_digest: preview.digest,
      valid_from: authority.valid_from,
      valid_until: UNTIL,
      max_runs: 2,
    });
  });
  test("an approval until revoked sends no run limit and no end date", () => {
    expect(authorityGrantInput(preview, expected, null, null, during)).toEqual({
      workflow_version_id: authority.workflow_version_id,
      execution_environment: "dev",
      expected_manifest_digest: preview.digest,
      valid_from: authority.valid_from,
      valid_until: null,
      max_runs: null,
    });
    expect(
      authorityGrantInput(preview, expected, null, null, Date.parse(UNTIL) + 1),
    ).not.toBeNull();
  });
  test("the dialog starts at 'until revoked', and its button follows the choice", () => {
    expect(DEFAULT_GRANT_LIMIT).toBe("until_revoked");
    expect(grantLimitBounds("until_revoked")).toEqual({ runs: null, hours: null });
    expect(grantLimitBounds("7d")).toEqual({ runs: null, hours: "168" });
    expect(grantLimitBounds("30d")).toEqual({ runs: null, hours: "720" });
  });
  test("rejects invalid counts, windows and an expired review", () => {
    for (const runs of ["", "0", "1.5", "10001", "NaN"])
      expect(authorityGrantInput(preview, expected, runs, "24", during)).toBeNull();
    for (const hours of ["", "0", "1.5", "745", "Infinity"])
      expect(authorityGrantInput(preview, expected, "1", hours, during)).toBeNull();
    expect(authorityGrantInput(preview, expected, "1", "24", Date.parse(UNTIL))).toBeNull();
  });
  test("does not reuse a review across workflow, version or environment changes", () => {
    expect(
      authorityGrantInput(preview, { ...expected, workflowId: "other" }, "1", "24", during),
    ).toBeNull();
    expect(
      authorityGrantInput(preview, { ...expected, versionId: "other" }, "1", "24", during),
    ).toBeNull();
    expect(
      authorityGrantInput(preview, { ...expected, environment: "prod" }, "1", "24", during),
    ).toBeNull();
    expect(
      authorityGrantInput(
        { ...preview, eligible_for_repeated_runs: false },
        expected,
        "1",
        "24",
        during,
      ),
    ).toBeNull();
  });
  test("does not turn a shortened or omitted payload into a completed review", () => {
    const request = {
      step_id: "send",
      retry_policy_max_attempts: 1,
      redacted_request_json: "{}",
      request_review_truncated: false,
      opaque_payload_omitted: false,
    };
    expect(
      authorityGrantInput(
        { ...preview, execution_shape: { ...preview.execution_shape, requests: [request] } },
        expected,
        "1",
        "24",
        during,
      ),
    ).not.toBeNull();
    for (const patch of [{ request_review_truncated: true }, { opaque_payload_omitted: true }]) {
      expect(
        authorityGrantInput(
          {
            ...preview,
            execution_shape: { ...preview.execution_shape, requests: [{ ...request, ...patch }] },
          },
          expected,
          "1",
          "24",
          during,
        ),
      ).toBeNull();
    }
  });
});

describe("authority display boundaries", () => {
  test("an approval until revoked is neither expired nor used up by the local clock", () => {
    const open = {
      ...authority,
      valid_until: null,
      max_runs: null,
      remaining_runs: null,
      reserved_runs: 5_000,
      open_ended: true,
    };
    expect(observedAuthorityState(open, Date.parse(UNTIL) + 365 * 86_400_000)).toBe("approved");
  });
  test("expires at the exact deadline without waiting for a server refresh", () => {
    expect(observedAuthorityState(authority, during)).toBe("approved");
    expect(observedAuthorityState(authority, Date.parse(UNTIL))).toBe("expired");
    expect(observedAuthorityState(authority, Date.parse(authority.valid_from) - 1)).toBe(
      "not_yet_valid",
    );
  });
  test("never upgrades a server refusal based on the browser clock", () => {
    for (const state of Object.keys(AUTHORITY_STATE_KEYS) as WorkflowAuthority["state"][]) {
      if (state !== "approved")
        expect(observedAuthorityState({ ...authority, state }, during)).toBe(state);
    }
  });
  test("does not advertise remaining runs with exhausted or malformed bounds", () => {
    expect(observedAuthorityState({ ...authority, remaining_runs: 0 }, during)).toBe("exhausted");
    expect(observedAuthorityState({ ...authority, valid_until: "invalid" }, during)).toBe(
      "unavailable",
    );
  });
  test("every state and effect has English and German wording", () => {
    for (const key of [
      ...Object.values(AUTHORITY_STATE_KEYS),
      ...Object.values(AUTHORITY_EFFECT_KEYS),
    ]) {
      expect(translate("en", key)).not.toBe(key);
      expect(translate("de", key)).not.toBe(key);
      expect(translate("de", key)).not.toBe(translate("en", key));
    }
  });
});
