// Integration tests for the retirement of dead dynamic client registrations.
//
// Production held ~500 registrations against four real applications: a
// deploy verifier registered a new client on every run and never came back.
// Every one of them read "no valid approval", and the real applications —
// and the account connections below them — drowned.
//
// The rule under test: a DCR registration created more than 7 days ago, with
// no valid grant (no live access or refresh token) and no use in 7 days (no
// access token used, no refresh token minted, no authorization code issued),
// is retired — `disabled_at` and `retired_at` set, never deleted. A person
// who later completes an authorization for it brings it back; an
// administrator's revocation stays a revocation.

import { afterAll, beforeAll, describe, expect, test } from "bun:test";
import { createHash, randomBytes } from "node:crypto";
import { and, eq, inArray } from "drizzle-orm";
import { createMcpOAuthProvider } from "../../auth/oauth/server-provider.ts";
import type { Config } from "../../config/schema.ts";
import { auditLog } from "../../db/schema/audit.ts";
import {
  mcpOauthAccessTokens,
  mcpOauthAuthorizationCodes,
  mcpOauthClients,
  mcpOauthRefreshTokens,
} from "../../db/schema/mcp_oauth.ts";
import { createHttpTestServer, type HttpTestServer } from "../../http/tests/setup.ts";
import { runMcpOAuthCleanup } from "../mcp-oauth-cleanup-runner.ts";

let srv: HttpTestServer;

const DAY = 24 * 60 * 60 * 1000;
const at = (offsetMs: number) => new Date(Date.now() + offsetMs); // allow-wall-clock
const OLD = () => at(-10 * DAY);

let seq = 0;
function unique(prefix: string): string {
  seq += 1;
  return `${prefix}-${seq}-${randomBytes(4).toString("hex")}`;
}

async function seedClient(
  values: Partial<typeof mcpOauthClients.$inferInsert> = {},
): Promise<string> {
  const clientId = unique("client");
  await srv.db.insert(mcpOauthClients).values({
    client_id: clientId,
    redirect_uris: ["https://client.example.com/callback"],
    client_name: "Retirement test",
    registration_source: "dcr",
    created_at: OLD(),
    ...values,
  });
  return clientId;
}

async function seedRefresh(
  clientId: string,
  values: Partial<typeof mcpOauthRefreshTokens.$inferInsert> = {},
): Promise<void> {
  await srv.db.insert(mcpOauthRefreshTokens).values({
    tenant_id: srv.tenantId,
    client_id: clientId,
    user_id: srv.userId,
    prefix: unique("rt").slice(0, 12),
    token_sha256: unique("rt-sha"),
    scope: "mcp:read",
    expires_at: at(20 * DAY),
    created_at: OLD(),
    ...values,
  });
}

async function seedAccess(
  clientId: string,
  values: Partial<typeof mcpOauthAccessTokens.$inferInsert> = {},
): Promise<void> {
  await srv.db.insert(mcpOauthAccessTokens).values({
    tenant_id: srv.tenantId,
    client_id: clientId,
    user_id: srv.userId,
    prefix: unique("at").slice(0, 12),
    token_sha256: unique("at-sha"),
    scope: "mcp:read",
    expires_at: at(-9 * DAY),
    created_at: OLD(),
    ...values,
  });
}

async function clientRow(clientId: string) {
  const [row] = await srv.db
    .select()
    .from(mcpOauthClients)
    .where(eq(mcpOauthClients.client_id, clientId));
  if (!row) throw new Error(`client ${clientId} is gone`);
  return row;
}

function makeConfig(): Config {
  return {
    server: { public_base_url: "https://test.example.com", port: 3000, host: "0.0.0.0" },
    auth: {
      mcp_oauth: {
        enabled: true,
        dynamic_registration_enabled: true,
        access_token_ttl_seconds: 3600,
        refresh_token_ttl_seconds: 2592000,
        authorization_code_ttl_seconds: 60,
        scopes_supported: ["mcp:read"],
      },
    },
  } as unknown as Config;
}

const VERIFIER = "dBjftJeZ4CVP-mB92K27uhbUJU1p1r_wW1gFWFOEjXk";
const CHALLENGE = createHash("sha256").update(VERIFIER).digest("base64url");

beforeAll(async () => {
  srv = await createHttpTestServer("mcp-oauth-retire");
}, 60_000);

