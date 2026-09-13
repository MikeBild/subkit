import { describe, expect, test } from "bun:test";

import { HttpConnectorConfig } from "../types.ts";

describe("HttpConnectorConfig — nested oauth shape", () => {
  test("accepts a nested config.oauth block with documented fields", () => {
    const r = HttpConnectorConfig.safeParse({
      oauth: {
        issuer_url: "https://github.com",
        token_endpoint: "https://github.com/login/oauth/access_token",
        authorization_endpoint: "https://github.com/login/oauth/authorize",
        scope: "repo,read:org",
        grant_type: "authorization_code",
        token_auth_method: "body",
        token_content_type: "form",
        use_pkce: false,
        client_id: null,
      },
    });
    expect(r.success).toBe(true);
  });

  test("accepts an empty config (no oauth block) — bearer/none/etc.", () => {
    const r = HttpConnectorConfig.safeParse({});
    expect(r.success).toBe(true);
  });

  test("rejects flat oauth fields at the top level (post-migration)", () => {
    const r = HttpConnectorConfig.safeParse({
      issuer_url: "https://github.com",
      token_endpoint: "https://github.com/login/oauth/access_token",
    });
    expect(r.success).toBe(false);
  });

  test("rejects unknown keys inside config.oauth (.strict() at oauth)", () => {
    const r = HttpConnectorConfig.safeParse({
      oauth: { not_a_field: "x" },
    });
    expect(r.success).toBe(false);
  });

  test("oauth.client_id may be null (templates seed null when client_id is per-tenant)", () => {
    const r = HttpConnectorConfig.safeParse({
      oauth: { client_id: null },
    });
    expect(r.success).toBe(true);
  });

  test("accepts cognito_user_password grant_type", () => {
    const r = HttpConnectorConfig.safeParse({
      oauth: { grant_type: "cognito_user_password" },
    });
    expect(r.success).toBe(true);
  });
});
