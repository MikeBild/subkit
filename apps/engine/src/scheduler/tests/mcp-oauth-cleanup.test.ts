// Integration tests for the MCP OAuth retention cron.
//
// Seeds expired + fresh rows in all four mcp_oauth_* tables, runs
// runMcpOAuthCleanup, and asserts:
//   - expired/stale rows are deleted
//   - fresh rows survive
//   - the summary MCP_OAUTH_EXPIRED_PRUNED audit row is written

import { afterAll, beforeAll, describe, expect, test } from "bun:test";
import { eq } from "drizzle-orm";
import { auditLog } from "../../db/schema/audit.ts";
import {
  mcpOauthAccessTokens,
  mcpOauthAuthorizationCodes,
  mcpOauthClients,
  mcpOauthRefreshTokens,
} from "../../db/schema/mcp_oauth.ts";
import { mcpOauthStates } from "../../db/schema/mcp_oauth_states.ts";
import { createHttpTestServer, type HttpTestServer } from "../../http/tests/setup.ts";
import { seedMcpConnector } from "../../mcp/client/test-fixtures.ts";
import { runMcpOAuthCleanup } from "../mcp-oauth-cleanup-runner.ts";

let srv: HttpTestServer;

// Expired timestamps — all well past their respective grace windows.
const expiredCodeAt = new Date(Date.now() - 2 * 24 * 60 * 60 * 1000); // 2 days ago allow-wall-clock
const expiredTokenAt = new Date(Date.now() - 8 * 24 * 60 * 60 * 1000); // 8 days ago allow-wall-clock
const revokedTokenAt = new Date(Date.now() - 8 * 24 * 60 * 60 * 1000); // 8 days ago allow-wall-clock
const staleClientAt = new Date(Date.now() - 31 * 24 * 60 * 60 * 1000); // 31 days ago allow-wall-clock

// Fresh timestamps — should survive the sweep.
const freshExpiry = new Date(Date.now() + 60 * 60 * 1000); // 1 hour from now allow-wall-clock
const _freshCreatedAt = new Date(Date.now() - 1 * 24 * 60 * 60 * 1000); // 1 day ago allow-wall-clock

// Deterministic monotonic counter for unique `state` strings — the
// uniqueness must not ride the wall clock (two inserts in the same ms would
// also collide). Mirrors the config-seed test's `configFileSeq`.
let stateSeq = 0;
function nextState(prefix: string): string {
  stateSeq += 1;
  return `${prefix}-${stateSeq}`;
}

beforeAll(async () => {
  srv = await createHttpTestServer("mcp-oauth-cleanup");
}, 60_000);

afterAll(async () => {
  await srv.cleanup();
}, 30_000);

describe("runMcpOAuthCleanup — expired authorization codes", () => {
  test("deletes codes whose expires_at is older than 1 day grace", async () => {
    const [row] = await srv.db
      .insert(mcpOauthAuthorizationCodes)
      .values({
        tenant_id: srv.tenantId,
        client_id: "test-client-expired-code",
        user_id: srv.userId,
        code_sha256: "expired_code_sha256_aaa111",
        code_challenge: "challenge",
        code_challenge_method: "S256",
        redirect_uri: "https://example.com/cb",
        scope: "mcp:read",
        expires_at: expiredCodeAt,
      })
      .returning();
    if (!row) throw new Error("seed failed");

    await runMcpOAuthCleanup(new Date(), srv.db); // allow-wall-clock

    const remaining = await srv.db
      .select()
      .from(mcpOauthAuthorizationCodes)
      .where(eq(mcpOauthAuthorizationCodes.id, row.id));
    expect(remaining).toHaveLength(0);
  });

  test("keeps fresh codes that are not yet past the grace window", async () => {
    const [row] = await srv.db
      .insert(mcpOauthAuthorizationCodes)
      .values({
        tenant_id: srv.tenantId,
        client_id: "test-client-fresh-code",
        user_id: srv.userId,
        code_sha256: "fresh_code_sha256_bbb222",
        code_challenge: "challenge",
        code_challenge_method: "S256",
        redirect_uri: "https://example.com/cb",
        scope: "mcp:read",
        expires_at: freshExpiry,
      })
      .returning();
    if (!row) throw new Error("seed failed");

    await runMcpOAuthCleanup(new Date(), srv.db); // allow-wall-clock

    const remaining = await srv.db
      .select()
      .from(mcpOauthAuthorizationCodes)
      .where(eq(mcpOauthAuthorizationCodes.id, row.id));
    expect(remaining).toHaveLength(1);
  });
});

