import { afterAll, beforeAll, describe, expect, test } from "bun:test";
import type { IncomingMessage, ServerResponse } from "node:http";
import { upsertCredential } from "../../../credentials/service.ts";
import { createTestDb, type TestDb } from "../../../db/tests/setup.ts";
import { withSelfHostedDriverFetchForTests } from "../../../test-helpers/driver-fetch.ts";
import {
  createMockServer,
  jsonResponse,
  type MockServer,
} from "../../../test-helpers/mock-http.ts";
import { seedTenant } from "../../../test-helpers/seed.ts";
import { createConnector, getConnector } from "../../service.ts";
import type { ConnectorView } from "../../types.ts";
import {
  buildRequestPlan,
  executeConnectorHttpRequest,
  executePlannedHttpRequest,
  probeHttpConnector,
} from "../http.ts";

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

async function makeConnector(params: {
  auth_type: ConnectorView["auth_type"];
  config?: Record<string, unknown>;
  base_url?: string;
  template_slug?: string;
}): Promise<ConnectorView> {
  const created = await createConnector(
    {
      tenant_id: tenantId,
      input: {
        name: `http-core-${Math.random().toString(36).slice(2, 8)}`, // allow-random: unique slug per test
        driver: "http",
        environment: "dev",
        base_url: params.base_url ?? mock.baseUrl,
        auth_type: params.auth_type,
        config: params.config ?? {},
        ...(params.template_slug ? { template_slug: params.template_slug } : {}),
      },
      actor_id: null,
    },
    ctx.db,
  );
  const fresh = await getConnector(tenantId, created.id, ctx.db);
  if (!fresh) throw new Error("connector round-trip failed");
  return fresh;
}

describe("buildRequestPlan — credential resolution", () => {
  test("auth_type none never looks up a credential; auth_method is none", async () => {
    const conn = await makeConnector({ auth_type: "none" });
    const plan = await buildRequestPlan({
      db: ctx.db,
      tenant_id: tenantId,
      connector: conn,
      path_or_url: "/ping",
    });
    expect(plan.auth_method).toBe("none");
    expect(plan.credential).toBeNull();
    expect(plan.credential_id).toBeNull();
  });

  test("auth_type bearer with no persisted credential resolves to no credential", async () => {
    const conn = await makeConnector({ auth_type: "bearer" });
    const plan = await buildRequestPlan({
      db: ctx.db,
      tenant_id: tenantId,
      connector: conn,
      path_or_url: "/ping",
    });
    expect(plan.credential).toBeNull();
    expect(plan.auth_method).toBe("none");
  });

  test("credential_override bypasses the DB lookup entirely", async () => {
    const conn = await makeConnector({ auth_type: "bearer" });
    const plan = await buildRequestPlan({
      db: ctx.db,
      tenant_id: tenantId,
      connector: conn,
      path_or_url: "/ping",
      credential_override: { mode: "bearer", token: "override-token" },
    });
    expect(plan.credential_id).toBeNull();
    expect(plan.headers.Authorization).toBe("Bearer override-token");
    expect(plan.auth_method).toBe("bearer");
  });

  test("persisted bearer credential resolves with a non-null credential_id", async () => {
    const conn = await makeConnector({ auth_type: "bearer" });
    await upsertCredential(
      {
        tenant_id: tenantId,
        connector_id: conn.id,
        environment: "dev",
        mode: "bearer",
        value: { mode: "bearer", token: "stored-token" },
        actor_id: null,
      },
      ctx.db,
    );
    const fresh = await getConnector(tenantId, conn.id, ctx.db);
    const plan = await buildRequestPlan({
      db: ctx.db,
      tenant_id: tenantId,
      connector: fresh!,
      path_or_url: "/ping",
    });
    expect(plan.credential_id).not.toBeNull();
    expect(plan.headers.Authorization).toBe("Bearer stored-token");
    expect(plan.auth_method).toBe("bearer");
  });

  test("oauth2 credential on a connector with no resolvable oauth config stays static (refresh skipped, not thrown)", async () => {
    const conn = await makeConnector({ auth_type: "oauth2" });
    await upsertCredential(
      {
        tenant_id: tenantId,
        connector_id: conn.id,
        environment: "dev",
        mode: "oauth2",
        value: {
          mode: "oauth2",
          access_token: "stale-access-token",
          token_type: "Bearer",
          refresh_token: null,
          expires_at: new Date(0),
        },
        actor_id: null,
      },
      ctx.db,
    );
    const fresh = await getConnector(tenantId, conn.id, ctx.db);
    const plan = await buildRequestPlan({
      db: ctx.db,
      tenant_id: tenantId,
      connector: fresh!,
      path_or_url: "/ping",
    });
    expect(plan.auth_method).toBe("oauth2_static");
    expect(plan.headers.Authorization).toBe("Bearer stale-access-token");
  });

  test("idempotency_key lands on the Idempotency-Key header", async () => {
    const conn = await makeConnector({ auth_type: "none" });
    const plan = await buildRequestPlan({
      db: ctx.db,
      tenant_id: tenantId,
      connector: conn,
      path_or_url: "/ping",
      idempotency_key: "exec-1:step-2:attempt-1",
    });
    expect(plan.headers["Idempotency-Key"]).toBe("exec-1:step-2:attempt-1");
  });

  test("URL query params from the resolved plan land on the final URL", async () => {
    const conn = await makeConnector({ auth_type: "none" });
    const plan = await buildRequestPlan({
      db: ctx.db,
      tenant_id: tenantId,
      connector: conn,
      path_or_url: "/search",
      query: { q: "widgets", page: 2 },
    });
    expect(plan.url.searchParams.get("q")).toBe("widgets");
    expect(plan.url.searchParams.get("page")).toBe("2");
  });
});

