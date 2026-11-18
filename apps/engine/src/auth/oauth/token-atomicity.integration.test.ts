import { afterAll, beforeAll, describe, expect, test } from "bun:test";
import { and, eq } from "drizzle-orm";
import { getConfig } from "../../config/loader.ts";
import { ConfigSchema } from "../../config/schema.ts";
import type { Db } from "../../db/client.ts";
import { hostedQuotaError } from "../../db/hosted-quota-errors.ts";
import {
  auditLog,
  mcpOauthAccessTokens,
  mcpOauthAuthorizationCodes,
  mcpOauthGrants,
  mcpOauthRefreshTokens,
  tenants,
} from "../../db/schema/index.ts";
import { createTestDb, TEST_DB_HOOK_TIMEOUT, type TestDb } from "../../db/tests/setup.ts";
import { provisionSelfServiceTenant } from "../../identity/index.ts";
import {
  getMetrics,
  METRIC_NAMES,
  resetMetricsRegistryForTests,
} from "../../observability/metrics.ts";
import { getTestNow } from "../../test-helpers/determinism/clock.ts";
import { waitFor } from "../../test-helpers/determinism/wait.ts";
import { configureHostedPolicyForTests } from "../../test-helpers/hosted-policy.ts";
import { TEST_WORKSPACE_REGISTRATION } from "../../test-helpers/workspace-registration.ts";
import { createMcpOAuthProvider, type McpOAuthProvider } from "./server-provider.ts";
import { CODE_VERIFIER, REDIRECT_URI, serverProviderFixtures } from "./server-provider-fixtures.ts";
import { sha256Hex } from "./tokens.ts";

let testDb: TestDb;
let db: Db;
let tenantId: string;
let userId: string;
let provider: McpOAuthProvider;

const { CODE_CHALLENGE, issueTokenPair, makeConfig, registerTestClient } = serverProviderFixtures({
  get testDb() {
    return testDb;
  },
  get provider() {
    return provider;
  },
  get tenantId() {
    return tenantId;
  },
  get userId() {
    return userId;
  },
});

beforeAll(async () => {
  testDb = await createTestDb("mcp-oauth-token-atomicity");
  db = testDb.db;
  await configureHostedPolicyForTests(db, testDb.url);
  const fixture = await provisionSelfServiceTenant(
    {
      issuer_url: "https://identity.example.test",
      subject: "mcp-oauth-atomicity",
      email: "mcp-oauth-atomicity@example.test",
      email_verified: true,
    },
    TEST_WORKSPACE_REGISTRATION,
    db,
  );
  tenantId = fixture.tenant.id;
  userId = fixture.membership.user_id;
  const config = makeConfig();
  provider = createMcpOAuthProvider({
    db,
    config: ConfigSchema.parse({
      ...config,
      auth: {
        ...config.auth,
        session: { secret: getConfig().auth.session.secret },
        hosted: { admission: getConfig().auth.hosted.admission },
      },
    }),
  });
}, TEST_DB_HOOK_TIMEOUT);

afterAll(async () => {
  if (testDb) await testDb.cleanup();
}, TEST_DB_HOOK_TIMEOUT);

function retryCount(): number {
  return getMetrics().counterSum(METRIC_NAMES.DB_TRANSIENT_RETRIES_TOTAL);
}

async function holdTenantQuota() {
  const holder = await testDb.pool.connect();
  await holder.query("BEGIN");
  await holder.query("SELECT pg_advisory_xact_lock(hashtextextended($1::text,741937))", [tenantId]);
  return holder;
}

async function releaseAfterFirstRetry(holder: Awaited<ReturnType<typeof holdTenantQuota>>) {
  await waitFor(() => retryCount() > 0, {
    tries: 500,
    sleepMs: 1,
    label: "OAuth token operation reaches hosted quota retry",
  });
  await holder.query("COMMIT");
}

