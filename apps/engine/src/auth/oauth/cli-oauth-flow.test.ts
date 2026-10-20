import { afterAll, beforeAll, describe, expect, test } from "bun:test";
import { and, eq } from "drizzle-orm";
import type { Db } from "../../db/client.ts";
import { apiKeys } from "../../db/schema/index.ts";
import { TEST_DB_HOOK_TIMEOUT } from "../../db/tests/setup.ts";
import type { HttpTestServer } from "../../http/tests/setup.ts";
import { createApiKeyProvider } from "../providers/api-key.ts";
import {
  CODE_CHALLENGE,
  CODE_VERIFIER,
  mintSessionCookie,
  seedSession,
  setupMcpOauthServer,
  teardownMcpOauthServer,
} from "./mcp-oauth-test-helpers.ts";

let ctx: HttpTestServer;
let db: Db;
let priorBaseUrl = "";
const resource = "https://test.example.com/v1/identity/cli-session";

beforeAll(async () => {
  const setup = await setupMcpOauthServer("cli-oauth-flow");
  ctx = setup.ctx;
  db = ctx.db;
  priorBaseUrl = setup.priorBaseUrl;
}, TEST_DB_HOOK_TIMEOUT);

afterAll(async () => {
  if (ctx) await teardownMcpOauthServer(ctx, priorBaseUrl);
}, TEST_DB_HOOK_TIMEOUT);

describe("CLI OAuth authorization-code flow", () => {
  test("mints a one-time CLI credential without exposing provider discovery", async () => {
    const redirectUri = "http://127.0.0.1:49152/callback";
    const registration = await fetch(`${ctx.baseUrl}/v1/oauth/register`, {
      method: "POST",
      headers: { "content-type": "application/json" },
      body: JSON.stringify({
        redirect_uris: [redirectUri],
        client_name: "SubKit CLI test",
        grant_types: ["authorization_code", "refresh_token"],
        token_endpoint_auth_method: "none",
        scope: "sk:login",
        software_id: "subkit-sk",
      }),
    });
    expect(registration.status).toBe(201);
    const { client_id: clientId } = (await registration.json()) as { client_id: string };

    const sessionId = await seedSession(db, ctx.tenantId, ctx.userId);
    const cookie = await mintSessionCookie({
      session_id: sessionId,
      user_id: ctx.userId,
      tenant_id: ctx.tenantId,
    });
    const authorize = await fetch(
      `${ctx.baseUrl}/v1/oauth/authorize?${new URLSearchParams({
        client_id: clientId,
        redirect_uri: redirectUri,
        response_type: "code",
        code_challenge: CODE_CHALLENGE,
        code_challenge_method: "S256",
        scope: "sk:login mcp:admin",
        resource,
        state: "cli-state",
      })}`,
      { headers: { cookie: `subkit_session=${cookie}` }, redirect: "manual" },
    );
    expect(authorize.status).toBe(200);
    const html = await authorize.text();
    expect(html).toContain('value="sk:login"');
    expect(html).not.toContain('value="mcp:admin"');
    const csrfToken = html.match(/name="csrf_token"\s+value="([^"]+)"/)?.[1];
    if (!csrfToken) throw new Error("consent page omitted CSRF token");

    const decision = await fetch(`${ctx.baseUrl}/v1/oauth/authorize/decision`, {
      method: "POST",
      headers: {
        "content-type": "application/x-www-form-urlencoded",
        cookie: `subkit_session=${cookie}`,
      },
      body: new URLSearchParams({
        csrf_token: csrfToken,
        client_id: clientId,
        redirect_uri: redirectUri,
        resource,
        state: "cli-state",
        scope: "sk:login",
        decision: "approve",
      }).toString(),
      redirect: "manual",
    });
    expect(decision.status).toBe(302);
    const location = decision.headers.get("location");
    if (!location) throw new Error("consent did not redirect");
    const code = new URL(location).searchParams.get("code");
    if (!code) throw new Error("consent redirect omitted code");

    const tokenResponse = await fetch(`${ctx.baseUrl}/v1/oauth/token`, {
      method: "POST",
      headers: { "content-type": "application/x-www-form-urlencoded" },
      body: new URLSearchParams({
        grant_type: "authorization_code",
        code,
        code_verifier: CODE_VERIFIER,
        redirect_uri: redirectUri,
        client_id: clientId,
      }).toString(),
    });
    expect(tokenResponse.status).toBe(200);
    const tokens = (await tokenResponse.json()) as {
      access_token: string;
      refresh_token: string;
      scope: string;
    };
    expect(tokens.scope).toBe("sk:login");

    const exchange = await fetch(`${ctx.baseUrl}/v1/identity/cli-session`, {
      method: "POST",
      headers: { authorization: `Bearer ${tokens.access_token}`, "user-agent": "sk-cli/test" },
    });
    expect(exchange.status).toBe(200);
    const credential = (await exchange.json()) as { api_key: string; context_id: string };
    expect(credential.api_key).toMatch(/^wf_live_/);
    expect(credential.context_id).toBe(ctx.tenantId);
    const [issued] = await db
      .select({ id: apiKeys.id, credential_origin: apiKeys.credential_origin })
      .from(apiKeys)
      .where(
        and(
          eq(apiKeys.tenant_id, ctx.tenantId),
          eq(apiKeys.prefix, credential.api_key.slice(0, 12)),
        ),
      );
    expect(issued?.credential_origin).toBe("cli_oauth_session");
    const principal = await createApiKeyProvider({ db }).resolve(
      new Request(`${ctx.baseUrl}/v1/identity/me`, {
        headers: { authorization: `Bearer ${credential.api_key}` },
      }),
    );
    expect(principal?.credential_origin).toBe("cli_oauth_session");
    expect(principal?.api_key_id).toBe(issued?.id);
    await expect(
      db
        .update(apiKeys)
        .set({ credential_origin: null })
        .where(and(eq(apiKeys.tenant_id, ctx.tenantId), eq(apiKeys.id, issued?.id ?? "")))
        .execute(),
    ).rejects.toMatchObject({ cause: { code: "23514" } });

    const replay = await fetch(`${ctx.baseUrl}/v1/identity/cli-session`, {
      method: "POST",
      headers: { authorization: `Bearer ${tokens.access_token}` },
    });
    expect(replay.status).toBe(401);

    const refresh = await fetch(`${ctx.baseUrl}/v1/oauth/token`, {
      method: "POST",
      headers: { "content-type": "application/x-www-form-urlencoded" },
      body: new URLSearchParams({
        grant_type: "refresh_token",
        refresh_token: tokens.refresh_token,
        client_id: clientId,
      }).toString(),
    });
    expect(refresh.status).toBe(400);
  });
});
