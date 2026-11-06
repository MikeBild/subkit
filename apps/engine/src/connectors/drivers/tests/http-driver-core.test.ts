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
import { getConnector } from "../../service.ts";
import {
  buildRequestPlan,
  executeConnectorHttpRequest,
  executePlannedHttpRequest,
} from "../http.ts";
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