async function issueCode(clientId: string): Promise<string> {
  return provider.issueAuthorizationCode({
    tenantId,
    userId,
    clientId,
    redirectUri: REDIRECT_URI,
    codeChallenge: CODE_CHALLENGE,
    scope: "mcp:read",
  });
}

async function auditCount(action: "mcp_oauth.token_issued" | "mcp_oauth.token_refreshed") {
  const rows = await db
    .select({ id: auditLog.id })
    .from(auditLog)
    .where(and(eq(auditLog.tenant_id, tenantId), eq(auditLog.action, action)));
  return rows.length;
}

async function tokenFamilyCounts() {
  const [grants, access, refresh] = await Promise.all([
    db
      .select({ id: mcpOauthGrants.id })
      .from(mcpOauthGrants)
      .where(eq(mcpOauthGrants.tenant_id, tenantId)),
    db
      .select({ id: mcpOauthAccessTokens.id })
      .from(mcpOauthAccessTokens)
      .where(eq(mcpOauthAccessTokens.tenant_id, tenantId)),
    db
      .select({ id: mcpOauthRefreshTokens.id })
      .from(mcpOauthRefreshTokens)
      .where(eq(mcpOauthRefreshTokens.tenant_id, tenantId)),
  ]);
  return { grants: grants.length, access: access.length, refresh: refresh.length };
}

