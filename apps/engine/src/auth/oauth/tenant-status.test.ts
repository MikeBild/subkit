import { afterAll, afterEach, beforeAll, expect, test } from "bun:test";
import { createHash } from "node:crypto";
import { and, eq } from "drizzle-orm";
import { _drainAuditWritesForTests } from "../../audit/audit.ts";
import { getConfig } from "../../config/loader.ts";
import { ConfigSchema } from "../../config/schema.ts";
import type { Db } from "../../db/client.ts";
import { hostedQuotaError } from "../../db/hosted-quota-errors.ts";
import { auditLog, mcpOauthAuthorizationCodes, sessions, tenants } from "../../db/schema/index.ts";
import { createTestDb, type TestDb } from "../../db/tests/setup.ts";
import { createSession, issueApiKey, provisionSelfServiceTenant } from "../../identity/index.ts";
import {
  getMetrics,
  METRIC_NAMES,
  resetMetricsRegistryForTests,
} from "../../observability/metrics.ts";
import { getTestNow } from "../../test-helpers/determinism/clock.ts";
import { waitFor } from "../../test-helpers/determinism/wait.ts";
import { configureHostedPolicyForTests } from "../../test-helpers/hosted-policy.ts";
import { issueBrowserSession } from "../browser-session.ts";
import { consumeCliLoginToken } from "./cli-session.ts";
import { CLI_LOGIN_SCOPE } from "./resources.ts";
import { createMcpOAuthProvider, type McpOAuthProvider } from "./server-provider.ts";
import { API_KEY_TOKEN_TYPE, exchangeApiKeyForToken } from "./token-exchange.ts";

let ctx: TestDb;
let tenantId: string;
let userId: string;
let provider: McpOAuthProvider;
let clientId: string;
let apiKey: string;
let config: ReturnType<typeof ConfigSchema.parse>;
const baseUrl = "https://engine.example.test";
const redirectUri = "https://client.example.test/callback";
const verifier = "dBjftJeZ4CVP-mB92K27uhbUJU1p1r_wW1gFWFOEjXk";
const challenge = createHash("sha256").update(verifier).digest("base64url");
beforeAll(async () => {
  ctx = await createTestDb("oauth-tenant-status");
  await configureHostedPolicyForTests(ctx.db, ctx.url);
  const fixture = await provisionSelfServiceTenant(
    {
      issuer_url: "https://identity.example.test",
      subject: "oauth-mint-status",
      email: "owner@example.test",
      email_verified: true,
    },
    ctx.db,
  );
  tenantId = fixture.tenant.id;
  userId = fixture.membership.user_id;
  config = ConfigSchema.parse({
    auth: {
      session: { secret: getConfig().auth.session.secret },
      hosted: { admission: getConfig().auth.hosted.admission },
    },
    database: { url: ctx.url },
    server: { public_base_url: baseUrl },
  });
  provider = createMcpOAuthProvider({ db: ctx.db, config });
  clientId = (await provider.registerClient({ redirect_uris: [redirectUri], scope: "mcp:read" }))
    .client_id;
  apiKey = (
    await issueApiKey(
      {
        issuer: { kind: "system" },
        tenant_id: tenantId,
        owner_kind: "user",
        owner_id: userId,
        actor: { kind: "system", id: null },
        scopes: ["*"],
      },
      ctx.db,
    )
  ).plaintext;
});
afterAll(async () => {
  if (ctx) await ctx.cleanup();
});
afterEach(async () => {
  await _drainAuditWritesForTests(ctx.db);
});
async function code(scope = "mcp:read", resource?: string) {
  return provider.issueAuthorizationCode({
    tenantId,
    userId,
    clientId,
    redirectUri,
    scope,
    codeChallenge: challenge,
    ...(resource ? { resource } : {}),
  });
}
async function pair(scope = "mcp:read", resource?: string) {
  const authorizationCode = await code(scope, resource);
  return provider.exchangeAuthorizationCode({
    code: authorizationCode,
    clientId,
    redirectUri,
    codeVerifier: verifier,
  });
}

function transientRetryCount() {
  return getMetrics().counterSum(METRIC_NAMES.DB_TRANSIENT_RETRIES_TOTAL);
}

async function holdTenantQuota() {
  const holder = await ctx.pool.connect();
  await holder.query("BEGIN");
  await holder.query("SELECT pg_advisory_xact_lock(hashtextextended($1::text,741937))", [tenantId]);
  return holder;
}

async function waitForRetry() {
  await waitFor(() => transientRetryCount() > 0, {
    tries: 500,
    sleepMs: 1,
    label: "MCP OAuth code issuance quota retry",
  });
}

async function issuedCounts() {
  const [codes, audits] = await Promise.all([
    ctx.db
      .select()
      .from(mcpOauthAuthorizationCodes)
      .where(eq(mcpOauthAuthorizationCodes.tenant_id, tenantId)),
    ctx.db
      .select()
      .from(auditLog)
      .where(and(eq(auditLog.tenant_id, tenantId), eq(auditLog.action, "mcp_oauth.code_issued"))),
  ]);
  return { codes: codes.length, audits: audits.length };
}

