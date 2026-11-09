import { expect, test } from "bun:test";
import fc from "fast-check";
import { decideAuthorityExtension, reusableOpenEndedSuccessor } from "./authority-extension.ts";

const boundary = {
  id: "old",
  workflow_id: "workflow",
  workflow_version_id: "version",
  execution_environment: "prod",
  effect_manifest_digest: "digest",
  max_runs: null,
  inherited_from: null,
  target_constraints: {},
  superseded_by: null,
};

test("review mismatch and revocation precede accepting unchanged authority", () => {
  expect(
    decideAuthorityExtension({ stage: "review", previous_digest: "a", expected_digest: "b" }),
  ).toEqual({
    kind: "rejected",
    code: "authority_manifest_changed",
    message: "the reviewed approval changed; review again",
  });
  expect(
    decideAuthorityExtension({ stage: "review", previous_digest: "a", expected_digest: "a" }),
  ).toEqual({ kind: "proceed" });
  expect(decideAuthorityExtension({ stage: "previous", revoked: true, open_ended: true })).toEqual({
    kind: "rejected",
    code: "authority_revoked",
    message: "this approval was revoked; review a new boundary",
  });
  expect(decideAuthorityExtension({ stage: "previous", revoked: false, open_ended: true })).toEqual(
    { kind: "unchanged" },
  );
  expect(
    decideAuthorityExtension({ stage: "previous", revoked: false, open_ended: false }),
  ).toEqual({ kind: "proceed" });
});

test("extension requires a live interval and available run budget", () => {
  const base = {
    stage: "live" as const,
    valid_from_ms: 10,
    valid_until_ms: 20,
    now_ms: 10,
    max_runs: null,
    reserved_runs: 0,
  };
  for (const change of [{ now_ms: 9 }, { now_ms: 20 }, { max_runs: 1, reserved_runs: 1 }])
    expect(decideAuthorityExtension({ ...base, ...change })).toEqual({
      kind: "rejected",
      code: "authority_not_live",
      message: "only an approval that currently applies can be made open-ended",
    });
  expect(decideAuthorityExtension({ ...base, max_runs: 1 })).toEqual({ kind: "proceed" });
  fc.assert(
    fc.property(fc.integer({ min: 10, max: 19 }), (now_ms) => {
      const facts = Object.freeze({ ...base, now_ms });
      expect(decideAuthorityExtension(facts)).toEqual({ kind: "proceed" });
      expect(facts.now_ms).toBe(now_ms);
    }),
    { seed: 20261109, numRuns: 100 },
  );
});

test("preview rejects changed effect boundaries before unbound effects", () => {
  const facts = {
    stage: "preview" as const,
    previous_digest: "a",
    current_digest: "b",
    eligible_for_repeated_runs: false,
  };
  expect(decideAuthorityExtension(facts)).toEqual({
    kind: "rejected",
    code: "authority_manifest_changed",
    message: "what the workflow may do changed; review again",
  });
  expect(decideAuthorityExtension({ ...facts, current_digest: "a" })).toEqual({
    kind: "rejected",
    code: "authority_effect_unbound",
    message: "the workflow requires concrete-run review for an unbound or unavailable effect",
  });
  expect(
    decideAuthorityExtension({ ...facts, current_digest: "a", eligible_for_repeated_runs: true }),
  ).toEqual({ kind: "proceed" });
});

test("only an open-ended successor with the same boundary is reusable", () => {
  expect(reusableOpenEndedSuccessor(null, boundary)).toBe(false);
  expect(reusableOpenEndedSuccessor({ ...boundary, valid_until: new Date(0) }, boundary)).toBe(
    false,
  );
  expect(
    reusableOpenEndedSuccessor(
      { ...boundary, valid_until: null, workflow_version_id: "other" },
      boundary,
    ),
  ).toBe(false);
  expect(reusableOpenEndedSuccessor({ ...boundary, id: "next", valid_until: null }, boundary)).toBe(
    true,
  );
});