afterAll(async () => {
  await srv.cleanup();
}, 30_000);

describe("retiring dead dynamic registrations", () => {
  test("a registration nobody holds a grant for and nobody used in a week is retired, not deleted", async () => {
    // The deploy verifier's shape: registered, authorized once, token long expired.
    const dead = await seedClient({ client_name: "Deploy verify" });
    await seedAccess(dead, { expires_at: at(-9 * DAY), last_used_at: at(-9 * DAY) });
    const bare = await seedClient({ client_name: "Deploy verify" });

    await runMcpOAuthCleanup(new Date(), srv.db); // allow-wall-clock

    for (const clientId of [dead, bare]) {
      const row = await clientRow(clientId);
      expect(row.disabled_at).not.toBeNull();
      expect(row.retired_at).not.toBeNull();
    }
  });

  test("a registration with a valid grant is never retired — Claude and ChatGPT keep working", async () => {
    // A live refresh token, nothing used for weeks: the person still holds the grant.
    const claude = await seedClient({ client_name: "Claude", created_at: at(-60 * DAY) });
    await seedRefresh(claude, { created_at: at(-40 * DAY), expires_at: at(30 * DAY) });
    // A live access token alone is a valid grant too.
    const chatgpt = await seedClient({ client_name: "ChatGPT", created_at: at(-60 * DAY) });
    await seedAccess(chatgpt, { expires_at: at(1 * DAY), last_used_at: null });

    await runMcpOAuthCleanup(new Date(), srv.db); // allow-wall-clock

    for (const clientId of [claude, chatgpt]) {
      const row = await clientRow(clientId);
      expect(row.disabled_at).toBeNull();
      expect(row.retired_at).toBeNull();
    }
  });

  test("recent use keeps a registration without a valid grant", async () => {
    const usedAccess = await seedClient();
    await seedAccess(usedAccess, { expires_at: at(-1 * DAY), last_used_at: at(-2 * DAY) });
    const rotated = await seedClient();
    await seedRefresh(rotated, { created_at: at(-3 * DAY), revoked_at: at(-1 * DAY) });
    const inFlight = await seedClient();
    await srv.db.insert(mcpOauthAuthorizationCodes).values({
      tenant_id: srv.tenantId,
      client_id: inFlight,
      user_id: srv.userId,
      code_sha256: unique("code"),
      code_challenge: CHALLENGE,
      code_challenge_method: "S256",
      redirect_uri: "https://client.example.com/callback",
      scope: "mcp:read",
      // A code lives minutes and is purged a day past expiry, so an
      // authorization within the last day is what this guard can see.
      expires_at: at(-11 * 60 * 60 * 1000),
      created_at: at(-12 * 60 * 60 * 1000),
    });

    await runMcpOAuthCleanup(new Date(), srv.db); // allow-wall-clock

    for (const clientId of [usedAccess, rotated, inFlight])
      expect((await clientRow(clientId)).disabled_at).toBeNull();
  });

  test("a young registration and a manual one are never retired", async () => {
    const young = await seedClient({ created_at: at(-3 * DAY) });
    const manual = await seedClient({ registration_source: "manual" });

    await runMcpOAuthCleanup(new Date(), srv.db); // allow-wall-clock

    expect((await clientRow(young)).disabled_at).toBeNull();
    expect((await clientRow(manual)).disabled_at).toBeNull();
  });

  test("an administrator's revocation is left as it is", async () => {
    const revokedAt = at(-20 * DAY);
    const revoked = await seedClient({ disabled_at: revokedAt });

    await runMcpOAuthCleanup(new Date(), srv.db); // allow-wall-clock

    const row = await clientRow(revoked);
    expect(row.disabled_at?.getTime()).toBe(revokedAt.getTime());
    expect(row.retired_at).toBeNull();
  });

  test("each sweep that retires writes one audit row with the count and the row ids", async () => {
    const a = await seedClient();
    const b = await seedClient();
    const before = new Date(); // allow-wall-clock

    await runMcpOAuthCleanup(new Date(), srv.db); // allow-wall-clock

    const rows = (
      await srv.db.select().from(auditLog).where(eq(auditLog.action, "mcp_oauth.client_retired"))
    ).filter((row) => row.ts >= before);
    expect(rows).toHaveLength(1);
    const meta = rows[0]?.metadata as { count: number; ids: string[]; request_source: string };
    const ids = (
      await srv.db
        .select({ id: mcpOauthClients.id })
        .from(mcpOauthClients)
        .where(inArray(mcpOauthClients.client_id, [a, b]))
    ).map((row) => row.id);
    expect(meta.request_source).toBe("scheduler");
    expect(meta.count).toBe(meta.ids.length);
    for (const id of ids) expect(meta.ids).toContain(id);
  });

  test("a sweep that retires nothing writes no retirement row", async () => {
    await runMcpOAuthCleanup(new Date(), srv.db); // allow-wall-clock
    const before = new Date(); // allow-wall-clock
    await runMcpOAuthCleanup(new Date(), srv.db); // allow-wall-clock
    const rows = (
      await srv.db.select().from(auditLog).where(eq(auditLog.action, "mcp_oauth.client_retired"))
    ).filter((row) => row.ts >= before);
    expect(rows).toHaveLength(0);
  });
});

