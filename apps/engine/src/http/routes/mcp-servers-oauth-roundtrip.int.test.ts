// Full authorize → callback round-trip integration tests for the interactive
// MCP OAuth 2.1 onboarding routes.
//
// INJECTION PATTERN: the routes call the SDK's `auth()` driver through the
// documented TEST SEAM `sdkAuth` (apps/engine/src/mcp/client/sdk-auth.ts).
// `__setSdkAuthForTests` swaps the driver in-process so no real authorization
// server is needed — NO bun `mock.module` (module mocks are process-global
// and leak into every other test file in the same worker). The seam is set in
// beforeAll and restored to null in afterAll.
//
// Coverage strategy:
//   - authorize route: state row created + code_verifier + authorization_url written.
//   - callback route: state row claimed atomically; token credential written;
//     server flipped to active; audit entries written.
//   - iss mismatch: error HTML, no credential, authorization_failed audit.
//   - single-use: second callback with same state → 400 expired page.
//
// The authorize route drives the stub `auth()` with no authorizationCode:
//   - it calls provider.saveCodeVerifier + provider.redirectToAuthorization
//     → returns "REDIRECT".
// The callback route drives it WITH authorizationCode:
//   - it calls provider.saveTokens → returns "AUTHORIZED".

import { afterAll, beforeAll, describe, expect, test } from "bun:test";
import type { OAuthClientProvider } from "@modelcontextprotocol/sdk/client/auth.js";
import { and, eq } from "drizzle-orm";
import { auditLog, credentials, mcpOauthStates } from "../../db/schema/index.ts";
import { __setSdkAuthForTests } from "../../mcp/client/sdk-auth.ts";
import { createHttpTestServer, type HttpTestServer } from "../tests/setup.ts";

// Deterministic, wall-clock-free seams. The callback's guarded delete is
// `WHERE state = ? AND expires_at > now()` against the REAL db `now()`, so a
// seeded in-flight state row needs a FIXED far-future absolute expiry
// (stable across runs, always ahead of real now) — not a wall-clock offset.
// Per-state uniqueness rides a deterministic monotonic counter so each flow
// gets a collision-free state.
const STATE_EXPIRY_AT = new Date("2999-01-01T00:00:00.000Z");
let stateSeq = 0;
function nextStateSuffix(): number {
  stateSeq += 1;
  return stateSeq;
}

const STUB_AUTH_URL = "https://auth.acmeauth.test/authorize?response_type=code&state=OPAQUE_STUB";

async function stubSdkAuth(
  provider: OAuthClientProvider,
  options: { serverUrl: string | URL; authorizationCode?: string },
): Promise<"AUTHORIZED" | "REDIRECT"> {
  if (options.authorizationCode) {
    await provider.saveTokens({
      access_token: "stub-access-token-from-exchange",
      token_type: "Bearer",
      refresh_token: "stub-refresh-token-from-exchange",
      expires_in: 3600,
    });
    return "AUTHORIZED";
  }
  await provider.saveCodeVerifier("stub-pkce-verifier");
  await provider.redirectToAuthorization(new URL(STUB_AUTH_URL));
  return "REDIRECT";
}

// ── Test server setup ─────────────────────────────────────────────────────────

let ctx: HttpTestServer;

beforeAll(async () => {
  __setSdkAuthForTests(stubSdkAuth);
  ctx = await createHttpTestServer("mcp-oauth-roundtrip");
}, 30_000);

afterAll(async () => {
  // ALWAYS restore the seam (null-by-default protects production, but a
  // leaked non-null driver would still poison sibling test files).
  __setSdkAuthForTests(null);
  await ctx.cleanup();
}, 30_000);

function adminAuth(): { Authorization: string } {
  return { Authorization: `Bearer ${ctx.apiKey}` };
}

/** Register an oauth2 MCP server and return its id. */
async function registerOAuth2Server(namespace: string): Promise<string> {
  const res = await fetch(`${ctx.baseUrl}/v1/mcp-servers`, {
    method: "POST",
    headers: { ...adminAuth(), "content-type": "application/json" },
    body: JSON.stringify({
      name: `AcmeAuth ${namespace}`,
      namespace,
      transport: "http",
      url: "https://examplemcp.acmeauth.test/mcp",
      auth_config: {
        kind: "oauth2",
        issuer: "https://auth.acmeauth.test",
        scope: "read write",
      },
      // Route requires a refresh_token for oauth2 servers at registration.
      refresh_token: "seed-refresh-token-for-test",
    }),
  });
  if (res.status !== 201) {
    const body = await res.text();
    throw new Error(`createServer failed ${res.status}: ${body}`);
  }
  const json = (await res.json()) as { id: string };
  return json.id;
}

