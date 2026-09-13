// Verifies the tier-filtered persona probe. Pre-fix both REPLs
// iterated 22 RBAC permissions on every session start, doubling to
// ~44 audit-log `policy.denied` rows for non-admin members.
// Reproduces session bab50df1.

import { describe, expect, it } from "bun:test";

import { ALL_PROBE_PERMISSIONS, probePermissionsForRole } from "../persona-probe.ts";

describe("probePermissionsForRole — tier filtering", () => {
  it("returns only tier-1 permissions for portal/enduser/user", () => {
    for (const role of ["portal", "enduser", "user", null, undefined, "unknown"]) {
      const subset = probePermissionsForRole(role);
      expect(subset).not.toContain("rbac:read");
      expect(subset).not.toContain("audit:read");
      expect(subset).not.toContain("api_key:read");
      expect(subset).not.toContain("workflow:write");
      expect(subset).toContain("conversation:write");
    }
  });

  it("excludes admin-tier permissions for member", () => {
    const subset = probePermissionsForRole("member");
    // ~44 audit rows pre-fix → ~24 post-fix.
    expect(subset).not.toContain("rbac:read");
    expect(subset).not.toContain("audit:read");
    expect(subset).not.toContain("identity:read");
    expect(subset).not.toContain("api_key:read");
    expect(subset).not.toContain("portal_token:read");
    // Member-tier perms still probed.
    expect(subset).toContain("mcp:read");
    expect(subset).toContain("skill:read");
    expect(subset).toContain("conversation:list");
  });

  it("excludes admin-tier permissions but includes operator-tier for operator", () => {
    const subset = probePermissionsForRole("operator");
    expect(subset).not.toContain("rbac:read");
    expect(subset).not.toContain("audit:read");
    // Operator-tier perms probed.
    expect(subset).toContain("workflow:write");
    expect(subset).toContain("connector:read");
    expect(subset).toContain("execution:read");
    // Member-tier perms still probed (operator tier is cumulative).
    expect(subset).toContain("mcp:read");
  });

  it("returns the full set for admin", () => {
    const subset = probePermissionsForRole("admin");
    expect(subset).toContain("rbac:read");
    expect(subset).toContain("audit:read");
    expect(subset).toContain("workflow:write");
    expect(subset).toContain("conversation:write");
    expect(subset.length).toBe(ALL_PROBE_PERMISSIONS.length);
  });

  it("treats role names case-insensitively (engine returns 'Admin' / 'OPERATOR' in some configs)", () => {
    expect(probePermissionsForRole("Admin")).toEqual(probePermissionsForRole("admin"));
    expect(probePermissionsForRole("OPERATOR")).toEqual(probePermissionsForRole("operator"));
  });

  it("ALL_PROBE_PERMISSIONS is a deduplicated superset of every tier", () => {
    const seen = new Set<string>();
    for (const p of ALL_PROBE_PERMISSIONS) {
      expect(seen.has(p)).toBe(false); // no duplicates
      seen.add(p);
    }
    // Every tier's permissions must appear in the master list.
    for (const role of ["admin", "operator", "member", "user"]) {
      for (const p of probePermissionsForRole(role)) {
        expect(ALL_PROBE_PERMISSIONS).toContain(p);
      }
    }
  });
});