describe("executePlannedHttpRequest", () => {
  test("multipart review binds the exact file sent and refusal prevents dispatch", async () => {
    let calls = 0;
    const server = await createMockServer((req, res) => {
      const chunks: Buffer[] = [];
      req.on("data", (chunk) => chunks.push(Buffer.from(chunk)));
      req.on("end", async () => {
        calls++;
        const body = Buffer.concat(chunks);
        const form = await new Response(body, {
          headers: { "content-type": String(req.headers["content-type"]) },
        }).formData();
        jsonResponse(res, 200, {
          bytes: body.byteLength,
          file: await (form.get("file") as File).text(),
        });
      });
    });
    const form = new FormData();
    form.append("file", new Blob(["reviewed-file"]), "fixture.bin");
    let reviewedBytes = 0;
    const params = {
      exec: ctx.db,
      tenant_id: tenantId,
      method: "POST",
      url: new URL(`${server.baseUrl}/upload`),
      headers: { "Content-Type": "text/plain" },
      multipartBody: form,
      signal: new AbortController().signal,
    };
    try {
      const result = await executePlannedHttpRequest({
        ...params,
        before_dispatch: async (request) => {
          expect(request.body_encoding).toBe("multipart");
          expect(request.headers["content-type"]).toBe("multipart/form-data");
          expect(request.headers["Content-Type"]).toBeUndefined();
          expect(JSON.stringify(request.body)).not.toContain("reviewed-file");
          reviewedBytes = request.body_bytes ?? 0;
          form.set("file", new Blob(["changed-after-review"]), "fixture.bin");
          return { redirect: "manual" };
        },
      });
      expect(result.body).toEqual({ bytes: reviewedBytes, file: "reviewed-file" });
      expect(calls).toBe(1);
      await expect(
        executePlannedHttpRequest({
          ...params,
          before_dispatch: async () => {
            throw new Error("approval refused");
          },
        }),
      ).rejects.toThrow("approval refused");
      expect(calls).toBe(1);
    } finally {
      await server.close();
    }
  });
  test("rejects on abort even when the transport promise ignores the signal", async () => {
    const controller = new AbortController();
    const transportThatNeverSettles = (() =>
      new Promise<Response>(() => {})) as unknown as typeof fetch;

    const request = withSelfHostedDriverFetchForTests(transportThatNeverSettles, () =>
      executePlannedHttpRequest({
        exec: ctx.db,
        tenant_id: tenantId,
        method: "POST",
        url: new URL("https://example.invalid/hung"),
        headers: {},
        body: { bounded: true },
        signal: controller.signal,
      }),
    );
    controller.abort("step timeout");

    await expect(request).rejects.toMatchObject({ name: "AbortError", message: "step timeout" });
  });

  test("GET against the mock server round-trips status, headers, and JSON body", async () => {
    const result = await executePlannedHttpRequest({
      exec: ctx.db,
      tenant_id: tenantId,
      method: "GET",
      url: new URL(`${mock.baseUrl}/ping`),
      headers: {},
      signal: new AbortController().signal,
    });
    expect(result.status).toBe(200);
    expect(result.body).toEqual({ ok: true });
    expect(result.bytes_in).toBeGreaterThan(0);
    expect(lastRequest?.method).toBe("GET");
  });

  test("a JSON body on POST is serialised and content-type defaults to application/json", async () => {
    await executePlannedHttpRequest({
      exec: ctx.db,
      tenant_id: tenantId,
      method: "POST",
      url: new URL(`${mock.baseUrl}/create`),
      headers: {},
      body: { name: "widget" },
      signal: new AbortController().signal,
    });
    expect(lastRequest?.method).toBe("POST");
    expect(lastRequest?.headers["content-type"]).toContain("application/json");
  });

  test("a string body is sent verbatim without JSON re-encoding", async () => {
    mock.setHandler((req, res) => {
      let raw = "";
      req.on("data", (chunk) => {
        raw += chunk;
      });
      req.on("end", () => {
        lastRequest = { method: req.method ?? "", url: req.url ?? "", headers: {} };
        jsonResponse(res, 200, { received: raw });
      });
    });
    const result = await executePlannedHttpRequest({
      exec: ctx.db,
      tenant_id: tenantId,
      method: "POST",
      url: new URL(`${mock.baseUrl}/raw`),
      headers: { "content-type": "text/plain" },
      body: "plain-text-body",
      signal: new AbortController().signal,
    });
    expect((result.body as { received: string }).received).toBe("plain-text-body");
    mock.setHandler((req: IncomingMessage, res: ServerResponse) => {
      lastRequest = {
        method: req.method ?? "GET",
        url: req.url ?? "",
        headers: req.headers as Record<string, string>,
      };
      jsonResponse(res, 200, { ok: true });
    });
  });

  test("GET/HEAD never carry a body even when one is supplied", async () => {
    mock.setHandler((req, res) => {
      let raw = "";
      req.on("data", (chunk) => {
        raw += chunk;
      });
      req.on("end", () => {
        jsonResponse(res, 200, { raw_length: raw.length });
      });
    });
    const result = await executePlannedHttpRequest({
      exec: ctx.db,
      tenant_id: tenantId,
      method: "GET",
      url: new URL(`${mock.baseUrl}/noop`),
      headers: {},
      body: { should: "be-ignored" },
      signal: new AbortController().signal,
    });
    expect((result.body as { raw_length: number }).raw_length).toBe(0);
    mock.setHandler((req: IncomingMessage, res: ServerResponse) => {
      lastRequest = {
        method: req.method ?? "GET",
        url: req.url ?? "",
        headers: req.headers as Record<string, string>,
      };
      jsonResponse(res, 200, { ok: true });
    });
  });

  test("a non-2xx status is returned (not thrown) with the parsed error body", async () => {
    mock.setHandler((_req, res) => {
      jsonResponse(res, 500, { error: "boom" });
    });
    const result = await executePlannedHttpRequest({
      exec: ctx.db,
      tenant_id: tenantId,
      method: "GET",
      url: new URL(`${mock.baseUrl}/fail`),
      headers: {},
      signal: new AbortController().signal,
    });
    expect(result.status).toBe(500);
    expect(result.body).toEqual({ error: "boom" });
    mock.setHandler((req: IncomingMessage, res: ServerResponse) => {
      lastRequest = {
        method: req.method ?? "GET",
        url: req.url ?? "",
        headers: req.headers as Record<string, string>,
      };
      jsonResponse(res, 200, { ok: true });
    });
  });
});

describe("executeConnectorHttpRequest", () => {
  test("builds a plan from the connector and executes it against the mock server", async () => {
    const conn = await makeConnector({ auth_type: "none" });
    const result = await executeConnectorHttpRequest({
      db: ctx.db,
      tenant_id: tenantId,
      connector: conn,
      method: "GET",
      path_or_url: "/status",
    });
    expect(result.status).toBe(200);
    expect(lastRequest?.url).toBe("/status");
  });

  test("timeout_ms + an explicit signal are merged via AbortSignal.any", async () => {
    const conn = await makeConnector({ auth_type: "none" });
    const controller = new AbortController();
    const result = await executeConnectorHttpRequest({
      db: ctx.db,
      tenant_id: tenantId,
      connector: conn,
      method: "GET",
      path_or_url: "/status",
      signal: controller.signal,
      timeout_ms: 5_000,
    });
    expect(result.status).toBe(200);
  });
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