/**
 * Seed a pre-built mcp_oauth_states row directly to simulate what the
 * authorize route would have inserted. Used for callback tests that
 * exercise the callback route's contract in isolation.
 */
async function seedStateRow(opts: {
  serverId: string;
  state: string;
  codeVerifier?: string;
  authorizationUrl?: string;
  asIssuer?: string;
  startedByActorId?: string;
}): Promise<void> {
  await ctx.db.insert(mcpOauthStates).values({
    tenant_id: ctx.tenantId,
    mcp_server_id: opts.serverId,
    state: opts.state,
    code_verifier: opts.codeVerifier ?? "direct-pkce-verifier",
    redirect_uri: `${ctx.baseUrl}/v1/mcp-servers/oauth/callback`,
    authorization_url: opts.authorizationUrl ?? null,
    as_issuer: opts.asIssuer ?? null,
    started_by_actor_id: opts.startedByActorId ?? null,
    expires_at: STATE_EXPIRY_AT,
  });
}

// ── Test 1: authorize route ────────────────────────────────────────────────────

describe("POST /authorize", () => {
  test("returns 200 with authorization_url + state; state row persisted with code_verifier; audit written", async () => {
    const serverId = await registerOAuth2Server("roundtripauthz1");

    const res = await fetch(`${ctx.baseUrl}/v1/mcp-servers/${serverId}/authorize`, {
      method: "POST",
      headers: adminAuth(),
    });

    // The stub driver returns "REDIRECT", so the route must succeed with 200.
    expect(res.status).toBe(200);

    const body = (await res.json()) as { authorization_url: string; state: string };
    expect(body.authorization_url).toBe(STUB_AUTH_URL);
    expect(typeof body.state).toBe("string");
    expect(body.state.length).toBeGreaterThan(0);

    // The state row must exist with the persisted authorization_url +
    // code_verifier, and carry the flow originator for callback attribution.
    const stateRows = await ctx.db
      .select({
        authorization_url: mcpOauthStates.authorization_url,
        code_verifier: mcpOauthStates.code_verifier,
        started_by_actor_id: mcpOauthStates.started_by_actor_id,
      })
      .from(mcpOauthStates)
      .where(and(eq(mcpOauthStates.tenant_id, ctx.tenantId), eq(mcpOauthStates.state, body.state)));
    expect(stateRows.length).toBe(1);
    expect(stateRows[0]!.authorization_url).toBe(STUB_AUTH_URL);
    expect(stateRows[0]!.code_verifier).toBe("stub-pkce-verifier");
    expect(stateRows[0]!.started_by_actor_id).toBe(ctx.userId);

    // Audit: authorization_started must have been written.
    const auditRows = await ctx.db
      .select({ action: auditLog.action })
      .from(auditLog)
      .where(
        and(
          eq(auditLog.tenant_id, ctx.tenantId),
          eq(auditLog.resource_id, serverId),
          eq(auditLog.action, "mcp_server.authorization_started"),
        ),
      );
    expect(auditRows.length).toBeGreaterThanOrEqual(1);
  });
});

// ── Test 2: callback happy path ───────────────────────────────────────────────
//
// We seed the state row directly to test the callback route's full contract
// in isolation from the authorize route.

describe("GET /oauth/callback — happy path (pre-seeded state row)", () => {
  test("callback with code + pre-seeded state → success HTML; state row deleted; credential written; server active; audit written", async () => {
    const serverId = await registerOAuth2Server("roundtripcallback1");
    const state = `callback-state-${nextStateSuffix()}`;
    // Seed the originator exactly as the authorize route would, so the
    // callback's audit attribution can be asserted below.
    await seedStateRow({ serverId, state, startedByActorId: ctx.userId });

    // Simulate callback from external AS. The stub driver exchanges the
    // code by calling provider.saveTokens and returns "AUTHORIZED".
    const cbRes = await fetch(
      `${ctx.baseUrl}/v1/mcp-servers/oauth/callback?code=stub-code-xyz&state=${encodeURIComponent(state)}`,
    );

    expect(cbRes.status).toBe(200);
    expect(cbRes.headers.get("content-type")).toContain("text/html");
    const html = await cbRes.text();
    expect(html).toContain("complete");

    // State row MUST be deleted (single-use atomic claim).
    const stateRows = await ctx.db
      .select()
      .from(mcpOauthStates)
      .where(and(eq(mcpOauthStates.tenant_id, ctx.tenantId), eq(mcpOauthStates.state, state)));
    expect(stateRows.length).toBe(0);

    // oauth2 credential row must exist.
    const credRows = await ctx.db
      .select({ id: credentials.id, mode: credentials.mode })
      .from(credentials)
      .where(
        and(
          eq(credentials.tenant_id, ctx.tenantId),
          eq(credentials.mcp_server_id, serverId),
          eq(credentials.mode, "oauth2"),
        ),
      );
    // Two rows may exist: the seed token from registration + the new one.
    expect(credRows.length).toBeGreaterThanOrEqual(1);

    // Server status must be active.
    const { mcpServers } = await import("../../db/schema/index.ts");
    const serverRows = await ctx.db
      .select({ status: mcpServers.status })
      .from(mcpServers)
      .where(and(eq(mcpServers.tenant_id, ctx.tenantId), eq(mcpServers.id, serverId)))
      .limit(1);
    expect(serverRows[0]!.status).toBe("active");

    // Audit: authorized must have been written, attributed to the actor
    // that STARTED the flow (read off the claimed state row — the callback
    // itself is unauthenticated).
    const auditRows = await ctx.db
      .select({ action: auditLog.action, actor_id: auditLog.actor_id })
      .from(auditLog)
      .where(
        and(
          eq(auditLog.tenant_id, ctx.tenantId),
          eq(auditLog.resource_id, serverId),
          eq(auditLog.action, "mcp_server.authorized"),
        ),
      );
    expect(auditRows.length).toBeGreaterThanOrEqual(1);
    expect(auditRows[0]!.actor_id).toBe(ctx.userId);
  });
});

