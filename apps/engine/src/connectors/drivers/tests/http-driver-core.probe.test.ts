import { afterAll, beforeAll, describe, expect, test } from "bun:test";
import type { IncomingMessage, ServerResponse } from "node:http";
import { upsertCredential } from "../../../credentials/service.ts";
import { createTestDb, type TestDb } from "../../../db/tests/setup.ts";
import {
  createMockServer,
  jsonResponse,
  type MockServer,
} from "../../../test-helpers/mock-http.ts";
import { seedTenant } from "../../../test-helpers/seed.ts";
import type { ConnectorView } from "../../types.ts";
import { probeHttpConnector } from "../http.ts";
import { httpDriverCoreFixtures } from "./http-driver-core-fixtures.ts";

let ctx: TestDb;

let tenantId: string;

let mock: MockServer;

let lastRequest: { method: string; url: string; headers: Record<string, string> } | null = null;

beforeAll(async () => {
  ctx = await createTestDb("http-driver-core");
  const tenant = await seedTenant(ctx.db, {
    slug: "http-driver-core",
    display_name: "HTTP driver core",
  });
  tenantId = tenant.id;
  mock = await createMockServer((req: IncomingMessage, res: ServerResponse) => {
    lastRequest = {
      method: req.method ?? "GET",
      url: req.url ?? "",
      headers: req.headers as Record<string, string>,
    };
    jsonResponse(res, 200, { ok: true });
  });
});

afterAll(async () => {
  await mock.close();
  await ctx.cleanup();
});

const { makeConnector } = httpDriverCoreFixtures({
  get tenantId() {
    return tenantId;
  },
  get mock() {
    return mock;
  },
  get ctx() {
    return ctx;
  },
});

