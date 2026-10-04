import { afterAll, beforeAll, describe, expect, test } from "bun:test";
import { and, eq } from "drizzle-orm";
import { setConnectorEnabled } from "../../connectors/service.ts";
import { auditLog, connectorMcpSessions, connectors, tenants } from "../../db/schema/index.ts";
import { createTestDb, type TestDb } from "../../db/tests/setup.ts";
import {
  getMcpConnector,
  getMcpSessionBackoff,
  listConnectableMcpConnectorsForTenant,
  parkMcpConnectorFailure,
  recordMcpHandshakeState,
  redactUpstreamDetail,
} from "./registry.ts";
import { seedMcpConnector } from "./test-fixtures.ts";

let ctx: TestDb;
let tenantA: string;
let tenantB: string;

beforeAll(async () => {
  ctx = await createTestDb("mcp-registry");
  const [a] = await ctx.db
    .insert(tenants)
    .values({ slug: "mcp-reg-a", display_name: "A" })
    .returning();
  const [b] = await ctx.db
    .insert(tenants)
    .values({ slug: "mcp-reg-b", display_name: "B" })
    .returning();
  if (!a || !b) throw new Error("tenant seed failed");
  tenantA = a.id;
  tenantB = b.id;
}, 60_000);

afterAll(async () => {
  await ctx.cleanup();
}, 30_000);

describe("getMcpConnector", () => {
  test("projects transport, url and the non-secret auth block off the connector row", async () => {
    const seeded = await seedMcpConnector(ctx.db, {
      tenant_id: tenantA,
      slug: "proj",
      url: "https://proj.example.test/mcp",
      auth: { kind: "bearer" },
      auth_type: "bearer",
    });
    const row = await getMcpConnector(ctx.db, tenantA, seeded.id);
    expect(row?.slug).toBe("proj");
    expect(row?.transport).toBe("http");
    expect(row?.url).toBe("https://proj.example.test/mcp");
    expect(row?.auth.kind).toBe("bearer");
    expect(row?.environment).toBe("prod");
    expect(row?.enabled).toBe(true);
  });

  test("another tenant's connector is invisible", async () => {
    const seeded = await seedMcpConnector(ctx.db, {
      tenant_id: tenantA,
      slug: "isolated",
      url: "https://isolated.example.test/mcp",
    });
    expect(await getMcpConnector(ctx.db, tenantB, seeded.id)).toBeNull();
  });

  test("a connector of another driver is not an mcp connector", async () => {
    const [row] = await ctx.db
      .insert(connectors)
      .values({
        tenant_id: tenantA,
        slug: "plain-http",
        display_name: "Plain HTTP",
        driver: "http",
        environment: "prod",
        base_url: "https://plain.example.test",
      })
      .returning();
    if (!row) throw new Error("seed failed");
    expect(await getMcpConnector(ctx.db, tenantA, row.id)).toBeNull();
  });
});

describe("listConnectableMcpConnectorsForTenant", () => {
  test("includes a degraded connector and excludes a disabled one", async () => {
    const healthy = await seedMcpConnector(ctx.db, {
      tenant_id: tenantB,
      slug: "healthy",
      url: "https://healthy.example.test/mcp",
    });
    const degraded = await seedMcpConnector(ctx.db, {
      tenant_id: tenantB,
      slug: "degraded",
      url: "https://degraded.example.test/mcp",
    });
    const off = await seedMcpConnector(ctx.db, {
      tenant_id: tenantB,
      slug: "switched-off",
      url: "https://off.example.test/mcp",
    });

    const degradedRow = await getMcpConnector(ctx.db, tenantB, degraded.id);
    if (!degradedRow) throw new Error("projection failed");
    await parkMcpConnectorFailure(
      ctx.db,
      degradedRow,
      "handshake failed",
      () => new Date(Date.now() + 60_000), // allow-wall-clock
    );
    await setConnectorEnabled(tenantB, off.id, false, null, ctx.db);

    const ids = (await listConnectableMcpConnectorsForTenant(ctx.db, tenantB)).map((r) => r.id);
    expect(ids).toContain(healthy.id);
    expect(ids).toContain(degraded.id);
    expect(ids).not.toContain(off.id);
  });
});

