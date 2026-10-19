import { afterAll, afterEach, beforeAll, expect, test } from "bun:test";
import { and, eq } from "drizzle-orm";
import {
  auditLog,
  connectors,
  credentials,
  outboundConnections,
  runtimeSecretVersions,
  tenants,
} from "../../../db/schema/index.ts";
import { TEST_DB_HOOK_TIMEOUT } from "../../../db/tests/setup.ts";
import { tenantWorkSnapshot } from "../../../execution/index.ts";
import { createHttpTestServer, type HttpTestServer } from "../../../http/tests/setup.ts";
import { createSecretVersion } from "../../../runtime-config/service.ts";
import { getTestNow } from "../../../test-helpers/determinism/clock.ts";
import { withDriverFetchForTests } from "../../../test-helpers/driver-fetch.ts";
import { handleRefreshJob, refreshIfStale } from "../../oauth2/refresh-worker.ts";
import { getCredentialForConnector, upsertCredential } from "../../service.ts";
import {
  CONNECTION_REFRESH_PASS_LIMIT,
  readAccessToken,
  refreshDueConnections,
  secretNames,
} from "../service.ts";

let server: HttpTestServer;
let sequence = 0;

beforeAll(async () => {
  server = await createHttpTestServer("connection-refresh-lifecycle");
}, TEST_DB_HOOK_TIMEOUT);
afterEach(async () => {
  await server.db.delete(outboundConnections);
  await server.db.delete(runtimeSecretVersions);
});
afterAll(async () => {
  if (server) await server.cleanup();
}, TEST_DB_HOOK_TIMEOUT);

async function tenant() {
  const [row] = await server.db
    .insert(tenants)
    .values({ slug: `refresh-lifecycle-${++sequence}`, display_name: "Refresh fixture" })
    .returning();
  if (!row) throw new Error("missing tenant fixture");
  return row.id;
}

async function connection(tenantId: string) {
  const name = `connection-${++sequence}`;
  const names = secretNames(tenantId, name);
  const access = await createSecretVersion(server.db, {
    name: names.access,
    value: "initial-access",
    created_by: null,
  });
  const refresh = await createSecretVersion(server.db, {
    name: names.refresh,
    value: "initial-refresh",
    created_by: null,
  });
  const [row] = await server.db
    .insert(outboundConnections)
    .values({
      tenant_id: tenantId,
      name,
      base_url: "https://issuer.example.test",
      issuer: "https://issuer.example.test",
      authorization_endpoint: "https://issuer.example.test/authorize",
      token_endpoint: "https://issuer.example.test/token",
      client_id: "fixture-client",
      scopes: ["read"],
      granted_scopes: ["read"],
      access_token_version: access.version,
      refresh_token_version: refresh.version,
      expires_at: new Date(getTestNow() - 1000),
    })
    .returning();
  if (!row) throw new Error("missing connection fixture");
  return row;
}

function withFetch<T>(run: () => Promise<Response>, work: () => Promise<T>) {
  const fetchImpl = Object.assign(run, { preconnect: () => {} }) as typeof fetch;
  return withDriverFetchForTests(fetchImpl, work);
}

function tokenResponse() {
  return Response.json({
    access_token: "renewed-access",
    refresh_token: "renewed-refresh",
    token_type: "Bearer",
    expires_in: 3600,
    scope: "read",
  });
}

function deferred<T>() {
  let resolve!: (value: T) => void;
  const promise = new Promise<T>((finish) => {
    resolve = finish;
  });
  return { promise, resolve };
}

async function persisted(id: string, tenantId: string) {
  const [row] = await server.db
    .select()
    .from(outboundConnections)
    .where(and(eq(outboundConnections.id, id), eq(outboundConnections.tenant_id, tenantId)));
  return row;
}

async function refreshAudits(tenantId: string) {
  return server.db
    .select()
    .from(auditLog)
    .where(and(eq(auditLog.tenant_id, tenantId), eq(auditLog.resource_type, "connection")));
}

test("suspended due tenants produce no provider dispatch or failure write", async () => {
  const owner = await tenant();
  const row = await connection(owner);
  await server.db.update(tenants).set({ status: "suspended" }).where(eq(tenants.id, owner));
  let calls = 0;
  await withFetch(
    async () => {
      calls++;
      return tokenResponse();
    },
    async () => {
      expect(await refreshDueConnections(server.db)).toEqual({ refreshed: 0, failed: 0 });
    },
  );
  expect(calls).toBe(0);
  expect((await persisted(row.id, owner))?.last_error).toBeNull();
  expect(await refreshAudits(owner)).toHaveLength(0);
});