describe("runMcpOAuthCleanup — expired / revoked access tokens", () => {
  test("deletes access tokens whose expires_at is beyond 7-day grace", async () => {
    const [row] = await srv.db
      .insert(mcpOauthAccessTokens)
      .values({
        tenant_id: srv.tenantId,
        client_id: "test-client-expired-at",
        user_id: srv.userId,
        prefix: "exp_at_prefix1",
        token_sha256: "expired_access_token_sha256_ccc333",
        scope: "mcp:read",
        expires_at: expiredTokenAt,
      })
      .returning();
    if (!row) throw new Error("seed failed");

    await runMcpOAuthCleanup(new Date(), srv.db); // allow-wall-clock

    const remaining = await srv.db
      .select()
      .from(mcpOauthAccessTokens)
      .where(eq(mcpOauthAccessTokens.id, row.id));
    expect(remaining).toHaveLength(0);
  });

  test("deletes access tokens whose revoked_at is beyond 7-day grace", async () => {
    const [row] = await srv.db
      .insert(mcpOauthAccessTokens)
      .values({
        tenant_id: srv.tenantId,
        client_id: "test-client-revoked-at",
        user_id: srv.userId,
        prefix: "rev_at_prefix1",
        token_sha256: "revoked_access_token_sha256_ddd444",
        scope: "mcp:read",
        expires_at: freshExpiry,
        revoked_at: revokedTokenAt,
      })
      .returning();
    if (!row) throw new Error("seed failed");

    await runMcpOAuthCleanup(new Date(), srv.db); // allow-wall-clock

    const remaining = await srv.db
      .select()
      .from(mcpOauthAccessTokens)
      .where(eq(mcpOauthAccessTokens.id, row.id));
    expect(remaining).toHaveLength(0);
  });

  test("keeps fresh access tokens with future expiry and no revocation", async () => {
    const [row] = await srv.db
      .insert(mcpOauthAccessTokens)
      .values({
        tenant_id: srv.tenantId,
        client_id: "test-client-fresh-at",
        user_id: srv.userId,
        prefix: "fresh_at_prefix1",
        token_sha256: "fresh_access_token_sha256_eee555",
        scope: "mcp:read",
        expires_at: freshExpiry,
      })
      .returning();
    if (!row) throw new Error("seed failed");

    await runMcpOAuthCleanup(new Date(), srv.db); // allow-wall-clock

    const remaining = await srv.db
      .select()
      .from(mcpOauthAccessTokens)
      .where(eq(mcpOauthAccessTokens.id, row.id));
    expect(remaining).toHaveLength(1);
  });
});