describe("handshake state", () => {
  test("a failure parks the connector degraded, arms a persisted backoff, and counts in the database", async () => {
    const seeded = await seedMcpConnector(ctx.db, {
      tenant_id: tenantA,
      slug: "parking",
      url: "https://parking.example.test/mcp",
    });
    const row = await getMcpConnector(ctx.db, tenantA, seeded.id);
    if (!row) throw new Error("projection failed");

    const first = await parkMcpConnectorFailure(
      ctx.db,
      row,
      "connect ECONNREFUSED https://parking.example.test/mcp?token=SECRET",
      (n) => new Date(Date.now() + n * 1_000), // allow-wall-clock
    );
    const second = await parkMcpConnectorFailure(
      ctx.db,
      row,
      "connect ECONNREFUSED",
      (n) => new Date(Date.now() + n * 1_000), // allow-wall-clock
    );
    expect(first).toBe(1);
    expect(second).toBe(2);

    const [connector] = await ctx.db
      .select({ health_state: connectors.health_state, last_error: connectors.last_error })
      .from(connectors)
      .where(eq(connectors.id, seeded.id));
    expect(connector?.health_state).toBe("degraded");
    expect(connector?.last_error ?? "").not.toContain("SECRET");
    expect(connector?.last_error ?? "").not.toContain("?");

    const backoff = await getMcpSessionBackoff(ctx.db, tenantA, seeded.id);
    expect(backoff?.consecutive_failures).toBe(2);
    expect(backoff?.backoff_until).not.toBeNull();
  });

  test("a success clears the failure text, resets the backoff and recovers health in one go", async () => {
    const seeded = await seedMcpConnector(ctx.db, {
      tenant_id: tenantA,
      slug: "recovering",
      url: "https://recovering.example.test/mcp",
    });
    const row = await getMcpConnector(ctx.db, tenantA, seeded.id);
    if (!row) throw new Error("projection failed");
    await parkMcpConnectorFailure(
      ctx.db,
      row,
      "handshake failed",
      () => new Date(Date.now() + 300_000), // allow-wall-clock
    );

    await recordMcpHandshakeState(ctx.db, row, "v1:manifest-hash");

    const [connector] = await ctx.db
      .select({ health_state: connectors.health_state, last_error: connectors.last_error })
      .from(connectors)
      .where(eq(connectors.id, seeded.id));
    expect(connector?.health_state).toBe("ok");
    expect(connector?.last_error).toBeNull();

    const [session] = await ctx.db
      .select()
      .from(connectorMcpSessions)
      .where(eq(connectorMcpSessions.connector_id, seeded.id));
    expect(session?.tools_manifest_hash).toBe("v1:manifest-hash");
    expect(session?.consecutive_failures).toBe(0);
    expect(session?.backoff_until).toBeNull();
    expect(session?.last_handshake_at).not.toBeNull();
  });

  test("no failure shape a handshake throws puts remote-authored text ON THE ROW", async () => {
    const seeded = await seedMcpConnector(ctx.db, {
      tenant_id: tenantA,
      slug: "shapes",
      url: "https://shapes.example.test/mcp",
    });
    const row = await getMcpConnector(ctx.db, tenantA, seeded.id);
    if (!row) throw new Error("projection failed");
    const persist = async (
      raw: string,
    ): Promise<{ last_error: string; health_reason: string; health_error_code: string }> => {
      await parkMcpConnectorFailure(
        ctx.db,
        row,
        raw,
        () => new Date(Date.now() + 1_000), // allow-wall-clock
      );
      const [c] = await ctx.db
        .select({
          last_error: connectors.last_error,
          health_reason: connectors.health_reason,
          health_error_code: connectors.health_error_code,
        })
        .from(connectors)
        .where(eq(connectors.id, seeded.id));
      return {
        last_error: c?.last_error ?? "",
        health_reason: c?.health_reason ?? "",
        health_error_code: c?.health_error_code ?? "",
      };
    };

    const echoed = await persist(
      'Error POSTing to endpoint (HTTP 401): {"error":"invalid_token","error_description":"Bearer eyJhbGciOiJIUzI1NiJ9.eyJzdWIiOiIxIn0.dBjftJeZ4CVPmB92K27uhbUJU1p1r_wW1gFWFOEjXk is expired"}',
    );
    expect(echoed.last_error).not.toContain("eyJhbGciOiJIUzI1NiJ9");
    expect(echoed.last_error).not.toContain("invalid_token");
    expect(echoed.health_reason).not.toContain("invalid_token");
    expect(echoed.health_error_code).toBe("auth_rejected");
    expect(echoed.last_error).toContain("[auth_rejected]");
    expect(echoed.last_error).toContain("shapes.example.test");
    expect(echoed.last_error).toContain("401");

    const inlineUrl = await persist(
      "fetch failed for https://shapes.example.test/mcp?access_token=SECRET123: ECONNRESET",
    );
    expect(inlineUrl.last_error).not.toContain("SECRET123");
    expect(inlineUrl.last_error).not.toContain("access_token");

    expect((await persist("x".repeat(2_000))).last_error.length).toBeLessThanOrEqual(301);

    const gone = await persist("Error POSTing to endpoint (HTTP 410): endpoint retired");
    expect(gone.last_error).toContain("[resource_not_found]");
    expect(gone.last_error).not.toContain("retired");
    expect(gone.health_error_code).toBe("auth_rejected");
  });

  test("the failure park emits exactly one health-changed row for a remote that keeps failing", async () => {
    const seeded = await seedMcpConnector(ctx.db, {
      tenant_id: tenantA,
      slug: "noisy",
      url: "https://noisy.example.test/mcp",
    });
    const row = await getMcpConnector(ctx.db, tenantA, seeded.id);
    if (!row) throw new Error("projection failed");
    for (let i = 0; i < 3; i++) {
      await parkMcpConnectorFailure(
        ctx.db,
        row,
        "handshake failed",
        () => new Date(Date.now() + 1_000), // allow-wall-clock
      );
    }
    const rows = await ctx.db
      .select({ id: auditLog.id })
      .from(auditLog)
      .where(
        and(eq(auditLog.resource_id, seeded.id), eq(auditLog.action, "connector.health_changed")),
      );
    expect(rows.length).toBe(1);
  });
});

