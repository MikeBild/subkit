import { describe, expect, test } from "bun:test";
import { isBuiltinAdmin, isOwner, isOwnerOrAdmin, ownerFactsOf } from "./owner.ts";

describe("owner or admin", () => {
  test("the owner passes", () => {
    expect(isOwnerOrAdmin({ id: "u1", is_admin: false }, "u1")).toBe(true);
  });

  test("an admin passes for any owner, also a missing one", () => {
    expect(isOwnerOrAdmin({ id: "a", is_admin: true }, "u1")).toBe(true);
    expect(isOwnerOrAdmin({ id: "a", is_admin: true }, null)).toBe(true);
  });

  test("someone else does not, and a missing owner never matches", () => {
    expect(isOwnerOrAdmin({ id: "u2", is_admin: false }, "u1")).toBe(false);
    expect(isOwner({ id: "u2" }, null)).toBe(false);
  });

  test("facts come from the built-in admin role", () => {
    expect(ownerFactsOf({ id: "u", roles: ["admin"] })).toEqual({ id: "u", is_admin: true });
    expect(ownerFactsOf({ id: "u" })).toEqual({ id: "u", is_admin: false });
    expect(isBuiltinAdmin(["member"])).toBe(false);
  });
});