for (const refused of [false, true]) {
  test(`the actual refresh remains registered through suspension and ${refused ? "refusal" : "success"}`, async () => {
    const owner = await tenant();
    const row = await connection(owner);
    const entered = deferred<void>();
    const reply = deferred<Response>();
    await withFetch(
      async () => {
        entered.resolve();
        return reply.promise;
      },
      async () => {
        const pending = readAccessToken(server.db, owner, row.id);
        await entered.promise;
        expect(tenantWorkSnapshot(owner).in_flight).toBeGreaterThan(0);
        await server.db.update(tenants).set({ status: "suspended" }).where(eq(tenants.id, owner));
        expect(tenantWorkSnapshot(owner).in_flight).toBeGreaterThan(0);
        reply.resolve(
          refused ? Response.json({ error: "invalid_grant" }, { status: 400 }) : tokenResponse(),
        );
        expect(await pending).toBeNull();
      },
    );
    expect(tenantWorkSnapshot(owner).in_flight).toBe(0);
    const current = await persisted(row.id, owner);
    expect(current?.access_token_version).toBe(row.access_token_version);
    expect(current?.refresh_token_version).toBe(row.refresh_token_version);
    expect(current?.last_error).toBeNull();
    expect(current?.last_refreshed_at).toBeNull();
    expect(await refreshAudits(owner)).toHaveLength(0);
    const versions = await server.db.select().from(runtimeSecretVersions);
    expect(versions).toHaveLength(2);
  });
}

test("an authority change during refresh prevents token persistence and stale failure audit", async () => {
  const owner = await tenant();
  const row = await connection(owner);
  const neighborOwner = await tenant();
  const neighbor = await connection(neighborOwner);
  const entered = deferred<void>();
  const reply = deferred<Response>();
  await withFetch(
    async () => {
      entered.resolve();
      return reply.promise;
    },
    async () => {
      const pending = readAccessToken(server.db, owner, row.id);
      await entered.promise;
      await server.db
        .update(outboundConnections)
        .set({ authority_revision: 2 })
        .where(and(eq(outboundConnections.id, row.id), eq(outboundConnections.tenant_id, owner)));
      reply.resolve(tokenResponse());
      expect(await pending).toBeNull();
    },
  );
  expect((await persisted(row.id, owner))?.access_token_version).toBe(row.access_token_version);
  expect((await persisted(row.id, owner))?.last_error).toBeNull();
  expect(await refreshAudits(owner)).toHaveLength(0);
  expect(await persisted(neighbor.id, neighborOwner)).toEqual(neighbor);
  expect(await server.db.select().from(runtimeSecretVersions)).toHaveLength(4);
});

test("OAuth queue and inline refresh reject a foreign credential tenant before provider use", async () => {
  const owner = await tenant();
  const foreign = await tenant();
  const [connector] = await server.db
    .insert(connectors)
    .values({
      tenant_id: owner,
      slug: "refresh-owner",
      display_name: "Refresh owner",
      driver: "http",
      environment: "dev",
      auth_type: "oauth2",
      base_url: "https://issuer.example.test",
    })
    .returning();
  if (!connector) throw new Error("missing connector fixture");
  await upsertCredential(
    {
      tenant_id: owner,
      connector_id: connector.id,
      environment: "dev",
      mode: "oauth2",
      value: { mode: "oauth2", access_token: "old-access", token_type: "Bearer" },
      oauth2_refresh_token: "old-refresh",
      actor_id: null,
    },
    server.db,
  );
  const fetched = await getCredentialForConnector(owner, connector.id, "dev", server.db);
  if (fetched?.value.mode !== "oauth2") throw new Error("missing OAuth fixture");
  const oauth = fetched.value;
  let calls = 0;
  await withFetch(
    async () => {
      calls++;
      return tokenResponse();
    },
    async () => {
      await handleRefreshJob(server.db, { tenant_id: foreign, credential_id: fetched.row.id });
      await expect(refreshIfStale(server.db, foreign, fetched.row, oauth)).rejects.toThrow(
        "credential_tenant_mismatch",
      );
    },
  );
  expect(calls).toBe(0);
});

test("one global pass refreshes at most sixty-four connections across tenants", async () => {
  const owners = [await tenant(), await tenant()];
  for (let i = 0; i < CONNECTION_REFRESH_PASS_LIMIT + 1; i++) {
    const owner = owners[i % 2];
    if (!owner) throw new Error("missing owner fixture");
    await connection(owner);
  }
  let calls = 0;
  await withFetch(
    async () => {
      calls++;
      return tokenResponse();
    },
    async () => {
      expect(await refreshDueConnections(server.db)).toEqual({ refreshed: 64, failed: 0 });
      expect(calls).toBe(64);
      expect(await refreshDueConnections(server.db)).toEqual({ refreshed: 1, failed: 0 });
    },
  );
  expect(calls).toBe(65);
  for (const owner of owners) expect(tenantWorkSnapshot(owner).in_flight).toBe(0);
});