describe("OAuth token atomicity under hosted tenant quota contention", () => {
  test("retries a code exchange as one transaction and records one token family and audit", async () => {
    const clientId = await registerTestClient({ scope: "mcp:read" });
    const code = await issueCode(clientId);
    const codeHash = sha256Hex(code);
    const beforeAudit = await auditCount("mcp_oauth.token_issued");
    const beforeFamily = await tokenFamilyCounts();
    resetMetricsRegistryForTests();
    const holder = await holdTenantQuota();
    const exchange = provider
      .exchangeAuthorizationCode({
        code,
        clientId,
        redirectUri: REDIRECT_URI,
        codeVerifier: CODE_VERIFIER,
      })
      .then(
        (value) => ({ value }),
        (error: unknown) => ({ error }),
      );
    try {
      await releaseAfterFirstRetry(holder);
      const outcome = await exchange;
      if (!("value" in outcome)) throw outcome.error;
      const tokens = outcome.value;
      expect(tokens.access_token).toMatch(/^wf_mcp_/);
      expect(tokens.refresh_token).toMatch(/^wf_mcr_/);
      expect(retryCount()).toBe(1);
      expect(await auditCount("mcp_oauth.token_issued")).toBe(beforeAudit + 1);
      expect(await tokenFamilyCounts()).toEqual({
        grants: beforeFamily.grants + 1,
        access: beforeFamily.access + 1,
        refresh: beforeFamily.refresh + 1,
      });
      const [codeRow] = await db
        .select({ consumed_at: mcpOauthAuthorizationCodes.consumed_at })
        .from(mcpOauthAuthorizationCodes)
        .where(eq(mcpOauthAuthorizationCodes.code_sha256, codeHash));
      expect(codeRow?.consumed_at).not.toBeNull();
      const [access] = await db
        .select({ grant_id: mcpOauthAccessTokens.grant_id })
        .from(mcpOauthAccessTokens)
        .where(eq(mcpOauthAccessTokens.token_sha256, sha256Hex(tokens.access_token)));
      const [refresh] = await db
        .select({ grant_id: mcpOauthRefreshTokens.grant_id })
        .from(mcpOauthRefreshTokens)
        .where(eq(mcpOauthRefreshTokens.token_sha256, sha256Hex(tokens.refresh_token)));
      expect(access?.grant_id).toBeDefined();
      expect(refresh?.grant_id).toBe(access?.grant_id);
    } finally {
      await holder.query("ROLLBACK").catch(() => {});
      holder.release();
    }
  });

  test("exhausted code-exchange quota retries leave the code unconsumed and usable after unlock", async () => {
    const clientId = await registerTestClient({ scope: "mcp:read" });
    const code = await issueCode(clientId);
    const codeHash = sha256Hex(code);
    const beforeAudit = await auditCount("mcp_oauth.token_issued");
    const beforeFamily = await tokenFamilyCounts();
    resetMetricsRegistryForTests();
    const holder = await holdTenantQuota();
    try {
      const exhausted = await provider
        .exchangeAuthorizationCode({
          code,
          clientId,
          redirectUri: REDIRECT_URI,
          codeVerifier: CODE_VERIFIER,
        })
        .then(
          () => undefined,
          (error: unknown) => error,
        );
      expect(hostedQuotaError(exhausted)?.code).toBe("40001");
      expect(await auditCount("mcp_oauth.token_issued")).toBe(beforeAudit);
      expect(await tokenFamilyCounts()).toEqual(beforeFamily);
      const [codeRow] = await db
        .select({ consumed_at: mcpOauthAuthorizationCodes.consumed_at })
        .from(mcpOauthAuthorizationCodes)
        .where(eq(mcpOauthAuthorizationCodes.code_sha256, codeHash));
      expect(codeRow?.consumed_at).toBeNull();
      expect(retryCount()).toBe(2);
      await holder.query("COMMIT");
      await expect(
        provider.exchangeAuthorizationCode({
          code,
          clientId,
          redirectUri: REDIRECT_URI,
          codeVerifier: CODE_VERIFIER,
        }),
      ).resolves.toMatchObject({ token_type: "bearer" });
    } finally {
      await holder.query("ROLLBACK").catch(() => {});
      holder.release();
    }
  });

  test("quota-retried refresh does not become a replay, while a later real replay still revokes", async () => {
    const clientId = await registerTestClient({ scope: "mcp:read" });
    const original = await issueTokenPair({ clientId, scope: "mcp:read" });
    const originalHash = sha256Hex(original.refresh_token);
    const beforeAudit = await auditCount("mcp_oauth.token_refreshed");
    const beforeFamily = await tokenFamilyCounts();
    resetMetricsRegistryForTests();
    const holder = await holdTenantQuota();
    const refresh = provider
      .exchangeRefreshToken({ refreshToken: original.refresh_token, clientId })
      .then(
        (value) => ({ value }),
        (error: unknown) => ({ error }),
      );
    try {
      await releaseAfterFirstRetry(holder);
      const outcome = await refresh;
      if (!("value" in outcome)) throw outcome.error;
      const rotated = outcome.value;
      expect(retryCount()).toBe(1);
      expect(await auditCount("mcp_oauth.token_refreshed")).toBe(beforeAudit + 1);
      expect(await tokenFamilyCounts()).toEqual({
        grants: beforeFamily.grants,
        access: beforeFamily.access + 1,
        refresh: beforeFamily.refresh + 1,
      });
      const [beforeReplay] = await db
        .select({
          grant_id: mcpOauthRefreshTokens.grant_id,
          rotated_to_id: mcpOauthRefreshTokens.rotated_to_id,
          revoked_at: mcpOauthRefreshTokens.revoked_at,
        })
        .from(mcpOauthRefreshTokens)
        .where(eq(mcpOauthRefreshTokens.token_sha256, originalHash));
      expect(beforeReplay?.rotated_to_id).not.toBeNull();
      expect(beforeReplay?.revoked_at).toBeNull();
      await expect(
        provider.exchangeRefreshToken({ refreshToken: original.refresh_token, clientId }),
      ).rejects.toMatchObject({ oauth_error: "invalid_grant" });
      const [grant] = await db
        .select({ revoked_at: mcpOauthGrants.revoked_at })
        .from(mcpOauthGrants)
        .where(eq(mcpOauthGrants.id, beforeReplay!.grant_id!));
      expect(grant?.revoked_at).not.toBeNull();
      expect(rotated.refresh_token).toMatch(/^wf_mcr_/);
    } finally {
      await holder.query("ROLLBACK").catch(() => {});
      holder.release();
    }
  });

  test("exhausted refresh quota leaves its parent live and usable after unlock", async () => {
    const clientId = await registerTestClient({ scope: "mcp:read" });
    const original = await issueTokenPair({ clientId, scope: "mcp:read" });
    const originalHash = sha256Hex(original.refresh_token);
    const beforeAudit = await auditCount("mcp_oauth.token_refreshed");
    const beforeFamily = await tokenFamilyCounts();
    resetMetricsRegistryForTests();
    const holder = await holdTenantQuota();
    try {
      const exhausted = await provider
        .exchangeRefreshToken({ refreshToken: original.refresh_token, clientId })
        .then(
          () => undefined,
          (error: unknown) => error,
        );
      expect(hostedQuotaError(exhausted)?.code).toBe("40001");
      expect(await auditCount("mcp_oauth.token_refreshed")).toBe(beforeAudit);
      expect(await tokenFamilyCounts()).toEqual(beforeFamily);
      const [parent] = await db
        .select({
          rotated_to_id: mcpOauthRefreshTokens.rotated_to_id,
          revoked_at: mcpOauthRefreshTokens.revoked_at,
        })
        .from(mcpOauthRefreshTokens)
        .where(eq(mcpOauthRefreshTokens.token_sha256, originalHash));
      expect(parent).toEqual({ rotated_to_id: null, revoked_at: null });
      expect(retryCount()).toBe(2);
      await holder.query("COMMIT");
      await expect(
        provider.exchangeRefreshToken({ refreshToken: original.refresh_token, clientId }),
      ).resolves.toMatchObject({ token_type: "bearer" });
    } finally {
      await holder.query("ROLLBACK").catch(() => {});
      holder.release();
    }
  });
});