describe("runMcpOAuthCleanup — expired / revoked refresh tokens", () => {
  test("deletes refresh tokens whose expires_at is beyond 7-day grace", async () => {
    const [row] = await srv.db
      .insert(mcpOauthRefreshTokens)
      .values({
        tenant_id: srv.tenantId,
        client_id: "test-client-expired-rt",
        user_id: srv.userId,
        prefix: "exp_rt_prefix1",
        token_sha256: "expired_refresh_token_sha256_fff666",
        scope: "mcp:read",
        expires_at: expiredTokenAt,
      })
      .returning();
    if (!row) throw new Error("seed failed");

    await runMcpOAuthCleanup(new Date(), srv.db); // allow-wall-clock

    const remaining = await srv.db
      .select()
      .from(mcpOauthRefreshTokens)
      .where(eq(mcpOauthRefreshTokens.id, row.id));
    expect(remaining).toHaveLength(0);
  });

  test("keeps fresh refresh tokens with future expiry", async () => {
    const [row] = await srv.db
      .insert(mcpOauthRefreshTokens)
      .values({
        tenant_id: srv.tenantId,
        client_id: "test-client-fresh-rt",
        user_id: srv.userId,
        prefix: "fresh_rt_prefix1",
        token_sha256: "fresh_refresh_token_sha256_ggg777",
        scope: "mcp:read",
        expires_at: freshExpiry,
      })
      .returning();
    if (!row) throw new Error("seed failed");

    await runMcpOAuthCleanup(new Date(), srv.db); // allow-wall-clock

    const remaining = await srv.db
      .select()
      .from(mcpOauthRefreshTokens)
      .where(eq(mcpOauthRefreshTokens.id, row.id));
    expect(remaining).toHaveLength(1);
  });

  test("deletes an expired refresh token still referenced by a live access token, nulling the link (prod FK regression)", async () => {
    // Reproduces the intermittent prod incident (mcp_oauth_cleanup.refresh_tokens_failed):
    // sweep 2 deletes a refresh token that is >7d expired while a child access
    // token (future expiry) still points at it via refresh_token_id. With the FK
    // at ON DELETE NO ACTION the delete threw an FK violation; ON DELETE SET NULL
    // lets the sweep proceed and nulls the surviving access token's link.
    const [rt] = await srv.db
      .insert(mcpOauthRefreshTokens)
      .values({
        tenant_id: srv.tenantId,
        client_id: "test-client-rt-fk",
        user_id: srv.userId,
        prefix: "fk_rt_prefix1",
        token_sha256: "fk_refresh_token_sha256_nnn444",
        scope: "mcp:read",
        expires_at: expiredTokenAt,
      })
      .returning();
    if (!rt) throw new Error("seed refresh token failed");

    const [at] = await srv.db
      .insert(mcpOauthAccessTokens)
      .values({
        tenant_id: srv.tenantId,
        client_id: "test-client-rt-fk",
        user_id: srv.userId,
        prefix: "fk_at_prefix1",
        token_sha256: "fk_access_token_sha256_nnn444",
        scope: "mcp:read",
        expires_at: freshExpiry, // live — NOT removed by sweep 1
        refresh_token_id: rt.id,
      })
      .returning();
    if (!at) throw new Error("seed access token failed");

    // Must not throw (was: FK violation -> refresh_tokens_failed).
    await runMcpOAuthCleanup(new Date(), srv.db); // allow-wall-clock

    const rtRemaining = await srv.db
      .select()
      .from(mcpOauthRefreshTokens)
      .where(eq(mcpOauthRefreshTokens.id, rt.id));
    expect(rtRemaining).toHaveLength(0);

    const atRemaining = await srv.db
      .select()
      .from(mcpOauthAccessTokens)
      .where(eq(mcpOauthAccessTokens.id, at.id));
    expect(atRemaining).toHaveLength(1);
    expect(atRemaining[0]!.refresh_token_id).toBeNull();
  });

  test("sweeps a chain-revoked rotation pair with chained access tokens in one pass", async () => {
    // Chain-revocation shape (audit K3 fixture): reuse detection revokes every
    // member of a rotation chain at once, so 7 days later rt1 AND rt2 become
    // eligible in the SAME delete statement — rt1 still points at rt2 via the
    // NO ACTION self-FK rotated_to_id (legal only because NO ACTION is checked
    // at statement end), and each refresh token has a child access token
    // hanging off refresh_token_id. The sweep must clear the whole chain in
    // one pass: both refresh tokens gone, the expired access token gone, the
    // live access token surviving with its link nulled by ON DELETE SET NULL.
    const [rt2] = await srv.db
      .insert(mcpOauthRefreshTokens)
      .values({
        tenant_id: srv.tenantId,
        client_id: "test-client-chain",
        user_id: srv.userId,
        prefix: "chain_rt2_prefx1",
        token_sha256: "chain_refresh_token_sha256_ppp222",
        scope: "mcp:read",
        expires_at: freshExpiry, // not yet expired — eligible via revoked_at only
        revoked_at: revokedTokenAt,
      })
      .returning();
    if (!rt2) throw new Error("seed rt2 failed");

    const [rt1] = await srv.db
      .insert(mcpOauthRefreshTokens)
      .values({
        tenant_id: srv.tenantId,
        client_id: "test-client-chain",
        user_id: srv.userId,
        prefix: "chain_rt1_prefx1",
        token_sha256: "chain_refresh_token_sha256_ppp111",
        scope: "mcp:read",
        rotated_to_id: rt2.id,
        expires_at: expiredTokenAt,
        revoked_at: revokedTokenAt,
      })
      .returning();
    if (!rt1) throw new Error("seed rt1 failed");

    const [at1] = await srv.db
      .insert(mcpOauthAccessTokens)
      .values({
        tenant_id: srv.tenantId,
        client_id: "test-client-chain",
        user_id: srv.userId,
        prefix: "chain_at1_prefx1",
        token_sha256: "chain_access_token_sha256_ppp111",
        scope: "mcp:read",
        expires_at: expiredTokenAt, // dead — removed by sweep 1
        refresh_token_id: rt1.id,
      })
      .returning();
    if (!at1) throw new Error("seed at1 failed");

    const [at2] = await srv.db
      .insert(mcpOauthAccessTokens)
      .values({
        tenant_id: srv.tenantId,
        client_id: "test-client-chain",
        user_id: srv.userId,
        prefix: "chain_at2_prefx1",
        token_sha256: "chain_access_token_sha256_ppp222",
        scope: "mcp:read",
        expires_at: freshExpiry, // live — survives sweep 1
        refresh_token_id: rt2.id,
      })
      .returning();
    if (!at2) throw new Error("seed at2 failed");

    // Must not throw on either FK (self-FK rotated_to_id or child access tokens).
    await runMcpOAuthCleanup(new Date(), srv.db); // allow-wall-clock

    const rtRemaining = await srv.db
      .select()
      .from(mcpOauthRefreshTokens)
      .where(eq(mcpOauthRefreshTokens.client_id, "test-client-chain"));
    expect(rtRemaining).toHaveLength(0);

    const at1Remaining = await srv.db
      .select()
      .from(mcpOauthAccessTokens)
      .where(eq(mcpOauthAccessTokens.id, at1.id));
    expect(at1Remaining).toHaveLength(0);

    const at2Remaining = await srv.db
      .select()
      .from(mcpOauthAccessTokens)
      .where(eq(mcpOauthAccessTokens.id, at2.id));
    expect(at2Remaining).toHaveLength(1);
    expect(at2Remaining[0]!.refresh_token_id).toBeNull();
  });
});