async function oauthFixture(owner: string) {
  const [connector] = await server.db
    .insert(connectors)
    .values({
      tenant_id: owner,
      slug: `oauth-lifecycle-${++sequence}`,
      display_name: "OAuth lifecycle",
      driver: "http",
      environment: "dev",
      auth_type: "oauth2",
      base_url: "https://issuer.example.test",
      config: {
        oauth: {
          issuer_url: "https://issuer.example.test",
          client_id: "fixture-client",
          grant_type: "client_credentials_json",
          token_endpoint: "https://issuer.example.test/token",
          token_response_format: "json",
          token_request_body_mapping: { client_id: "fixture-client" },
        },
      },
    })
    .returning();
  if (!connector) throw new Error("missing OAuth connector");
  await upsertCredential(
    {
      tenant_id: owner,
      connector_id: connector.id,
      environment: "dev",
      mode: "oauth2",
      value: { mode: "oauth2", access_token: "oauth-initial", token_type: "Bearer" },
      oauth2_expires_at: new Date(getTestNow() - 1000),
      actor_id: null,
    },
    server.db,
  );
  const fetched = await getCredentialForConnector(owner, connector.id, "dev", server.db);
  if (fetched?.value.mode !== "oauth2") throw new Error("missing OAuth credential");
  return { row: fetched.row, connector, value: fetched.value };
}

test("standalone OAuth refresh denies suspended tenancy before provider use", async () => {
  const owner = await tenant();
  const fixture = await oauthFixture(owner);
  await server.db.update(tenants).set({ status: "suspended" }).where(eq(tenants.id, owner));
  let calls = 0;
  await withFetch(
    async () => {
      calls++;
      return tokenResponse();
    },
    async () => {
      await expect(refreshIfStale(server.db, owner, fixture.row, fixture.value)).rejects.toThrow(
        "tenant_unavailable",
      );
    },
  );
  expect(calls).toBe(0);
  expect(tenantWorkSnapshot(owner).in_flight).toBe(0);
});

for (const refused of [false, true]) {
  test(`standalone OAuth retains actual work through suspension and ${refused ? "refusal" : "success"}`, async () => {
    const owner = await tenant();
    const fixture = await oauthFixture(owner);
    const entered = deferred<void>();
    const reply = deferred<Response>();
    const beforeAudit = await server.db
      .select()
      .from(auditLog)
      .where(eq(auditLog.tenant_id, owner));
    await withFetch(
      async () => {
        entered.resolve();
        return reply.promise;
      },
      async () => {
        const pending = refreshIfStale(server.db, owner, fixture.row, fixture.value);
        void pending.catch(() => {});
        await entered.promise;
        expect(tenantWorkSnapshot(owner).in_flight).toBeGreaterThan(0);
        await server.db.update(tenants).set({ status: "suspended" }).where(eq(tenants.id, owner));
        expect(tenantWorkSnapshot(owner).in_flight).toBeGreaterThan(0);
        reply.resolve(
          refused ? Response.json({ error: "invalid_grant" }, { status: 400 }) : tokenResponse(),
        );
        await expect(pending).rejects.toThrow("tenant_unavailable");
      },
    );
    expect(tenantWorkSnapshot(owner).in_flight).toBe(0);
    const [current] = await server.db
      .select()
      .from(credentials)
      .where(and(eq(credentials.id, fixture.row.id), eq(credentials.tenant_id, owner)));
    expect(current?.credential_generation).toBe(fixture.row.credential_generation);
    expect(current?.ciphertext).toEqual(fixture.row.ciphertext);
    const [connector] = await server.db
      .select()
      .from(connectors)
      .where(and(eq(connectors.id, fixture.connector.id), eq(connectors.tenant_id, owner)));
    expect(connector?.needs_reauth).toBe(false);
    const afterAudit = await server.db.select().from(auditLog).where(eq(auditLog.tenant_id, owner));
    expect(afterAudit).toEqual(beforeAudit);
  });
}

test("standalone OAuth generation CAS refuses a stale provider result without replacing current credentials", async () => {
  const owner = await tenant();
  const fixture = await oauthFixture(owner);
  const entered = deferred<void>();
  const reply = deferred<Response>();
  await withFetch(
    async () => {
      entered.resolve();
      return reply.promise;
    },
    async () => {
      const pending = refreshIfStale(server.db, owner, fixture.row, fixture.value);
      void pending.catch(() => {});
      await entered.promise;
      await server.db
        .update(credentials)
        .set({ credential_generation: fixture.row.credential_generation + 1 })
        .where(and(eq(credentials.id, fixture.row.id), eq(credentials.tenant_id, owner)));
      reply.resolve(tokenResponse());
      await expect(pending).rejects.toThrow("credential changed during refresh");
    },
  );
  const [current] = await server.db
    .select()
    .from(credentials)
    .where(and(eq(credentials.id, fixture.row.id), eq(credentials.tenant_id, owner)));
  expect(current?.ciphertext).toEqual(fixture.row.ciphertext);
  expect(current?.credential_generation).toBe(fixture.row.credential_generation + 1);
  expect(tenantWorkSnapshot(owner).in_flight).toBe(0);
});
