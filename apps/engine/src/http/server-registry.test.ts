import { describe, expect, test } from "bun:test";
import type { Config } from "../config/schema.ts";
import { ConfigSchema } from "../config/schema.ts";
import { buildDefaultRegistry } from "./server.ts";

function authWith(providers: Config["auth"]["providers"], mcpOauthEnabled = true): Config["auth"] {
  const auth = ConfigSchema.parse({ database: { url: "postgres://u:p@localhost:5432/db" } }).auth;
  return {
    ...auth,
    providers,
    mcp_oauth: { ...auth.mcp_oauth, enabled: mcpOauthEnabled },
  };
}

function names(auth: Config["auth"]): string[] {
  return buildDefaultRegistry(undefined, auth)
    .list()
    .map((provider) => provider.name);
}

describe("buildDefaultRegistry — provider-neutral membership", () => {
  test("the default keeps the always-on machine providers", () => {
    const auth = authWith([{ protocol: "api_key", id: "api-key", label: "SubKit API key" }]);
    expect(names(auth)).toEqual(["mcp_oauth", "portal_token", "api_key"]);
  });

  test("configured token-bridge and OIDC adapters are registered by id", () => {
    const auth = authWith([
      { protocol: "api_key", id: "api-key", label: "SubKit API key" },
      {
        protocol: "token_bridge",
        id: "workforce",
        label: "Workforce",
        login_url: "https://login.example.com/subkit",
        issuer_url: "https://issuer.example.com",
        audience: "subkit",
        jwks_url: "https://issuer.example.com/jwks",
        tenant_slug: "default",
        subject_claim: "sub",
        email_claim: "email",
        email_verified_claim: "email_verified",
      },
      {
        protocol: "oidc",
        id: "partner",
        label: "Partner",
        issuer_url: "https://partner.example.com",
        client_id: "subkit",
        client_secret: "",
        scopes: "openid profile email",
        tenant_slug: "default",
      },
    ]);
    expect(names(auth)).toEqual(["mcp_oauth", "portal_token", "api_key", "workforce", "partner"]);
  });

  test("disabling MCP OAuth drops only its bearer adapter", () => {
    const auth = authWith([{ protocol: "api_key", id: "api-key", label: "SubKit API key" }], false);
    expect(names(auth)).toEqual(["portal_token", "api_key"]);
  });
});