describe("a retired registration comes back when a person authorizes it", () => {
  test("the client is still known, and completing an authorization reactivates it", async () => {
    const clientId = await seedClient({ client_name: "Real app, idle for a while" });
    await runMcpOAuthCleanup(new Date(), srv.db); // allow-wall-clock
    expect((await clientRow(clientId)).retired_at).not.toBeNull();

    const provider = createMcpOAuthProvider({ db: srv.db, config: makeConfig() });
    expect(await provider.getClient(clientId)).not.toBeNull();

    const code = await provider.issueAuthorizationCode({
      clientId,
      tenantId: srv.tenantId,
      userId: srv.userId,
      redirectUri: "https://client.example.com/callback",
      codeChallenge: CHALLENGE,
      scope: "mcp:read",
    });
    const row = await clientRow(clientId);
    expect(row.disabled_at).toBeNull();
    expect(row.retired_at).toBeNull();

    // The whole flow works: the code exchanges for a pair.
    const pair = await provider.exchangeAuthorizationCode({
      code,
      clientId,
      redirectUri: "https://client.example.com/callback",
      codeVerifier: VERIFIER,
    });
    expect(pair.access_token).toBeTruthy();

    const audit = await srv.db
      .select()
      .from(auditLog)
      .where(
        and(
          eq(auditLog.action, "mcp_oauth.client_reactivated"),
          eq(auditLog.resource_id, clientId),
        ),
      );
    expect(audit).toHaveLength(1);
  });

  test("an administrator's revocation is not undone by an authorization attempt", async () => {
    const clientId = await seedClient({ disabled_at: at(-1 * DAY) });
    const provider = createMcpOAuthProvider({ db: srv.db, config: makeConfig() });
    expect(await provider.getClient(clientId)).toBeNull();
  });

  test("revoking a retired registration makes it a revocation for good", async () => {
    const clientId = await seedClient();
    await runMcpOAuthCleanup(new Date(), srv.db); // allow-wall-clock
    expect((await clientRow(clientId)).retired_at).not.toBeNull();

    const res = await fetch(`${srv.baseUrl}/v1/oauth/clients/${clientId}`, {
      method: "DELETE",
      headers: { authorization: `Bearer ${srv.apiKey}` },
    });
    expect(res.status).toBe(204);
    const row = await clientRow(clientId);
    expect(row.disabled_at).not.toBeNull();
    expect(row.retired_at).toBeNull();

    const provider = createMcpOAuthProvider({ db: srv.db, config: makeConfig() });
    expect(await provider.getClient(clientId)).toBeNull();
  });

  test("the list names a retirement apart from a revocation", async () => {
    const retired = await seedClient();
    await runMcpOAuthCleanup(new Date(), srv.db); // allow-wall-clock
    const res = await fetch(`${srv.baseUrl}/v1/oauth/clients`, {
      headers: { authorization: `Bearer ${srv.apiKey}` },
    });
    expect(res.status).toBe(200);
    const body = (await res.json()) as {
      items: Array<{ client_id: string; disabled_at: string | null; retired_at: string | null }>;
    };
    const item = body.items.find((entry) => entry.client_id === retired);
    expect(item?.disabled_at).not.toBeNull();
    expect(item?.retired_at).not.toBeNull();
  });
});