describe("runMcpOAuthCleanup — stale unused DCR clients", () => {
  test("deletes old client with no authorization codes", async () => {
    const clientId = "stale-unused-dcr-client-hhh888";
    const [row] = await srv.db
      .insert(mcpOauthClients)
      .values({
        client_id: clientId,
        redirect_uris: ["https://example.com/cb"],
        grant_types: ["authorization_code", "refresh_token"],
        scope: "mcp:read",
        // Override created_at by seeding at a past timestamp via raw SQL if needed.
        // Since Drizzle uses defaultNow(), we set it via update after insert.
      })
      .returning();
    if (!row) throw new Error("seed failed");

    // Manually backdate created_at to simulate a stale client.
    await srv.db.execute(
      `UPDATE mcp_oauth_clients SET created_at = '${staleClientAt.toISOString()}' WHERE id = '${row.id}'`,
    );

    await runMcpOAuthCleanup(new Date(), srv.db); // allow-wall-clock

    const remaining = await srv.db
      .select()
      .from(mcpOauthClients)
      .where(eq(mcpOauthClients.client_id, clientId));
    expect(remaining).toHaveLength(0);
  });

  test("keeps old client that HAS authorization codes (was used)", async () => {
    const clientId = "stale-used-dcr-client-iii999";
    const [clientRow] = await srv.db
      .insert(mcpOauthClients)
      .values({
        client_id: clientId,
        redirect_uris: ["https://example.com/cb"],
        grant_types: ["authorization_code", "refresh_token"],
        scope: "mcp:read",
      })
      .returning();
    if (!clientRow) throw new Error("seed client failed");

    // Backdate created_at
    await srv.db.execute(
      `UPDATE mcp_oauth_clients SET created_at = '${staleClientAt.toISOString()}' WHERE id = '${clientRow.id}'`,
    );

    // Seed a code for this client so NOT EXISTS guard fires
    await srv.db.insert(mcpOauthAuthorizationCodes).values({
      tenant_id: srv.tenantId,
      client_id: clientId,
      user_id: srv.userId,
      code_sha256: "used_client_code_sha256_jjj000",
      code_challenge: "challenge",
      code_challenge_method: "S256",
      redirect_uri: "https://example.com/cb",
      scope: "mcp:read",
      // Fresh expiry so the code sweep doesn't remove it first
      expires_at: freshExpiry,
    });

    await runMcpOAuthCleanup(new Date(), srv.db); // allow-wall-clock

    const remaining = await srv.db
      .select()
      .from(mcpOauthClients)
      .where(eq(mcpOauthClients.client_id, clientId));
    expect(remaining).toHaveLength(1);
  });

  test("keeps old client with a live refresh token but no codes (prod regression)", async () => {
    // Reproduces the prod incident: a DCR client connected >30 days ago whose
    // short-lived authorization codes were long since purged by sweep 3, but
    // which still holds live refresh tokens (actively used). A codes-only guard
    // deleted it, breaking the connector with "unknown client_id". The durable
    // refresh-token footprint must keep it alive.
    const clientId = "stale-active-dcr-client-lll222";
    const [clientRow] = await srv.db
      .insert(mcpOauthClients)
      .values({
        client_id: clientId,
        redirect_uris: ["https://example.com/cb"],
        grant_types: ["authorization_code", "refresh_token"],
        scope: "mcp:read",
      })
      .returning();
    if (!clientRow) throw new Error("seed client failed");

    await srv.db.execute(
      `UPDATE mcp_oauth_clients SET created_at = '${staleClientAt.toISOString()}' WHERE id = '${clientRow.id}'`,
    );

    // A live (future-expiry, un-revoked) refresh token — the durable proof of
    // use. No authorization codes exist for this client (sweep 3 purged them).
    await srv.db.insert(mcpOauthRefreshTokens).values({
      tenant_id: srv.tenantId,
      client_id: clientId,
      user_id: srv.userId,
      prefix: "active_rt_prefix1",
      token_sha256: "active_client_refresh_token_sha256_lll222",
      scope: "mcp:read",
      expires_at: freshExpiry,
    });

    await runMcpOAuthCleanup(new Date(), srv.db); // allow-wall-clock

    const remaining = await srv.db
      .select()
      .from(mcpOauthClients)
      .where(eq(mcpOauthClients.client_id, clientId));
    expect(remaining).toHaveLength(1);
  });

  test("keeps old client with a live access token but no codes", async () => {
    const clientId = "stale-active-at-dcr-client-mmm333";
    const [clientRow] = await srv.db
      .insert(mcpOauthClients)
      .values({
        client_id: clientId,
        redirect_uris: ["https://example.com/cb"],
        grant_types: ["authorization_code", "refresh_token"],
        scope: "mcp:read",
      })
      .returning();
    if (!clientRow) throw new Error("seed client failed");

    await srv.db.execute(
      `UPDATE mcp_oauth_clients SET created_at = '${staleClientAt.toISOString()}' WHERE id = '${clientRow.id}'`,
    );

    await srv.db.insert(mcpOauthAccessTokens).values({
      tenant_id: srv.tenantId,
      client_id: clientId,
      user_id: srv.userId,
      prefix: "active_at_prefix1",
      token_sha256: "active_client_access_token_sha256_mmm333",
      scope: "mcp:read",
      expires_at: freshExpiry,
    });

    await runMcpOAuthCleanup(new Date(), srv.db); // allow-wall-clock

    const remaining = await srv.db
      .select()
      .from(mcpOauthClients)
      .where(eq(mcpOauthClients.client_id, clientId));
    expect(remaining).toHaveLength(1);
  });

  test("keeps recently registered client even with no codes", async () => {
    const clientId = "recent-unused-dcr-client-kkk111";
    const [row] = await srv.db
      .insert(mcpOauthClients)
      .values({
        client_id: clientId,
        redirect_uris: ["https://example.com/cb"],
        grant_types: ["authorization_code", "refresh_token"],
        scope: "mcp:read",
        // created_at defaults to now() — within the 30-day window
      })
      .returning();
    if (!row) throw new Error("seed failed");

    await runMcpOAuthCleanup(new Date(), srv.db); // allow-wall-clock

    const remaining = await srv.db
      .select()
      .from(mcpOauthClients)
      .where(eq(mcpOauthClients.client_id, clientId));
    expect(remaining).toHaveLength(1);
  });
});

