// buildDefaultRegistry registers the always-on machine providers
// (portal_token + api_key, plus mcp_oauth gated on its own server flag) and
// exactly one human identity provider selected by `auth.provider`
// ("subkit" → none, "firebase"/"oidc" → that provider). These tests set the
// provider and assert registry membership. No DB or config loader is needed —
// we pass an explicit `auth` slice and omit the db (providers construct lazily
// and only touch the DB on resolve).

import { describe, expect, test } from "bun:test";
import type { Config } from "../config/schema.ts";
import { ConfigSchema } from "../config/schema.ts";
import { buildDefaultRegistry } from "./server.ts";

// Full, valid `auth` config slice with schema defaults. `database.url` is the
// only required leaf without a default, so we supply a throwaway value purely
// to get past parse and read `.auth`.
function baseAuth(): Config["auth"] {
  return ConfigSchema.parse({
    database: { url: "postgres://u:p@localhost:5432/db" },
  }).auth;
}

function withAuth(overrides: {
  provider?: "subkit" | "firebase" | "oidc";
  mcp_oauth?: boolean;
}): Config["auth"] {
  const auth = baseAuth();
  return {
    ...auth,
    provider: overrides.provider ?? auth.provider,
    mcp_oauth: { ...auth.mcp_oauth, enabled: overrides.mcp_oauth ?? auth.mcp_oauth.enabled },
  };
}

function names(auth: Config["auth"]): string[] {
  return buildDefaultRegistry(undefined, auth)
    .list()
    .map((p) => p.name);
}

describe("buildDefaultRegistry — provider-selected membership", () => {
  test("default provider 'subkit' registers the always-on machine providers only", () => {
    expect(baseAuth().provider).toBe("subkit");
    expect(names(baseAuth())).toEqual(["mcp_oauth", "portal_token", "api_key"]);
  });

  test("provider 'firebase' appends the firebase human provider", () => {
    expect(names(withAuth({ provider: "firebase" }))).toEqual([
      "mcp_oauth",
      "portal_token",
      "api_key",
      "firebase",
    ]);
  });

  test("provider 'oidc' appends the oidc human provider", () => {
    expect(names(withAuth({ provider: "oidc" }))).toEqual([
      "mcp_oauth",
      "portal_token",
      "api_key",
      "oidc",
    ]);
  });

  test("machine api_key + portal_token stay registered under every provider", () => {
    for (const provider of ["subkit", "firebase", "oidc"] as const) {
      const result = names(withAuth({ provider }));
      expect(result).toContain("api_key");
      expect(result).toContain("portal_token");
    }
  });

  test("disabling mcp_oauth drops only it; portal_token + api_key remain always-on", () => {
    expect(names(withAuth({ provider: "subkit", mcp_oauth: false }))).toEqual([
      "portal_token",
      "api_key",
    ]);
  });
});
