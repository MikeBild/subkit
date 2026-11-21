import { describe, expect, test } from "bun:test";
import type { AdmissionRequest } from "./admission.ts";
import {
  AUTHORITY_COVERED_RULE,
  admittedCoveringAuthority,
  decideRunCoverage,
  RUN_UNCOVERED,
  type RunCoverageFacts,
} from "./run-coverage.ts";

const WF = "11111111-1111-4111-8111-111111111111";
const V1 = "22222222-2222-4222-8222-222222222222";
const V2 = "33333333-3333-4333-8333-333333333333";
const AUTH = "44444444-4444-4444-8444-444444444444";
const DIGEST = "a".repeat(64);
const OTHER_DIGEST = "b".repeat(64);

const request: AdmissionRequest = { workflow_id: WF };

const facts: RunCoverageFacts = {
  lifecycle: "active",
  current_version_id: V1,
  preview: { eligible: true, digest: DIGEST },
  authority: { id: AUTH, effect_manifest_digest: DIGEST },
};

describe("decideRunCoverage", () => {
  test("the uncovered answer names no authority", () => {
    expect(RUN_UNCOVERED).toEqual({ covered: false });
  });

  test("a live authority with the current digest covers the active version", () => {
    expect(decideRunCoverage(request, facts)).toEqual({ covered: true, authority_id: AUTH });
  });

  test("the exact active version may be named and stays covered", () => {
    expect(
      decideRunCoverage(
        { workflow_id: WF, workflow_version_id: V1, expected_workflow_version_id: V1 },
        facts,
      ),
    ).toEqual({ covered: true, authority_id: AUTH });
  });

  test("an explicit preparation is never covered", () => {
    expect(decideRunCoverage({ workflow_id: WF, hold_writes: true }, facts)).toBe(RUN_UNCOVERED);
  });

  test("a declined preparation flag does not block coverage", () => {
    expect(decideRunCoverage({ workflow_id: WF, hold_writes: false }, facts).covered).toBe(true);
  });

  test("no preview means no coverage", () => {
    expect(decideRunCoverage(request, { ...facts, preview: null })).toBe(RUN_UNCOVERED);
  });

  test("no live authority means no coverage", () => {
    expect(decideRunCoverage(request, { ...facts, authority: null })).toBe(RUN_UNCOVERED);
  });

  test("a prepared version that differs from the requested version is not covered", () => {
    expect(
      decideRunCoverage(
        { workflow_id: WF, workflow_version_id: V1, expected_workflow_version_id: V2 },
        facts,
      ),
    ).toBe(RUN_UNCOVERED);
  });

  test("a requested version other than the active one is not covered", () => {
    expect(decideRunCoverage({ workflow_id: WF, workflow_version_id: V2 }, facts)).toBe(
      RUN_UNCOVERED,
    );
  });

  test.each(["draft", "archived", null])("lifecycle %p is not covered", (lifecycle) => {
    expect(decideRunCoverage(request, { ...facts, lifecycle })).toBe(RUN_UNCOVERED);
  });

  test("a workflow without an active version is not covered", () => {
    expect(decideRunCoverage(request, { ...facts, current_version_id: null })).toBe(RUN_UNCOVERED);
  });

  test("effects that need a concrete-run review are not covered", () => {
    expect(
      decideRunCoverage(request, { ...facts, preview: { eligible: false, digest: DIGEST } }),
    ).toBe(RUN_UNCOVERED);
  });

  test("a changed manifest digest is not covered", () => {
    expect(
      decideRunCoverage(request, { ...facts, preview: { eligible: true, digest: OTHER_DIGEST } }),
    ).toBe(RUN_UNCOVERED);
    expect(
      decideRunCoverage(request, {
        ...facts,
        authority: { id: AUTH, effect_manifest_digest: OTHER_DIGEST },
      }),
    ).toBe(RUN_UNCOVERED);
  });
});

describe("admittedCoveringAuthority", () => {
  const covered = { covered: true, authority_id: AUTH } as const;
  const admitted = { execution_authority_id: AUTH, hold_writes: false };

  test("names the authority when the skipped question ended in a run admitted under it", () => {
    expect(admittedCoveringAuthority(AUTHORITY_COVERED_RULE, covered, admitted)).toBe(AUTH);
  });

  test("claims nothing for any other rule", () => {
    expect(admittedCoveringAuthority("write_gate", covered, admitted)).toBeNull();
  });

  test("claims nothing without coverage", () => {
    expect(admittedCoveringAuthority(AUTHORITY_COVERED_RULE, RUN_UNCOVERED, admitted)).toBeNull();
  });

  test("claims nothing when admission ended held", () => {
    expect(
      admittedCoveringAuthority(AUTHORITY_COVERED_RULE, covered, {
        execution_authority_id: AUTH,
        hold_writes: true,
      }),
    ).toBeNull();
    expect(
      admittedCoveringAuthority(AUTHORITY_COVERED_RULE, covered, { execution_authority_id: AUTH }),
    ).toBeNull();
  });

  test("claims nothing when the run was admitted under another or no authority", () => {
    expect(
      admittedCoveringAuthority(AUTHORITY_COVERED_RULE, covered, {
        execution_authority_id: V1,
        hold_writes: false,
      }),
    ).toBeNull();
    expect(
      admittedCoveringAuthority(AUTHORITY_COVERED_RULE, covered, {
        execution_authority_id: null,
        hold_writes: false,
      }),
    ).toBeNull();
    expect(admittedCoveringAuthority(AUTHORITY_COVERED_RULE, covered, {})).toBeNull();
  });
});
