// MCP catalog visibility — RBAC-derived snapshot.
//
// The `tools/list` payload shape varies by the principal's role:
// subkit narrows the surface based on `mcp:admin` / `mcp:authoring`
// scopes derived from RBAC roles rather than exposing the full tool
// palette to every API key. This test pins the resolution + flag
// matrix so a future change can't silently widen the catalog for
// product-tier callers.

import { describe, expect, test } from "bun:test";
import type { ResolvedPrincipal } from "../auth/types.ts";
import { modeFlags, resolveMcpMode } from "./mode-resolver.ts";

function principal(scopes: string[]): ResolvedPrincipal {
  return {
    id: "00000000-0000-0000-0000-000000000000",
    type: "api_key",
    tenant_id: "00000000-0000-0000-0000-000000000001",
    scopes,
    permissions: [],
    role_ids: [],
    actor_kind: "api_key",
    description: null,
    metadata: null,
    expires_at: null,
  } as unknown as ResolvedPrincipal;
}

describe("MCP catalog visibility · resolveMcpMode", () => {
  test("default principal (no scopes) resolves to product mode", () => {
    expect(resolveMcpMode(principal([]))).toBe("product");
  });

  test("`mcp:authoring` scope resolves to authoring mode", () => {
    expect(resolveMcpMode(principal(["mcp:authoring"]))).toBe("authoring");
  });

  test("`mcp:admin` scope wins over `mcp:authoring`", () => {
    expect(resolveMcpMode(principal(["mcp:authoring", "mcp:admin"]))).toBe("admin");
  });
});

describe("MCP catalog visibility · modeFlags", () => {
  test("product mode hides conversation + tenant tools", () => {
    expect(modeFlags("product", false)).toEqual({
      showProductTools: true,
      showConversationTools: false,
      showTenantReads: false,
      showTenantWrites: false,
    });
  });

  test("authoring mode adds conversation + tenant reads, never tenant writes", () => {
    expect(modeFlags("authoring", false)).toEqual({
      showProductTools: true,
      showConversationTools: true,
      showTenantReads: true,
      showTenantWrites: false,
    });
  });

  test("admin mode adds tenant writes when read-only is off", () => {
    expect(modeFlags("admin", false)).toEqual({
      showProductTools: true,
      showConversationTools: true,
      showTenantReads: true,
      showTenantWrites: true,
    });
  });

  test("admin mode under SK_MCP_READ_ONLY=1 keeps tenant reads, drops writes", () => {
    expect(modeFlags("admin", true)).toEqual({
      showProductTools: true,
      showConversationTools: true,
      showTenantReads: true,
      showTenantWrites: false,
    });
  });
});

describe("MCP catalog visibility · per-mode is strict superset", () => {
  // Snapshot-style: every flag that's true in `product` is also true
  // in `authoring`, and every flag that's true in `authoring` is also
  // true in `admin`. The catalog is monotonic in privilege.
  test("authoring is a superset of product", () => {
    const product = modeFlags("product", false);
    const authoring = modeFlags("authoring", false);
    for (const key of Object.keys(product) as Array<keyof typeof product>) {
      if (product[key] === true) expect(authoring[key]).toBe(true);
    }
  });

  test("admin is a superset of authoring", () => {
    const authoring = modeFlags("authoring", false);
    const admin = modeFlags("admin", false);
    for (const key of Object.keys(authoring) as Array<keyof typeof authoring>) {
      if (authoring[key] === true) expect(admin[key]).toBe(true);
    }
  });
});