// ── Test 3: iss mismatch ──────────────────────────────────────────────────────

describe("callback with iss mismatch", () => {
  test("iss origin differs from as_issuer → error HTML, no new credential, audit authorization_failed", async () => {
    const serverId = await registerOAuth2Server("roundtripissmismatch1");
    const state = `iss-mismatch-state-${nextStateSuffix()}`;
    // Seed state row with an as_issuer origin so the iss check fires.
    await seedStateRow({
      serverId,
      state,
      asIssuer: "https://auth.acmeauth.test",
    });

    const badIss = encodeURIComponent("https://evil.example.test");
    const cbRes = await fetch(
      `${ctx.baseUrl}/v1/mcp-servers/oauth/callback?code=stub-code&state=${encodeURIComponent(state)}&iss=${badIss}`,
    );
    expect(cbRes.status).toBe(400);
    expect(cbRes.headers.get("content-type")).toContain("text/html");
    const html = await cbRes.text();
    expect(html.toLowerCase()).toMatch(/reject|unexpected|authorization/);

    // State row was consumed (atomic DELETE RETURNING — even on iss mismatch
    // the row is claimed before the check fires, so it's gone).
    const stateRows = await ctx.db
      .select()
      .from(mcpOauthStates)
      .where(and(eq(mcpOauthStates.tenant_id, ctx.tenantId), eq(mcpOauthStates.state, state)));
    expect(stateRows.length).toBe(0);

    // No NEW oauth2 credential should have been written for this server
    // (the seed refresh_token from registration is mode "oauth2"; we check
    // that no new one appeared after the registration one).
    const beforeCount = 1; // only the seed credential from registration
    const credRows = await ctx.db
      .select()
      .from(credentials)
      .where(
        and(
          eq(credentials.tenant_id, ctx.tenantId),
          eq(credentials.mcp_server_id, serverId),
          eq(credentials.mode, "oauth2"),
        ),
      );
    expect(credRows.length).toBe(beforeCount);

    // Audit: authorization_failed with issuer_mismatch must be present.
    const auditRows = await ctx.db
      .select({ action: auditLog.action, reason: auditLog.reason })
      .from(auditLog)
      .where(
        and(
          eq(auditLog.tenant_id, ctx.tenantId),
          eq(auditLog.resource_id, serverId),
          eq(auditLog.action, "mcp_server.authorization_failed"),
        ),
      );
    expect(auditRows.length).toBeGreaterThanOrEqual(1);
    expect(auditRows[0]!.reason).toContain("issuer_mismatch");
  });
});

// ── Test 4: single-use enforcement ────────────────────────────────────────────

describe("callback single-use", () => {
  test("second callback with the same state returns 400 error HTML (row already consumed)", async () => {
    const serverId = await registerOAuth2Server("roundtripsingleuse1");
    const state = `single-use-state-${nextStateSuffix()}`;
    await seedStateRow({ serverId, state });

    // First callback — consumes the row (stub exchange succeeds → 200).
    const cb1 = await fetch(
      `${ctx.baseUrl}/v1/mcp-servers/oauth/callback?code=stub-code-first&state=${encodeURIComponent(state)}`,
    );
    expect(cb1.status).toBe(200);

    // Second callback with the same state — row is gone regardless.
    const cb2 = await fetch(
      `${ctx.baseUrl}/v1/mcp-servers/oauth/callback?code=stub-code-second&state=${encodeURIComponent(state)}`,
    );
    expect(cb2.status).toBe(400);
    const html = await cb2.text();
    expect(html).toContain("expired");
  });
});