test("suspended tenants cannot issue authorization codes, browser sessions, keys or exchanged tokens", async () => {
  await ctx.db.update(tenants).set({ status: "suspended" }).where(eq(tenants.id, tenantId));
  try {
    await expect(code()).rejects.toMatchObject({ oauth_error: "invalid_grant" });
    expect(
      (
        await issueBrowserSession({
          db: ctx.db,
          tenantId,
          userId,
          redirectTo: "/cockpit",
          via: "test",
        })
      ).status,
    ).toBe(403);
    await expect(createSession({ tenant_id: tenantId, user_id: userId }, ctx.db)).rejects.toThrow(
      "tenant_unavailable",
    );
    await expect(
      issueApiKey(
        {
          issuer: { kind: "system" },
          tenant_id: tenantId,
          owner_kind: "user",
          owner_id: userId,
          actor: { kind: "system", id: null },
        },
        ctx.db,
      ),
    ).rejects.toThrow("tenant_unavailable");
    await expect(
      exchangeApiKeyForToken({
        db: ctx.db,
        subjectToken: apiKey,
        subjectTokenType: API_KEY_TOKEN_TYPE,
        requestSource: "api",
      }),
    ).rejects.toMatchObject({ oauth_error: "invalid_grant" });
    expect(
      await ctx.db.select().from(sessions).where(eq(sessions.tenant_id, tenantId)),
    ).toHaveLength(0);
  } finally {
    await ctx.db
      .update(tenants)
      .set({ status: "active", deletion_requested_at: null, deletion_scheduled_for: null })
      .where(eq(tenants.id, tenantId));
  }
});

test("codes, refresh tokens and CLI login grants stop after suspension or pending deletion", async () => {
  for (const status of ["suspended", "pending_deletion"] as const) {
    const authorizationCode = await code();
    const tokens = await pair();
    const cli = await pair(CLI_LOGIN_SCOPE, `${baseUrl}/v1/identity/cli-session`);
    await ctx.db
      .update(tenants)
      .set({
        status,
        ...(status === "pending_deletion"
          ? {
              deletion_requested_at: new Date(getTestNow()),
              deletion_scheduled_for: new Date(getTestNow() + 86_400_000),
            }
          : {}),
      })
      .where(eq(tenants.id, tenantId));
    try {
      await expect(
        provider.exchangeAuthorizationCode({
          code: authorizationCode,
          clientId,
          redirectUri,
          codeVerifier: verifier,
        }),
      ).rejects.toMatchObject({ oauth_error: "invalid_grant" });
      await expect(
        provider.exchangeRefreshToken({ refreshToken: tokens.refresh_token, clientId }),
      ).rejects.toMatchObject({ oauth_error: "invalid_grant" });
      expect(
        await consumeCliLoginToken({
          db: ctx.db,
          token: cli.access_token,
          publicBaseUrl: baseUrl,
          requestSource: "cli",
        }),
      ).toEqual({ ok: false, error: "invalid_token" });
    } finally {
      await ctx.db
        .update(tenants)
        .set({ status: "active", deletion_requested_at: null, deletion_scheduled_for: null })
        .where(eq(tenants.id, tenantId));
    }
  }
});

test("authorization code issuance retries a held tenant quota lock and persists one code and audit", async () => {
  await _drainAuditWritesForTests(ctx.db);
  resetMetricsRegistryForTests();
  const before = await issuedCounts();
  const holder = await holdTenantQuota();
  const issuance = code().then(
    (value) => ({ value }),
    (error: unknown) => ({ error }),
  );
  try {
    await waitForRetry();
    await holder.query("COMMIT");
    const outcome = await issuance;
    expect("value" in outcome ? outcome.value : undefined).toEqual(expect.any(String));
    expect(await issuedCounts()).toEqual({ codes: before.codes + 1, audits: before.audits + 1 });
    expect(transientRetryCount()).toBe(1);
  } finally {
    await holder.query("ROLLBACK").catch(() => {});
    holder.release();
  }
});

test("authorization code issuance exhaustion leaves no code or audit", async () => {
  await _drainAuditWritesForTests(ctx.db);
  resetMetricsRegistryForTests();
  const before = await issuedCounts();
  const holder = await holdTenantQuota();
  const issuance = code().then(
    (value) => ({ value }),
    (error: unknown) => ({ error }),
  );
  try {
    let failure: unknown;
    const outcome = await issuance;
    if ("error" in outcome) failure = outcome.error;
    expect(hostedQuotaError(failure)?.code).toBe("40001");
    expect(await issuedCounts()).toEqual(before);
    expect(transientRetryCount()).toBe(2);
  } finally {
    await holder.query("ROLLBACK").catch(() => {});
    holder.release();
  }
});

test("authorization code issuance does not retry an unrelated serialization error", async () => {
  const generic = Object.assign(new Error("unrelated_serialization"), { code: "40001" });
  let attempts = 0;
  const fake = createMcpOAuthProvider({
    db: {
      transaction: async () => {
        attempts++;
        throw generic;
      },
    } as unknown as Db,
    config,
  });
  await expect(
    fake.issueAuthorizationCode({
      tenantId,
      userId,
      clientId,
      redirectUri,
      scope: "mcp:read",
      codeChallenge: challenge,
    }),
  ).rejects.toBe(generic);
  expect(attempts).toBe(1);
});

test("authorization code issuance revalidates a tenant suspended between retry attempts", async () => {
  await _drainAuditWritesForTests(ctx.db);
  resetMetricsRegistryForTests();
  const before = await issuedCounts();
  const holder = await holdTenantQuota();
  const issuance = code().then(
    (value) => ({ value }),
    (error: unknown) => ({ error }),
  );
  try {
    await waitForRetry();
    await ctx.db.update(tenants).set({ status: "suspended" }).where(eq(tenants.id, tenantId));
    await holder.query("COMMIT");
    const outcome = await issuance;
    expect("error" in outcome ? outcome.error : undefined).toMatchObject({
      oauth_error: "invalid_grant",
    });
    expect(await issuedCounts()).toEqual(before);
  } finally {
    await ctx.db
      .update(tenants)
      .set({ status: "active", deletion_requested_at: null, deletion_scheduled_for: null })
      .where(eq(tenants.id, tenantId));
    await holder.query("ROLLBACK").catch(() => {});
    holder.release();
  }
});
