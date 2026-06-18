// Direct unit test for the `isAdminFromPermissions` gate that decides
// whether the `/settings → Admin` tab is visible. Without this test, a
// future contributor who re-broadens `ADMIN_ONLY_PERMISSIONS` to include
// the member-scoped `api_key:read` / `identity:read` / `portal_token:read`
// permissions would re-expose the Admin tab to members silently —
// `SettingsApp` / `SettingsPane` only assert on the `isAdmin` boolean,
// not on which permission set was checked.

import { describe, expect, test } from "bun:test";
import { isAdminFromPermissions } from "../settings-ui/lib/admin-gate.ts";

describe("isAdminFromPermissions", () => {
  test("returns true when the principal holds any admin-only permission", () => {
    // Each of these is a permission the built-in `member` role does
    // NOT carry per `apps/engine/src/rbac/seed.ts:memberPermissionFilter`.
    // The Admin tab must light up for any one of them; the gate mirrors
    // the engine's deny-list.
    expect(isAdminFromPermissions(["rbac:read"])).toBe(true);
    expect(isAdminFromPermissions(["rbac:write"])).toBe(true);
    expect(isAdminFromPermissions(["audit:read"])).toBe(true);
    expect(isAdminFromPermissions(["api_key:write"])).toBe(true);
    expect(isAdminFromPermissions(["api_key:rotate"])).toBe(true);
    expect(isAdminFromPermissions(["api_key:revoke"])).toBe(true);
    expect(isAdminFromPermissions(["credential:write"])).toBe(true);
    expect(isAdminFromPermissions(["credential:delete"])).toBe(true); // prefix match
    expect(isAdminFromPermissions(["discovery:approve"])).toBe(true);
  });

  test("credential:read stays a member-scoped permission and does NOT light up the Admin tab", () => {
    // The engine's deny-list excludes the `credential:` prefix
    // EXCEPT `credential:read`. Mirror that exception here.
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
    // Regression guard: `api_key:read`, `identity:read`,
    // `portal_token:read` are catch-all member reads. A regression that
    // adds any of them back to ADMIN_ONLY_PERMISSIONS would surface the
    // Admin tab to every tenant member.
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
