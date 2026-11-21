import { expect, test } from "bun:test";
import fc from "fast-check";
import {
  runPermissionBasis,
  runPermissionEvidence,
  runTraceEvidence,
  stepEffectKind,
} from "./run-outcome";

test("effect evidence accepts only the two explicit effect kinds", () => {
  for (const effect_kind of ["read", "write"] as const) {
    expect(stepEffectKind({ request_meta: { extras: { effect_kind } } })).toBe(effect_kind);
  }
  for (const request_meta of [
    undefined,
    null,
    false,
    "read",
    {},
    { extras: null },
    { extras: "read" },
    { extras: {} },
    { extras: { effect_kind: "delete" } },
  ]) {
    expect(stepEffectKind({ request_meta })).toBeNull();
  }
});

test("permission evidence requires a recognized basis, phase and parseable instant", () => {
  const bases = [
    "builtin_admin",
    "resource_grant",
    "group",
    "role",
    "portal_token_allowlist",
  ] as const;
  const checkedAt = "2026-11-09T10:00:00.000Z";
  for (const basis of bases) {
    expect(runPermissionBasis(basis)).toBe(basis);
    for (const phase of ["admission", "start"] as const) {
      const run = {
        permission_basis: basis,
        permission_phase: phase,
        permission_checked_at: checkedAt,
      };
      const before = structuredClone(run);
      expect(runPermissionEvidence(run)).toEqual({ basis, phase, checkedAt });
      expect(run).toEqual(before);
    }
  }
  for (const patch of [
    { permission_basis: "owner" },
    { permission_basis: null },
    { permission_phase: "finish" },
    { permission_phase: null },
    { permission_checked_at: 123 },
    { permission_checked_at: "invalid" },
    { permission_checked_at: "" },
  ]) {
    expect(
      runPermissionEvidence({
        permission_basis: "role",
        permission_phase: "start",
        permission_checked_at: checkedAt,
        ...patch,
      }),
    ).toBeNull();
  }
  fc.assert(
    fc.property(fc.string(), (basis) => {
      expect(runPermissionBasis(basis)).toBe(bases.find((entry) => entry === basis) ?? null);
    }),
    { seed: 20261109, numRuns: 100 },
  );
});

test("trace evidence only builds an audit link for a recorded trace and permitted reader", () => {
  const link = (id: string) => `audit:${id}`;
  const forbiddenLink = () => {
    throw new Error("unexpected link construction");
  };
  for (const value of [
    null,
    undefined,
    false,
    1,
    "trace",
    {},
    { trace_id: null },
    { trace_id: 7 },
    { trace_id: "" },
    { trace_id: "  " },
  ]) {
    expect(runTraceEvidence(value, true, forbiddenLink)).toEqual({ id: null, href: null });
  }
  expect(runTraceEvidence({ trace_id: " trace " }, true, link)).toEqual({
    id: " trace ",
    href: "audit: trace ",
  });
  expect(runTraceEvidence({ trace_id: "trace" }, false, forbiddenLink)).toEqual({
    id: "trace",
    href: null,
  });
});
