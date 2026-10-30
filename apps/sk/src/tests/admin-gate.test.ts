import { describe, expect, test } from "bun:test";
import { isAdminFromPermissions } from "../settings-ui/lib/admin-gate.ts";

describe("isAdminFromPermissions", () => {
  test("returns true when the principal holds any admin-only permission", () => {
    expect(isAdminFromPermissions(["rbac:read"])).toBe(true);
    expect(isAdminFromPermissions(["rbac:write"])).toBe(true);
    expect(isAdminFromPermissions(["audit:read"])).toBe(true);
    expect(isAdminFromPermissions(["api_key:write"])).toBe(true);
    expect(isAdminFromPermissions(["api_key:rotate"])).toBe(true);
    expect(isAdminFromPermissions(["api_key:revoke"])).toBe(true);
    expect(isAdminFromPermissions(["credential:write"])).toBe(true);
    expect(isAdminFromPermissions(["credential:delete"])).toBe(true);
    expect(isAdminFromPermissions(["discovery:approve"])).toBe(true);
    expect(isAdminFromPermissions(["connector:promote"])).toBe(true);
    expect(isAdminFromPermissions(["system:restart"])).toBe(true);
  });

  test("package export and import are member-scoped and do NOT light up the Admin tab", () => {
    expect(isAdminFromPermissions(["package:export"])).toBe(false);
    expect(isAdminFromPermissions(["package:import"])).toBe(false);
  });

  test("credential:read stays a member-scoped permission and does NOT light up the Admin tab", () => {
    expect(isAdminFromPermissions(["credential:read"])).toBe(false);
  });

  test("returns true when the admin perm is mixed with member-scoped reads", () => {
    expect(
      isAdminFromPermissions([
        "conversation:read",
        "conversation:write",
        "api_key:read",
        "rbac:read",
      ]),
    ).toBe(true);
  });

  test("returns false for the member-scoped permissions that previously over-listed admin", () => {
    expect(isAdminFromPermissions(["api_key:read"])).toBe(false);
    expect(isAdminFromPermissions(["identity:read"])).toBe(false);
    expect(isAdminFromPermissions(["portal_token:read"])).toBe(false);
    expect(isAdminFromPermissions(["api_key:read", "identity:read", "portal_token:read"])).toBe(
      false,
    );
  });

  test("returns false for typical member-only permission bundles", () => {
    expect(
      isAdminFromPermissions([
        "conversation:read",
        "conversation:write",
        "skill:read",
        "knowledge:read",
        "workflow:read",
        "workflow:write",
      ]),
    ).toBe(false);
  });

  test("returns false on an empty permission array", () => {
    expect(isAdminFromPermissions([])).toBe(false);
  });

  test("returns false on unrelated / unknown permissions", () => {
    expect(isAdminFromPermissions(["does.not.exist", "*"])).toBe(false);
  });
});
