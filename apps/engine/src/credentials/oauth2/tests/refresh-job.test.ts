// Integration tests for handleRefreshJob — the `connector.refresh-oauth`
// pg-boss job body fed by the scheduler's keep-alive sweep
// (runOAuth2RefreshKeepAliveForTenant). Same mock-IdP fixture as
// refresh.test.ts, but driven through the job entry point: load row by id,
// guard, decrypt via the service, delegate to refreshIfStale.

import { afterAll, beforeAll, describe, expect, test } from "bun:test";
import { eq } from "drizzle-orm";

import { connectors, credentials, tenants } from "../../../db/schema/index.ts";
import { createTestDb, type TestDb } from "../../../db/tests/setup.ts";
import { getCredentialForConnector, upsertCredential } from "../../service.ts";
import { __resetOAuth2CacheForTests, runClientCredentialsGrant } from "../client.ts";
import { handleRefreshJob } from "../refresh-worker.ts";
import { type MockOAuthServer, startMockOAuthServer } from "./mock-server.ts";

let ctx: TestDb;
let mock: MockOAuthServer;
let tenantId: string;
let connectorId: string;

beforeAll(async () => {
  ctx = await createTestDb("oauth2_refresh_job");
  mock = await startMockOAuthServer();
  __resetOAuth2CacheForTests();
  const [t] = await ctx.db
    .insert(tenants)
    .values({ slug: "rjt", display_name: "refresh job tenant" })
    .returning();
  tenantId = t!.id;
  const [c] = await ctx.db
    .insert(connectors)
    .values({
      tenant_id: tenantId,
      slug: "rjt-svc",
      display_name: "RJT service",
      driver: "http",
      environment: "dev",
      auth_type: "oauth2",
      base_url: "https://example.test",
      config: {
        oauth: {
          issuer_url: mock.baseUrl,
          client_id: "rjt-client",
          client_secret: "rjt-secret",
          scope: "read",
        },
      },
    })
    .returning();
  connectorId = c!.id;
});

afterAll(async () => {
  await mock.close();
  __resetOAuth2CacheForTests();
  await ctx.cleanup();
});

describe("connector.refresh-oauth job", () => {
  test("stale credential is refreshed, persisted, and updated_at bumped; a fresh one is a no-op", async () => {
    mock.setExpiresIn(1);
    const initial = await runClientCredentialsGrant({
      issuer_url: mock.baseUrl,
      client_id: "rjt-client",
      client_secret: "rjt-secret",
      scope: "read",
    });
    expect(initial.refresh_token).toBeTruthy();

    const row = await upsertCredential(
      {
        tenant_id: tenantId,
        connector_id: connectorId,
        environment: "dev",
        mode: "oauth2",
        value: {
          mode: "oauth2",
          access_token: initial.access_token,
          token_type: initial.token_type,
        },
        oauth2_refresh_token: initial.refresh_token,
        oauth2_expires_at: initial.expires_at,
        actor_id: null,
      },
      ctx.db,
    );
    // Backdate updated_at so the "token last exercised" bump is observable.
    const backdated = new Date("2026-01-01T00:00:00.000Z");
    await ctx.db
      .update(credentials)
      .set({ updated_at: backdated })
      .where(eq(credentials.id, row.id));

    // Wait past expiry so the job's refreshIfStale actually refreshes.
    await new Promise((r) => setTimeout(r, 1200)); // allow-wall-clock: token-refresh skew window for the OAuth2 fixture clock
    mock.setExpiresIn(3600);

    await handleRefreshJob(ctx.db, { tenant_id: tenantId, credential_id: row.id });

    expect(mock.lastGrantType()).toBe("refresh_token");
    const persisted = await getCredentialForConnector(tenantId, connectorId, "dev", ctx.db);
    expect(persisted).not.toBeNull();
    if (persisted!.value.mode !== "oauth2") throw new Error("wrong mode");
    expect(persisted!.value.access_token).not.toBe(initial.access_token);
    expect(persisted!.row.updated_at.getTime()).toBeGreaterThan(backdated.getTime());

    // Immediate second run: token is fresh for 3600s → no second IdP hit.
    const issuedBefore = mock.issuedCount();
    await handleRefreshJob(ctx.db, { tenant_id: tenantId, credential_id: row.id });
    expect(mock.issuedCount()).toBe(issuedBefore);
  });

  test("missing credential id returns without throwing", async () => {
    await handleRefreshJob(ctx.db, {
      tenant_id: tenantId,
      credential_id: "00000000-0000-0000-0000-000000000000",
    });
  });

  test("credential without a refresh token returns without an IdP hit", async () => {
    const [c] = await ctx.db
      .insert(connectors)
      .values({
        tenant_id: tenantId,
        slug: "rjt-no-rt",
        display_name: "RJT no refresh token",
        driver: "http",
        environment: "dev",
        auth_type: "oauth2",
        base_url: "https://example.test",
        config: {
          oauth: {
            issuer_url: mock.baseUrl,
            client_id: "rjt-client",
            client_secret: "rjt-secret",
            scope: "read",
          },
        },
      })
      .returning();
    const row = await upsertCredential(
      {
        tenant_id: tenantId,
        connector_id: c!.id,
        environment: "dev",
        mode: "oauth2",
        value: { mode: "oauth2", access_token: "at", token_type: "bearer" },
        actor_id: null,
      },
      ctx.db,
    );
    const issuedBefore = mock.issuedCount();
    await handleRefreshJob(ctx.db, { tenant_id: tenantId, credential_id: row.id });
    expect(mock.issuedCount()).toBe(issuedBefore);
  });
});