describe("redactUpstreamDetail", () => {
  test("reduces every embedded URL to its origin, userinfo and query included", () => {
    const out = redactUpstreamDetail(
      "fetch failed for https://remote.example.test/mcp?access_token=SECRET while connecting",
    );
    expect(out).toContain("https://remote.example.test");
    expect(out).not.toContain("SECRET");
    expect(out).not.toContain("access_token");

    const userinfo = redactUpstreamDetail(
      "connect ECONNREFUSED https://svc:hunter2@remote.example.test/mcp",
    );
    expect(userinfo).toContain("https://remote.example.test");
    expect(userinfo).not.toContain("hunter2");
    expect(userinfo).not.toContain("svc:");

    const many = redactUpstreamDetail(
      "redirected from https://a.example.test/mcp?t=AAA to https://b.example.test/cb?code=BBB",
    );
    expect(many).not.toContain("AAA");
    expect(many).not.toContain("BBB");
  });

  test("a token the remote echoed back in its error BODY is redacted", () => {
    const bearer = redactUpstreamDetail(
      'Error POSTing to endpoint: {"error":"invalid_token","error_description":"Bearer eyJhbGciOiJIUzI1NiJ9.eyJzdWIiOiIxIn0.dBjftJeZ4CVPmB92K27uhbUJU1p1r_wW1gFWFOEjXk is expired"}',
    );
    expect(bearer).not.toContain("eyJhbGciOiJIUzI1NiJ9");
    expect(bearer).toContain("invalid_token");

    const vendorKey = redactUpstreamDetail(
      'Error POSTing to endpoint: {"message":"key sk-ant-api03-AbCdEfGhIjKlMnOpQrStUvWxYz0123456789 is revoked"}',
    );
    expect(vendorKey).not.toContain("sk-ant-api03-AbCdEfGhIjKlMnOpQrStUvWxYz0123456789");
  });

  test("the shapes that carry no secret survive verbatim", () => {
    expect(redactUpstreamDetail("authorization required")).toBe("authorization required");
    expect(redactUpstreamDetail("Error POSTing to endpoint (HTTP 401): unauthorized")).toContain(
      "401",
    );
    expect(redactUpstreamDetail("connect ECONNREFUSED 93.184.216.34:443")).toBe(
      "connect ECONNREFUSED 93.184.216.34:443",
    );
  });

  test("a verbose remote body cannot bloat the response it rides in", () => {
    expect(redactUpstreamDetail("x".repeat(500)).length).toBeLessThanOrEqual(301);
  });
});
