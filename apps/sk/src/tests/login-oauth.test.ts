import { describe, expect, test } from "bun:test";
import { createHash } from "node:crypto";
import { EngineClient, type FetchLike } from "../engine-client.ts";
import { CLI_LOGIN_SCOPE, runCliOAuthLogin } from "../login-oauth.ts";

const ORIGIN = "https://engine.example.test";

function json(body: unknown, status = 200): Response {
  return new Response(JSON.stringify(body), {
    status,
    headers: { "content-type": "application/json" },
  });
}

function testClient(onRequest?: (url: URL, init: RequestInit) => Response | undefined): {
  client: EngineClient;
  paths: string[];
  tokenRequest: URLSearchParams | null;
  revoked: string[];
} {
  const paths: string[] = [];
  const revoked: string[] = [];
  let tokenRequest: URLSearchParams | null = null;
  const fetchImpl: FetchLike = async (input, init = {}) => {
    const url = new URL(String(input));
    paths.push(url.pathname);
    const overridden = onRequest?.(url, init);
    if (overridden) return overridden;
    if (url.pathname === "/.well-known/oauth-protected-resource/v1/identity/cli-session") {
      return json({
        resource: `${ORIGIN}/v1/identity/cli-session`,
        authorization_servers: [ORIGIN],
        scopes_supported: [CLI_LOGIN_SCOPE],
      });
    }
    if (url.pathname === "/.well-known/oauth-authorization-server") {
      return json({
        issuer: ORIGIN,
        authorization_endpoint: `${ORIGIN}/v1/oauth/authorize`,
        token_endpoint: `${ORIGIN}/v1/oauth/token`,
        registration_endpoint: `${ORIGIN}/v1/oauth/register`,
        revocation_endpoint: `${ORIGIN}/v1/oauth/revoke`,
        response_types_supported: ["code"],
        grant_types_supported: ["authorization_code", "refresh_token"],
        code_challenge_methods_supported: ["S256"],
        token_endpoint_auth_methods_supported: ["none"],
        scopes_supported: ["mcp:read", CLI_LOGIN_SCOPE],
      });
    }
    if (url.pathname === "/v1/oauth/register") {
      const body = JSON.parse(String(init.body)) as { redirect_uris: string[]; scope: string };
      expect(body.scope).toBe(CLI_LOGIN_SCOPE);
      return json(
        {
          client_id: "registered-cli-client",
          redirect_uris: body.redirect_uris,
          grant_types: ["authorization_code", "refresh_token"],
          token_endpoint_auth_method: "none",
          scope: CLI_LOGIN_SCOPE,
        },
        201,
      );
    }
    if (url.pathname === "/v1/oauth/token") {
      tokenRequest = new URLSearchParams(String(init.body));
      return json({
        access_token: "wf_mcp_cli_access_token_value",
        refresh_token: "wf_mcr_cli_refresh_token_value",
        token_type: "bearer",
        expires_in: 300,
        scope: CLI_LOGIN_SCOPE,
      });
    }
    if (url.pathname === "/v1/identity/cli-session") {
      expect(new Headers(init.headers).get("authorization")).toBe(
        "Bearer wf_mcp_cli_access_token_value",
      );
      return json({
        api_key: "wf_live_personal_cli_key_value",
        principal_id: "00000000-0000-4000-8000-000000000001",
        context_id: "00000000-0000-4000-8000-000000000002",
        email: "operator@example.test",
      });
    }
    if (url.pathname === "/v1/oauth/revoke") {
      revoked.push(new URLSearchParams(String(init.body)).get("token") ?? "");
      return new Response(null, { status: 200 });
    }
    return json({ error: "not_found" }, 404);
  };
  const state = {
    client: new EngineClient({ engine_url: ORIGIN, api_key: "", fetchImpl }),
    paths,
    get tokenRequest() {
      return tokenRequest;
    },
    revoked,
  };
  return state;
}

describe("runCliOAuthLogin", () => {
  test("uses standard metadata, DCR, PKCE and the dedicated resource without provider discovery", async () => {
    const fixture = testClient();
    let authorizationUrl: URL | null = null;
    const result = await runCliOAuthLogin({
      engineUrl: ORIGIN,
      client: fixture.client,
      openBrowser: async (raw) => {
        authorizationUrl = new URL(raw);
        const callback = authorizationUrl.searchParams.get("redirect_uri");
        const state = authorizationUrl.searchParams.get("state");
        if (!callback || !state) throw new Error("authorization URL is incomplete");
        const response = await fetch(`${callback}?code=one-time-code&state=${state}`);
        expect(response.status).toBe(200);
      },
    });

    expect(result.api_key).toBe("wf_live_personal_cli_key_value");
    expect(fixture.paths).not.toContain("/v1/identity/providers");
    expect(authorizationUrl).not.toBeNull();
    const auth = authorizationUrl as unknown as URL;
    expect(auth.searchParams.get("scope")).toBe(CLI_LOGIN_SCOPE);
    expect(auth.searchParams.get("resource")).toBe(`${ORIGIN}/v1/identity/cli-session`);
    expect(auth.searchParams.get("code_challenge_method")).toBe("S256");
    const verifier = fixture.tokenRequest?.get("code_verifier") ?? "";
    expect(createHash("sha256").update(verifier).digest("base64url")).toBe(
      auth.searchParams.get("code_challenge") ?? "",
    );
    expect(fixture.tokenRequest?.get("code")).toBe("one-time-code");
    expect(fixture.revoked.sort()).toEqual(
      ["wf_mcp_cli_access_token_value", "wf_mcr_cli_refresh_token_value"].sort(),
    );
  });

  test("rejects a callback with the wrong state before exchanging a code", async () => {
    const fixture = testClient();
    await expect(
      runCliOAuthLogin({
        engineUrl: ORIGIN,
        client: fixture.client,
        openBrowser: async (raw) => {
          const callback = new URL(raw).searchParams.get("redirect_uri");
          if (!callback) throw new Error("missing callback");
          const response = await fetch(`${callback}?code=attacker-code&state=wrong-state`);
          expect(response.status).toBe(400);
        },
      }),
    ).rejects.toThrow("state mismatch");
    expect(fixture.paths).not.toContain("/v1/oauth/token");
  });

  test("rejects cross-origin authorization-server endpoints", async () => {
    const fixture = testClient((url) => {
      if (url.pathname !== "/.well-known/oauth-authorization-server") return undefined;
      return json({
        issuer: ORIGIN,
        authorization_endpoint: "https://attacker.example.test/authorize",
        token_endpoint: `${ORIGIN}/v1/oauth/token`,
        registration_endpoint: `${ORIGIN}/v1/oauth/register`,
        revocation_endpoint: `${ORIGIN}/v1/oauth/revoke`,
        response_types_supported: ["code"],
        grant_types_supported: ["authorization_code"],
        code_challenge_methods_supported: ["S256"],
        token_endpoint_auth_methods_supported: ["none"],
        scopes_supported: [CLI_LOGIN_SCOPE],
      });
    });
    await expect(runCliOAuthLogin({ engineUrl: ORIGIN, client: fixture.client })).rejects.toThrow(
      "unexpected /v1/oauth/authorize endpoint",
    );
    expect(fixture.paths).not.toContain("/v1/oauth/register");
  });
});