describe("probeHttpConnector", () => {
  test("no base_url short-circuits with ok:false and a descriptive detail", async () => {
    const conn = await makeConnector({ auth_type: "none" });
    const noUrlConn: ConnectorView = { ...conn, base_url: null };
    const probe = await probeHttpConnector({
      db: ctx.db,
      tenant_id: tenantId,
      connector: noUrlConn,
    });
    expect(probe.ok).toBe(false);
    expect(probe.detail).toContain("no base_url");
  });

  test("auth_type != none with no persisted credential returns credential_missing", async () => {
    const conn = await makeConnector({ auth_type: "bearer" });
    const probe = await probeHttpConnector({ db: ctx.db, tenant_id: tenantId, connector: conn });
    expect(probe.ok).toBe(false);
    expect(probe.error_code).toBe("credential_missing");
    expect(probe.warnings[0]?.code).toBe("CREDENTIAL_REQUIRED");
  });

  test("fallback GET / probe against a healthy 200 endpoint is ok", async () => {
    const conn = await makeConnector({ auth_type: "none" });
    const probe = await probeHttpConnector({ db: ctx.db, tenant_id: tenantId, connector: conn });
    expect(probe.ok).toBe(true);
    expect(probe.status).toBe(200);
    expect(probe.warning_only).toBe(false);
  });

  test("fallback probe 404 is treated as ambiguous-but-ok (warning_only)", async () => {
    mock.setHandler((_req, res) => {
      res.statusCode = 404;
      res.end("not found");
    });
    const conn = await makeConnector({ auth_type: "none" });
    const probe = await probeHttpConnector({ db: ctx.db, tenant_id: tenantId, connector: conn });
    expect(probe.ok).toBe(true);
    expect(probe.warning_only).toBe(true);
    expect(probe.warnings[0]?.code).toBe("PROBE_AMBIGUOUS");
    mock.setHandler((req: IncomingMessage, res: ServerResponse) => {
      lastRequest = {
        method: req.method ?? "GET",
        url: req.url ?? "",
        headers: req.headers as Record<string, string>,
      };
      jsonResponse(res, 200, { ok: true });
    });
  });

  test("fallback probe 401 is unambiguous and not-ok with credential_invalid classification", async () => {
    mock.setHandler((_req, res) => {
      res.statusCode = 401;
      res.setHeader("www-authenticate", 'Bearer realm="x"');
      jsonResponse(res, 401, { error: "unauthorized" });
    });
    const conn = await makeConnector({ auth_type: "none" });
    const probe = await probeHttpConnector({ db: ctx.db, tenant_id: tenantId, connector: conn });
    expect(probe.ok).toBe(false);
    expect(probe.error_code).toBe("credential_invalid");
    expect(probe.response_headers?.["www-authenticate"]).toBe('Bearer realm="x"');
    mock.setHandler((req: IncomingMessage, res: ServerResponse) => {
      lastRequest = {
        method: req.method ?? "GET",
        url: req.url ?? "",
        headers: req.headers as Record<string, string>,
      };
      jsonResponse(res, 200, { ok: true });
    });
  });

  test("a signed fallback probe answered 401 or 403 reports the credential as unverified, not rejected", async () => {
    for (const status of [401, 403]) {
      mock.setHandler((_req, res) => jsonResponse(res, status, { error: "unauthorized" }));
      const conn = await makeConnector({ auth_type: "bearer" });
      const probe = await probeHttpConnector({
        db: ctx.db,
        tenant_id: tenantId,
        connector: conn,
        credential_override: { mode: "bearer", token: "valid-token" },
      });
      expect(probe.ok).toBe(false);
      expect(probe.status).toBe(status);
      expect(probe.error_code).toBe("credential_unverified");
      expect(probe.warning_only).toBe(true);
      expect(probe.warnings).toHaveLength(1);
      expect(probe.warnings[0]?.code).toBe("PROBE_AUTH_UNVERIFIED");
      expect(probe.warnings[0]?.message).toContain("config.probe_endpoint");
    }
    mock.setHandler((req: IncomingMessage, res: ServerResponse) => {
      lastRequest = {
        method: req.method ?? "GET",
        url: req.url ?? "",
        headers: req.headers as Record<string, string>,
      };
      jsonResponse(res, 200, { ok: true });
    });
  });

  test("a configured probe_endpoint answered 401 keeps rejecting the credential", async () => {
    mock.setHandler((_req, res) => jsonResponse(res, 401, { error: "unauthorized" }));
    const conn = await makeConnector({
      auth_type: "bearer",
      config: {
        probe_endpoint: { method: "GET", path: "/users/me", expected_status: [200, 200] },
      },
    });
    const probe = await probeHttpConnector({
      db: ctx.db,
      tenant_id: tenantId,
      connector: conn,
      credential_override: { mode: "bearer", token: "revoked-token" },
    });
    expect(probe.ok).toBe(false);
    expect(probe.error_code).toBe("credential_invalid");
    expect(probe.warning_only).toBe(false);
    expect(probe.warnings).toEqual([]);
    mock.setHandler((req: IncomingMessage, res: ServerResponse) => {
      lastRequest = {
        method: req.method ?? "GET",
        url: req.url ?? "",
        headers: req.headers as Record<string, string>,
      };
      jsonResponse(res, 200, { ok: true });
    });
  });

  test("a signed fallback probe answered 404 stays an ambiguous success", async () => {
    mock.setHandler((_req, res) => jsonResponse(res, 404, { error: "not found" }));
    const conn = await makeConnector({ auth_type: "bearer" });
    const probe = await probeHttpConnector({
      db: ctx.db,
      tenant_id: tenantId,
      connector: conn,
      credential_override: { mode: "bearer", token: "valid-token" },
    });
    expect(probe.ok).toBe(true);
    expect(probe.warning_only).toBe(true);
    expect(probe.warnings[0]?.code).toBe("PROBE_AMBIGUOUS");
    expect(probe.error_code).toBeUndefined();
    mock.setHandler((req: IncomingMessage, res: ServerResponse) => {
      lastRequest = {
        method: req.method ?? "GET",
        url: req.url ?? "",
        headers: req.headers as Record<string, string>,
      };
      jsonResponse(res, 200, { ok: true });
    });
  });

  test("an explicit probe_endpoint config drives method/path and expected_status range", async () => {
    mock.setHandler((req, res) => {
      if (req.method === "HEAD" && req.url === "/healthz") {
        res.statusCode = 204;
        res.end();
        return;
      }
      jsonResponse(res, 200, { ok: true });
    });
    const conn = await makeConnector({
      auth_type: "none",
      config: {
        probe_endpoint: {
          method: "HEAD",
          path: "/healthz",
          expected_status: [200, 299],
          description: "health check",
        },
      },
    });
    const probe = await probeHttpConnector({ db: ctx.db, tenant_id: tenantId, connector: conn });
    expect(probe.ok).toBe(true);
    expect(probe.status).toBe(204);
    mock.setHandler((req: IncomingMessage, res: ServerResponse) => {
      lastRequest = {
        method: req.method ?? "GET",
        url: req.url ?? "",
        headers: req.headers as Record<string, string>,
      };
      jsonResponse(res, 200, { ok: true });
    });
  });

  test("historical probes inherit matching template headers while saved credentials supply auth", async () => {
    const conn = await makeConnector({
      auth_type: "bearer",
      template_slug: "notion",
      config: {
        probe_endpoint: {
          method: "GET",
          path: "/users/me",
          expected_status: [200, 200],
          description: "historical snapshot without headers",
        },
      },
    });
    await upsertCredential(
      {
        tenant_id: tenantId,
        connector_id: conn.id,
        environment: "dev",
        mode: "bearer",
        value: { mode: "bearer", token: "notion-probe-token" },
        actor_id: null,
      },
      ctx.db,
    );

    const probe = await probeHttpConnector({ db: ctx.db, tenant_id: tenantId, connector: conn });
    expect(probe.ok).toBe(true);
    expect(lastRequest?.url).toBe("/users/me");
    expect(lastRequest?.headers["notion-version"]).toBe("2022-06-28");
    expect(lastRequest?.headers.authorization).toBe("Bearer notion-probe-token");
  });

  test("probe headers cannot shadow a custom saved credential header", async () => {
    const conn = await makeConnector({
      auth_type: "header",
      config: {
        probe_endpoint: {
          method: "GET",
          path: "/healthz",
          expected_status: [200, 299],
          headers: { "X-Tenant-Identity": "template-value" },
        },
      },
    });
    await upsertCredential(
      {
        tenant_id: tenantId,
        connector_id: conn.id,
        environment: "dev",
        mode: "header",
        value: { mode: "header", headers: { "X-Tenant-Identity": "saved-value" } },
        actor_id: null,
      },
      ctx.db,
    );

    const probe = await probeHttpConnector({ db: ctx.db, tenant_id: tenantId, connector: conn });
    expect(probe.ok).toBe(false);
    expect(probe.detail).toContain("supplied by the saved credential");
  });

  test("network failure (unreachable host) is caught and returned as ok:false with a detail message", async () => {
    const conn = await makeConnector({ auth_type: "none", base_url: "http://127.0.0.1:1" });
    const probe = await probeHttpConnector({ db: ctx.db, tenant_id: tenantId, connector: conn });
    expect(probe.ok).toBe(false);
    expect(probe.detail).toBeTruthy();
    expect(probe.warnings).toEqual([]);
  });
});
