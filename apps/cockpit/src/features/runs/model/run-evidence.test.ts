import { expect, test } from "bun:test";
import { runPermissionBasis, runPermissionEvidence, stepEffectKind } from "./run-outcome";
import {
  initialRunsFilter,
  type StepCredentialSnapshot,
  stepCredentialSnapshots,
} from "./runs-model";

test("the run list defaults to a real seven-day window and preserves explicit history links", () => {
  const now = Date.UTC(2026, 0, 8);
  expect(initialRunsFilter("", now)).toMatchObject({
    startedFrom: "2026-01-01T00:00:00.000Z",
    startedTo: "2026-01-08T00:00:00.000Z",
  });
  expect(initialRunsFilter("?runs_from=2025-01-01T00%3A00%3A00.000Z", now).startedFrom).toBe(
    "2025-01-01T00:00:00.000Z",
  );
});

test("step identity stays unknown without a verified provider snapshot", () => {
  expect(stepCredentialSnapshots({})).toEqual([]);
  expect(
    stepCredentialSnapshots({
      credential_snapshots: [
        {
          connector_id: "connector",
          environment: "prod",
          identity: { issuer: "https://example.test", subject: "person", source: "guessed" },
        },
      ],
    }),
  ).toEqual([]);
  const snapshot: StepCredentialSnapshot = {
    connector_id: "connector",
    environment: "prod",
    credential_generation: 2,
    access_token_version: null,
    identity: { issuer: "https://example.test", subject: "person", source: "token_endpoint" },
  };
  expect(stepCredentialSnapshots({ credential_snapshots: [snapshot] })).toEqual([snapshot]);
  expect(
    stepCredentialSnapshots({ credential_snapshots: [{ ...snapshot, identity: null }] })[0]
      ?.identity,
  ).toBeNull();
});

test("step effects require recorded dispatch evidence and preserve historical unknowns", () => {
  for (const effect of ["read", "write"] as const) {
    expect(stepEffectKind({ request_meta: { extras: { effect_kind: effect } } })).toBe(effect);
  }
  for (const request_meta of [
    null,
    {},
    { method: "GET" },
    { method: "POST" },
    { extras: null },
    { extras: { effect_kind: "none" } },
  ]) {
    expect(stepEffectKind({ request_meta })).toBeNull();
  }
  expect(stepEffectKind({})).toBeNull();
});

test("permission evidence never derives a reason from a scope or role name", () => {
  for (const basis of [
    "builtin_admin",
    "resource_grant",
    "group",
    "role",
    "portal_token_allowlist",
  ] as const)
    expect(runPermissionBasis(basis)).toBe(basis);
  for (const missing of [
    null,
    undefined,
    "admin",
    "workflow:run",
    "credential_ceiling",
    { roles: ["admin"] },
  ])
    expect(runPermissionBasis(missing)).toBeNull();
});

test("permission evidence includes the recorded phase and time rather than implying current access", () => {
  const proof = {
    permission_basis: "role",
    permission_phase: "admission",
    permission_checked_at: "2026-01-01T00:00:00.000Z",
  };
  expect(runPermissionEvidence(proof)).toEqual({
    basis: "role",
    phase: "admission",
    checkedAt: proof.permission_checked_at,
  });
  expect(runPermissionEvidence({ ...proof, permission_phase: "start" })?.phase).toBe("start");
  expect(runPermissionEvidence({ permission_basis: "role" })).toBeNull();
  expect(runPermissionEvidence({ ...proof, permission_phase: "current" })).toBeNull();
  expect(runPermissionEvidence({ ...proof, permission_checked_at: "invalid" })).toBeNull();
});