describe("authorization-code rejection and redemption invariants", () => {
  test.each([
    {
      name: "PKCE mismatch",
      exchange: (code: string, clientId: string) =>
        provider.exchangeAuthorizationCode({
          code,
          clientId,
          redirectUri: REDIRECT_URI,
          codeVerifier: "not-the-bound-verifier",
        }),
    },
    {
      name: "client mismatch",
      exchange: async (code: string) =>
        provider.exchangeAuthorizationCode({
          code,
          clientId: await registerTestClient({ scope: "mcp:read" }),
          redirectUri: REDIRECT_URI,
          codeVerifier: CODE_VERIFIER,
        }),
    },
    {
      name: "redirect mismatch",
      exchange: (code: string, clientId: string) =>
        provider.exchangeAuthorizationCode({
          code,
          clientId,
          redirectUri: "https://other.example.test/callback",
          codeVerifier: CODE_VERIFIER,
        }),
    },
  ])("$name consumes the code without minting tokens", async ({ exchange }) => {
    const clientId = await registerTestClient({ scope: "mcp:read" });
    const code = await issueCode(clientId);
    const codeHash = sha256Hex(code);
    const grantsBefore = await db.select({ id: mcpOauthGrants.id }).from(mcpOauthGrants);
    await expect(exchange(code, clientId)).rejects.toMatchObject({ oauth_error: "invalid_grant" });
    const [codeRow] = await db
      .select({ consumed_at: mcpOauthAuthorizationCodes.consumed_at })
      .from(mcpOauthAuthorizationCodes)
      .where(eq(mcpOauthAuthorizationCodes.code_sha256, codeHash));
    expect(codeRow?.consumed_at).not.toBeNull();
    expect(await db.select({ id: mcpOauthGrants.id }).from(mcpOauthGrants)).toHaveLength(
      grantsBefore.length,
    );
  });

  test("expired code is consumed without minting", async () => {
    const clientId = await registerTestClient({ scope: "mcp:read" });
    const code = await issueCode(clientId);
    const codeHash = sha256Hex(code);
    const grantsBefore = await db.select({ id: mcpOauthGrants.id }).from(mcpOauthGrants);
    await db
      .update(mcpOauthAuthorizationCodes)
      .set({ expires_at: new Date(Date.now() - 1_000) }) // allow-wall-clock: intentional expiry fixture
      .where(eq(mcpOauthAuthorizationCodes.code_sha256, codeHash));
    await expect(
      provider.exchangeAuthorizationCode({
        code,
        clientId,
        redirectUri: REDIRECT_URI,
        codeVerifier: CODE_VERIFIER,
      }),
    ).rejects.toMatchObject({ oauth_error: "invalid_grant" });
    const [codeRow] = await db
      .select({ consumed_at: mcpOauthAuthorizationCodes.consumed_at })
      .from(mcpOauthAuthorizationCodes)
      .where(eq(mcpOauthAuthorizationCodes.code_sha256, codeHash));
    expect(codeRow?.consumed_at).not.toBeNull();
    expect(await db.select({ id: mcpOauthGrants.id }).from(mcpOauthGrants)).toHaveLength(
      grantsBefore.length,
    );
  });

  test("two simultaneous redemptions yield exactly one token family", async () => {
    const clientId = await registerTestClient({ scope: "mcp:read" });
    const code = await issueCode(clientId);
    const outcomes = await Promise.allSettled(
      [0, 1].map(() =>
        provider.exchangeAuthorizationCode({
          code,
          clientId,
          redirectUri: REDIRECT_URI,
          codeVerifier: CODE_VERIFIER,
        }),
      ),
    );
    expect(outcomes.filter((outcome) => outcome.status === "fulfilled")).toHaveLength(1);
    const failure = outcomes.find((outcome) => outcome.status === "rejected");
    if (failure?.status !== "rejected") throw new Error("expected one rejected redemption");
    expect((failure.reason as { oauth_error?: string }).oauth_error).toBe("invalid_grant");
  });

  test.each(["suspended", "pending_deletion"] as const)(
    "%s tenant consumes an already issued code without minting, even after reactivation",
    async (status) => {
      const clientId = await registerTestClient({ scope: "mcp:read" });
      const code = await issueCode(clientId);
      const codeHash = sha256Hex(code);
      const beforeAudit = await auditCount("mcp_oauth.token_issued");
      const beforeFamily = await tokenFamilyCounts();
      const now = getTestNow();
      await db
        .update(tenants)
        .set({
          status,
          ...(status === "pending_deletion"
            ? {
                deletion_requested_at: new Date(now),
                deletion_scheduled_for: new Date(now + 86_400_000),
              }
            : {}),
        })
        .where(eq(tenants.id, tenantId));
      try {
        await expect(
          provider.exchangeAuthorizationCode({
            code,
            clientId,
            redirectUri: REDIRECT_URI,
            codeVerifier: CODE_VERIFIER,
          }),
        ).rejects.toMatchObject({ oauth_error: "invalid_grant" });
        const [codeRow] = await db
          .select({ consumed_at: mcpOauthAuthorizationCodes.consumed_at })
          .from(mcpOauthAuthorizationCodes)
          .where(eq(mcpOauthAuthorizationCodes.code_sha256, codeHash));
        expect(codeRow?.consumed_at).not.toBeNull();
        expect(await tokenFamilyCounts()).toEqual(beforeFamily);
        expect(await auditCount("mcp_oauth.token_issued")).toBe(beforeAudit);
        await db
          .update(tenants)
          .set({ status: "active", deletion_requested_at: null, deletion_scheduled_for: null })
          .where(eq(tenants.id, tenantId));
        await expect(
          provider.exchangeAuthorizationCode({
            code,
            clientId,
            redirectUri: REDIRECT_URI,
            codeVerifier: CODE_VERIFIER,
          }),
        ).rejects.toMatchObject({ oauth_error: "invalid_grant" });
      } finally {
        await db
          .update(tenants)
          .set({ status: "active", deletion_requested_at: null, deletion_scheduled_for: null })
          .where(eq(tenants.id, tenantId));
      }
    },
  );
});
