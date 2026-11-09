import { expect, test } from "bun:test";
import fc from "fast-check";
import { decideAdministratorChange } from "./administrators.ts";

test("retaining administrator access needs no database snapshot", () => {
  expect(decideAdministratorChange("u", "admin", null)).toEqual({ kind: "allowed" });
  expect(decideAdministratorChange("u", "viewer", null)).toEqual({ kind: "needs_active_users" });
});

test("rejects only removal of the last active administrator", () => {
  const admin = Object.freeze({ id: "u", assigned: "admin" });
  expect(decideAdministratorChange("u", null, Object.freeze([admin]))).toEqual({
    kind: "rejected",
    reason: "last_admin",
  });
  expect(
    decideAdministratorChange("u", "viewer", [admin, { id: "other", assigned: "viewer" }]),
  ).toEqual({ kind: "rejected", reason: "last_admin" });
  expect(decideAdministratorChange("u", null, [admin, { id: "other", assigned: "admin" }])).toEqual(
    { kind: "allowed" },
  );
  expect(decideAdministratorChange("missing", null, [admin])).toEqual({ kind: "allowed" });
  expect(decideAdministratorChange("u", null, [{ id: "u", assigned: null }])).toEqual({
    kind: "allowed",
  });
  expect(decideAdministratorChange("u", null, [])).toEqual({ kind: "allowed" });
});

test("unrelated non-admin users cannot change the last-admin decision", () => {
  fc.assert(
    fc.property(fc.array(fc.string().filter((id) => id !== "target")), (ids) => {
      const users = Object.freeze(
        [{ id: "target", assigned: "admin" }, ...ids.map((id) => ({ id, assigned: "viewer" }))].map(
          (user) => Object.freeze(user),
        ),
      );
      expect(decideAdministratorChange("target", "viewer", users)).toEqual({
        kind: "rejected",
        reason: "last_admin",
      });
    }),
    { seed: 20261109, numRuns: 100 },
  );
});
