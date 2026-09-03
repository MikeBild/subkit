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
    // `browser_session` is unconditional and last: it reads only the
    // `subkit_session` cookie, so it costs a token-bearing caller nothing and
    // cannot shadow one. Without it a human who just signed in through the login
    // funnel was anonymous to every route on an api_key-only deployment — which
    // is what left `granted_by_user_id` NULL on every approval in production.
    expect(names(auth)).toEqual([
      "mcp_oauth",
      "portal_token",
      "token_exchange",
      "api_key",
      "browser_session",
    ]);
  });

  test("configured OIDC adapters are registered by id", () => {
    const auth = authWith([
      { protocol: "api_key", id: "api-key", label: "SubKit API key" },
      {
        protocol: "oidc",
        id: "partner",
        label: "Partner",
        issuer_url: "https://partner.example.com",
        client_id: "subkit",
        scopes: "openid profile email",
        tenant_slug: "default",
      },
    ]);
    expect(names(auth)).toEqual([
      "mcp_oauth",
      "portal_token",
      "token_exchange",
      "api_key",
      "partner",
      "browser_session",
    ]);
  });

  test("disabling MCP OAuth drops only its bearer adapter", () => {
    const auth = authWith([{ protocol: "api_key", id: "api-key", label: "SubKit API key" }], false);
    expect(names(auth)).toEqual(["portal_token", "token_exchange", "api_key", "browser_session"]);
  });
});
