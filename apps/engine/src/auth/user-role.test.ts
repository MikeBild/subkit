import { describe, expect, test } from "bun:test";
import { readFileSync } from "node:fs";
import { hasLegacyRoleDrift, resolveEffectiveUserRole } from "./user-role.ts";

describe("resolveEffectiveUserRole", () => {
  test("uses the assigned RBAC role when legacy data disagrees", () => {
    expect(resolveEffectiveUserRole("admin", "member")).toBe("member");
  });

  test("keeps custom tenant roles canonical", () => {
    expect(resolveEffectiveUserRole("member", "operator")).toBe("operator");
    expect(hasLegacyRoleDrift("member", "operator")).toBe(false);
  });

  test("falls back for users created before the RBAC role backfill", () => {
    expect(resolveEffectiveUserRole("admin", null)).toBe("admin");
  });

  test("reports mismatched built-in roles", () => {
    expect(hasLegacyRoleDrift("admin", "member")).toBe(true);
    expect(hasLegacyRoleDrift("admin", "admin")).toBe(false);
  });

  test("all user authentication providers use the canonical resolver", () => {
    for (const path of [
      "apps/engine/src/auth/providers/oidc.ts",
      "apps/engine/src/auth/providers/browser-session.ts",
      // The api_key provider resolves its owner in api-key-row.ts, shared with
      // the RFC 8693 exchanged token so both credentials take the same path.
      "apps/engine/src/auth/providers/api-key-row.ts",
      "apps/engine/src/auth/providers/mcp-oauth.ts",
    ]) {
      expect(readFileSync(path, "utf8")).toContain("resolveEffectiveUserRole(");
    }
  });
});
