import { expect, spyOn, test } from "bun:test";
import { exportPKCS8, generateKeyPair } from "jose";
import { createDbFromUrl } from "../../db/client.ts";
import { authIdentities, tenants } from "../../db/schema/index.ts";
import { createTestDb } from "../../db/tests/setup.ts";
import { logger } from "../../logging/logger.ts";
import { getTestNow } from "../../test-helpers/determinism/clock.ts";
import { configureHostedPolicyForTests } from "../../test-helpers/hosted-policy.ts";
import { _withEgressTenantOriginForTests } from "../egress-guard.ts";
import type { ConnectorView } from "../types.ts";
import { query } from "./graphql.ts";
import { executePlannedHttpRequest } from "./http.ts";

function connector(baseUrl: string): ConnectorView {
  return {
    id: "00000000-0000-4000-8000-000000000001",
    tenant_id: "00000000-0000-4000-8000-000000000002",
    slug: "signed-graphql",
    display_name: "Signed GraphQL fixture",
    description: null,
    description_source: "human",
    category: "",
    category_source: "human",
    driver: "graphql",
    environment: "dev",
    auth_type: "signed_jwt",
    base_url: baseUrl,
    dsn: null,
    config: { signed_jwt: { algorithm: "ES256", audience: "fixture" } },
    operator_quirks: {},
    template_slug: null,
    template_name: null,
    template_source: null,
    template_version: null,
    template_snapshot: null,
    self_description: {},
    created_at: new Date(getTestNow()),
    updated_at: new Date(getTestNow()),
    enabled: true,
    last_error: null,
    circuit_state: "closed",
    circuit_opened_at: null,
    circuit_failure_count: 0,
    circuit_threshold: 5,
    circuit_reset_ms: 30000,
    needs_reauth: false,
    auth_failed_at: null,
    auth_failed_reason: null,
    health_state: "unknown",
    health_reason: null,
    health_error_code: null,
    sunset_at: null,
    successor_uri: null,
  };
}

test("signed GraphQL error echoes are redacted before logging and returning", async () => {
  const database = createDbFromUrl("postgresql://127.0.0.1:1/unused");
  const pair = await generateKeyPair("ES256", { extractable: true });
  const privateKey = await exportPKCS8(pair.privateKey);
  let token = "";
  const warnings: unknown[] = [];
  const warn = spyOn(logger, "warn").mockImplementation((entry: unknown) => {
    warnings.push(entry);
  });
  const server = Bun.serve({
    hostname: "127.0.0.1",
    port: 0,
    fetch(request) {
      token = (request.headers.get("authorization") ?? "").replace(/^Bearer /, "");
      return Response.json(
        { errors: [{ message: `provider rejected ${token}` }] },
        { headers: { "x-provider-echo": token } },
      );
    },
  });
  try {
    const fixture = connector(`http://127.0.0.1:${server.port}/graphql`);
    const response = await _withEgressTenantOriginForTests(
      async () => "self_hosted",
      () =>
        query({
          db: database.db,
          tenant_id: fixture.tenant_id,
          connector: fixture,
          credential_override: { mode: "signed_jwt", private_key: privateKey },
          query: "query Fixture { value }",
        }),
    );
    expect(token.split(".")).toHaveLength(3);
    expect(warnings).toHaveLength(1);
    expect(JSON.stringify(warnings).includes(token)).toBe(false);
    expect(JSON.stringify(response).includes(token)).toBe(false);
    expect(response.body).toEqual({ errors: [{ message: "provider rejected [REDACTED]" }] });
    expect(response.headers["x-provider-echo"]).toBe("[REDACTED]");
    expect(database.pool.totalCount).toBe(0);
  } finally {
    warn.mockRestore();
    await server.stop(true);
    await database.pool.end();
  }
});

test("signed transports retain the supplied tenant database for egress checks", async () => {
  const database = await createTestDb("signed-transport-egress");
  const pair = await generateKeyPair("ES256", { extractable: true });
  const privateKey = await exportPKCS8(pair.privateKey);
  let requests = 0;
  const server = Bun.serve({
    hostname: "127.0.0.1",
    port: 0,
    fetch() {
      requests++;
      return Response.json({ data: { ok: true } });
    },
  });
  try {
    const baseUrl = `http://127.0.0.1:${server.port}/graphql`;
    const [tenant] = await database.db
      .insert(tenants)
      .values({
        slug: "signed-transport-self-hosted",
        display_name: "Signed transport fixture",
      })
      .returning();
    if (!tenant) throw new Error("missing fixture tenant");
    const fixture = { ...connector(baseUrl), tenant_id: tenant.id };
    const credential = { mode: "signed_jwt" as const, private_key: privateKey };
    const response = await query({
      db: database.db,
      tenant_id: tenant.id,
      connector: fixture,
      credential_override: credential,
      query: "query Fixture { value }",
    });
    expect(response.status).toBe(200);
    await database.db.transaction(async (tx) => {
      const [uncommitted] = await tx
        .insert(tenants)
        .values({
          slug: "signed-transport-transaction",
          display_name: "Uncommitted transport fixture",
        })
        .returning();
      if (!uncommitted) throw new Error("missing transaction fixture tenant");
      const http = await executePlannedHttpRequest({
        exec: tx,
        tenant_id: uncommitted.id,
        method: "GET",
        url: new URL(baseUrl),
        headers: {},
        signal: new AbortController().signal,
        signed_jwt: {
          connector: { ...fixture, tenant_id: uncommitted.id, driver: "http" },
          credential,
        },
      });
      expect(http.status).toBe(200);
    });
    await configureHostedPolicyForTests(database.db, database.url);
    const [owner] = await database.db
      .insert(authIdentities)
      .values({
        issuer_url: "https://identity.example.test",
        subject: "signed-transport-owner",
        email: "signed-transport@example.test",
      })
      .returning();
    if (!owner) throw new Error("missing Hosted fixture owner");
    const [hosted] = await database.db
      .insert(tenants)
      .values({
        slug: "signed-transport-hosted",
        display_name: "Hosted transport fixture",
        origin: "self_service",
        owner_identity_id: owner.id,
      })
      .returning();
    if (!hosted) throw new Error("missing Hosted fixture tenant");
    await expect(
      query({
        db: database.db,
        tenant_id: hosted.id,
        connector: { ...fixture, tenant_id: hosted.id },
        credential_override: credential,
        query: "query Fixture { value }",
      }),
    ).rejects.toThrow("private_ip_blocked");
    await expect(
      executePlannedHttpRequest({
        exec: database.db,
        tenant_id: hosted.id,
        method: "GET",
        url: new URL(baseUrl),
        headers: {},
        signal: new AbortController().signal,
        signed_jwt: { connector: { ...fixture, tenant_id: hosted.id, driver: "http" }, credential },
      }),
    ).rejects.toThrow("private_ip_blocked");
    expect(requests).toBe(2);
  } finally {
    await server.stop(true);
    await database.cleanup();
  }
});
