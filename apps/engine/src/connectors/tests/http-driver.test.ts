import { afterAll, beforeAll, describe, expect, test } from "bun:test";
import type { IncomingMessage, ServerResponse } from "node:http";
import { upsertCredential } from "../../credentials/service.ts";
import {
  createEngineCtx,
  createMockServer,
  type EngineTestCtx,
  jsonResponse,
  type MockServer,
} from "../../execution/tests/setup.ts";
import { buildRequestPlan } from "../drivers/http.ts";
import { createConnector, getConnector } from "../service.ts";

let ctx: EngineTestCtx;
let mock: MockServer;
let lastRequest: {
  url: string;
  headers: Record<string, string>;
} | null = null;

beforeAll(async () => {
  ctx = await createEngineCtx("http-driver");
  mock = await createMockServer((req: IncomingMessage, res: ServerResponse) => {
    lastRequest = {
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
  auth_type: "none" | "header" | "query" | "bearer" | "basic";
  config?: Record<string, unknown>;
}) {
  return await createConnector(
    {
      tenant_id: ctx.tenantId,
      input: {
        name: `cn-${Math.random().toString(36).slice(2, 8)}`,
        driver: "http",
        environment: "dev",
        base_url: mock.baseUrl,
        auth_type: params.auth_type,
        config: params.config ?? {},
      },
      actor_id: null,
    },
    ctx.testDb.db,
  );
}

describe("http driver auth application", () => {
  test("bearer credential is turned into Authorization header", async () => {
    const conn = await makeConnector({ auth_type: "bearer" });
    await upsertCredential(
      {
        tenant_id: ctx.tenantId,
        connector_id: conn.id,
        environment: "dev",
        mode: "bearer",
        value: { mode: "bearer", token: "bearer-xyz" },
        actor_id: null,
      },
      ctx.testDb.db,
    );
    const fresh = await getConnector(ctx.tenantId, conn.id, ctx.testDb.db);
    const plan = await buildRequestPlan({
      db: ctx.testDb.db,
      tenant_id: ctx.tenantId,
      connector: fresh!,
      path_or_url: "/ping",
    });
    const res = await fetch(plan.url.toString(), { method: "GET", headers: plan.headers });
    await res.text();
    expect(res.status).toBe(200);
    expect(lastRequest?.headers.authorization).toBe("Bearer bearer-xyz");
    expect(lastRequest?.url).toBe("/ping");
  });

  test("header credential is applied as raw request headers", async () => {
    const conn = await makeConnector({ auth_type: "header" });
    await upsertCredential(
      {
        tenant_id: ctx.tenantId,
        connector_id: conn.id,
        environment: "dev",
        mode: "header",
        value: { mode: "header", headers: { "x-api-key": "abc123", "x-extra": "v" } },
        actor_id: null,
      },
      ctx.testDb.db,
    );
    const fresh = await getConnector(ctx.tenantId, conn.id, ctx.testDb.db);
    const plan = await buildRequestPlan({
      db: ctx.testDb.db,
      tenant_id: ctx.tenantId,
      connector: fresh!,
      path_or_url: "/hdr",
    });
    await fetch(plan.url.toString(), { method: "GET", headers: plan.headers });
    expect(lastRequest?.headers["x-api-key"]).toBe("abc123");
    expect(lastRequest?.headers["x-extra"]).toBe("v");
  });

  test("query credential is applied to the request URL", async () => {
    const conn = await makeConnector({ auth_type: "query" });
    await upsertCredential(
      {
        tenant_id: ctx.tenantId,
        connector_id: conn.id,
        environment: "dev",
        mode: "query",
        value: { mode: "query", query: { api_key: "k-789" } },
        actor_id: null,
      },
      ctx.testDb.db,
    );
    const fresh = await getConnector(ctx.tenantId, conn.id, ctx.testDb.db);
    const plan = await buildRequestPlan({
      db: ctx.testDb.db,
      tenant_id: ctx.tenantId,
      connector: fresh!,
      path_or_url: "/q",
    });
    await fetch(plan.url.toString(), { method: "GET", headers: plan.headers });
    expect(lastRequest?.url).toContain("api_key=k-789");
  });

  test("basic credential is base64-encoded into Authorization header", async () => {
    const conn = await makeConnector({ auth_type: "basic" });
    await upsertCredential(
      {
        tenant_id: ctx.tenantId,
        connector_id: conn.id,
        environment: "dev",
        mode: "basic",
        value: { mode: "basic", username: "alice", password: "s3cret" },
        actor_id: null,
      },
      ctx.testDb.db,
    );
    const fresh = await getConnector(ctx.tenantId, conn.id, ctx.testDb.db);
    const plan = await buildRequestPlan({
      db: ctx.testDb.db,
      tenant_id: ctx.tenantId,
      connector: fresh!,
      path_or_url: "/basic",
    });
    await fetch(plan.url.toString(), { method: "GET", headers: plan.headers });
    const expected = `Basic ${Buffer.from("alice:s3cret", "utf8").toString("base64")}`;
    expect(lastRequest?.headers.authorization).toBe(expected);
  });

  test("static_headers from connector config land on the request too", async () => {
    const conn = await makeConnector({
      auth_type: "none",
      config: { static_headers: { "x-static": "static-v" } },
    });
    const fresh = await getConnector(ctx.tenantId, conn.id, ctx.testDb.db);
    const plan = await buildRequestPlan({
      db: ctx.testDb.db,
      tenant_id: ctx.tenantId,
      connector: fresh!,
      path_or_url: "/s",
    });
    await fetch(plan.url.toString(), { method: "GET", headers: plan.headers });
    expect(lastRequest?.headers["x-static"]).toBe("static-v");
  });
});