describe("runMcpOAuthCleanup — expired client-direction in-flight states", () => {
  /** Seed an mcp connector so mcp_oauth_states' FK is satisfied. */
  async function seedServer(slug: string): Promise<string> {
    const row = await seedMcpConnector(srv.db, {
      tenant_id: srv.tenantId,
      slug,
      display_name: `cleanup ${slug}`,
      transport: "http",
      url: "https://examplemcp.cleanup.test/mcp",
      auth: { kind: "oauth2", issuer: "https://auth.cleanup.test" },
    });
    return row.id;
  }

  test("deletes mcp_oauth_states rows whose expires_at has passed", async () => {
    const serverId = await seedServer("states-expired");
    const [row] = await srv.db
      .insert(mcpOauthStates)
      .values({
        tenant_id: srv.tenantId,
        connector_id: serverId,
        state: nextState("expired-state"),
        code_verifier: "",
        redirect_uri: "https://engine.cleanup.test/v1/connectors/mcp/oauth/callback",
        expires_at: new Date(Date.now() - 60_000), // already expired allow-wall-clock
      })
      .returning();
    if (!row) throw new Error("seed state failed");

    await runMcpOAuthCleanup(new Date(), srv.db); // allow-wall-clock

    const remaining = await srv.db
      .select()
      .from(mcpOauthStates)
      .where(eq(mcpOauthStates.id, row.id));
    expect(remaining).toHaveLength(0);
  });

  test("keeps mcp_oauth_states rows that are still in-flight (future expiry)", async () => {
    const serverId = await seedServer("states-fresh");
    const [row] = await srv.db
      .insert(mcpOauthStates)
      .values({
        tenant_id: srv.tenantId,
        connector_id: serverId,
        state: nextState("fresh-state"),
        code_verifier: "",
        redirect_uri: "https://engine.cleanup.test/v1/connectors/mcp/oauth/callback",
        expires_at: freshExpiry,
      })
      .returning();
    if (!row) throw new Error("seed state failed");

    await runMcpOAuthCleanup(new Date(), srv.db); // allow-wall-clock

    const remaining = await srv.db
      .select()
      .from(mcpOauthStates)
      .where(eq(mcpOauthStates.id, row.id));
    expect(remaining).toHaveLength(1);
  });
});

describe("runMcpOAuthCleanup — summary audit row", () => {
  test("emits MCP_OAUTH_EXPIRED_PRUNED audit row after every run", async () => {
    const before = new Date(); // allow-wall-clock
    await runMcpOAuthCleanup(new Date(), srv.db); // allow-wall-clock
    const after = new Date(); // allow-wall-clock

    const rows = await srv.db
      .select()
      .from(auditLog)
      .where(eq(auditLog.action, "mcp_oauth.expired_pruned"));

    const recent = rows.filter((r) => r.ts >= before && r.ts <= after);
    expect(recent.length).toBeGreaterThanOrEqual(1);

    const meta = recent[0]!.metadata as Record<string, unknown>;
    expect(meta.request_source).toBe("scheduler");
    expect(typeof meta.codes_deleted).toBe("number");
    expect(typeof meta.access_tokens_deleted).toBe("number");
    expect(typeof meta.refresh_tokens_deleted).toBe("number");
    expect(typeof meta.clients_deleted).toBe("number");
    expect(typeof meta.states_deleted).toBe("number");
  });
});
