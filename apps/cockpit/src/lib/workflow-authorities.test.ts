import { describe, expect, test } from "bun:test";
import { translate } from "@/lib/i18n";
import {
  AUTHORITY_EFFECT_KEYS,
  AUTHORITY_STATE_KEYS,
  authorityGrantInput,
  observedAuthorityState,
  type WorkflowAuthority,
  type WorkflowAuthorityPreview,
} from "./workflow-authorities";

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
  valid_until: "2026-01-02T00:00:00.000Z",
  max_runs: 2,
  reserved_runs: 1,
  remaining_runs: 1,
  created_by: "00000000-0000-4000-8000-000000000005",
  created_at: "2026-01-01T00:00:00.000Z",
  revoked_at: null,
  revoked_by: null,
  active_version: true,
  ready_for_new_run: true,
  state: "approved",
};
const during = Date.parse("2026-01-01T12:00:00.000Z");

const preview: WorkflowAuthorityPreview = {
  manifest: authority.effect_manifest,
  schedules: [],
  digest: "a".repeat(64),
  eligible_for_repeated_runs: true,
  unavailable_steps: [],
  suggested_bounds: {
    valid_from: authority.valid_from,
    valid_until: authority.valid_until,
    max_runs: 1,
  },
  execution_shape: { requests: [], iterations: [], run_limit_is_request_limit: false },
};
const expected = {
  workflowId: authority.workflow_id,
  versionId: authority.workflow_version_id,
  environment: "dev" as const,
};

describe("exact grant input", () => {
  test("binds the reviewed digest, version, environment and original start time", () => {
    expect(authorityGrantInput(preview, expected, "2", "24", during)).toEqual({
      workflow_version_id: authority.workflow_version_id,
      execution_environment: "dev",
      expected_manifest_digest: preview.digest,
      valid_from: authority.valid_from,
      valid_until: authority.valid_until,
      max_runs: 2,
    });
  });
  test("rejects invalid counts, windows and an expired review", () => {
    for (const runs of ["", "0", "1.5", "10001", "NaN"])
      expect(authorityGrantInput(preview, expected, runs, "24", during)).toBeNull();
    for (const hours of ["", "0", "1.5", "745", "Infinity"])
      expect(authorityGrantInput(preview, expected, "1", hours, during)).toBeNull();
    expect(
      authorityGrantInput(preview, expected, "1", "24", Date.parse(authority.valid_until)),
    ).toBeNull();
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
  test("expires at the exact deadline without waiting for a server refresh", () => {
    expect(observedAuthorityState(authority, during)).toBe("approved");
    expect(observedAuthorityState(authority, Date.parse(authority.valid_until))).toBe("expired");
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
