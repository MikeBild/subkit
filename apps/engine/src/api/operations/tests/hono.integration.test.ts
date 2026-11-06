import { afterAll, beforeAll, describe, expect, test } from "bun:test";
import { z } from "@hono/zod-openapi";
import { createTestDb, type TestDb } from "../../../db/tests/setup.ts";
import { errorMiddleware, mapKnownErrorResponse } from "../../../http/middleware/error.ts";
import { createOpenApiApp } from "../../../http/openapi.ts";
import { adminPrincipal } from "../../../test-helpers/principals.ts";
import { seedTenant } from "../../../test-helpers/seed.ts";
import { toHonoRoute } from "../hono.ts";
import { defineOperation, plainRejection } from "../index.ts";

let testDb: TestDb;
let tenant_id: string;

beforeAll(async () => {
  testDb = await createTestDb("operation_hono_adapter");
  tenant_id = (await seedTenant(testDb.db)).id;
}, 60_000);

afterAll(async () => {
  await testDb.cleanup();
});

const IdParam = z.object({ id: z.string() });

const remove = defineOperation({
  id: "things.delete",
  permission: "workflow:delete",
  effect: "write",
  audit: "workflow.deleted",
  handler: async () => ({}),
  http: {
    method: "delete",
    path: "/v1/things/{id}",
    tags: ["things"],
    params: IdParam,
    response: z.object({}),
    success: { status: 204, description: "Deleted" },
    toInput: () => ({}),
    toBody: () => ({}),
  },
});

const link = defineOperation({
  id: "things.link",
  summary: "Link a thing",
  permission: "workflow:write",
  alternatePermissions: ["workflow:admin"],
  effect: "write",
  audit: "workflow.updated",
  handler: async (_scope, input: { id: string }) =>
    input.id === "busy"
      ? plainRejection(409, "thing_not_ready", "thing is not ready", { status: "scanning" })
      : { linked: input.id },
  http: {
    method: "post",
    path: "/v1/things/{id}/link",
    tags: ["things"],
    params: IdParam,
    response: z.object({ linked: z.string() }),
    success: { status: 201, description: "Linked" },
    errors: { 409: "Not ready" },
    toInput: (request) => request.param as { id: string },
    toBody: (result) => result,
  },
});

const read = defineOperation({
  id: "things.get",
  permission: "workflow:read",
  effect: "read",
  handler: async () => ({ id: "t-1" }),
  http: {
    method: "get",
    path: "/v1/things/{id}",
    tags: ["things"],
    params: IdParam,
    response: z.object({ id: z.string() }),
    toInput: () => ({}),
    toBody: (result) => result,
  },
});

function buildApp(roles: string[] = ["admin"]) {
  const app = createOpenApiApp();
  app.use("*", errorMiddleware());
  app.onError((err, c) => mapKnownErrorResponse(c, err) ?? c.json({ code: "internal" }, 500));
  app.use("*", async (c, next) => {
    c.set("db", testDb.db);
    c.set("principal", { ...adminPrincipal(tenant_id), roles });
    await next();
  });

  toHonoRoute(app, remove);
  toHonoRoute(app, link);
  toHonoRoute(app, read);
  return app;
}

describe("toHonoRoute response shapes", () => {
  test("documents a 204 without content and omits a missing summary", () => {
    const spec = buildApp().getOpenAPI31Document({
      openapi: "3.1.0",
      info: { title: "t", version: "0" },
    });
    const del = spec.paths?.["/v1/things/{id}"]?.delete;
    expect(del?.summary).toBeUndefined();
    expect(del?.responses?.["204"]).toEqual({ description: "Deleted" });
    expect(del?.responses?.["200"]).toBeUndefined();
    const post = spec.paths?.["/v1/things/{id}/link"]?.post;
    expect(post?.summary).toBe("Link a thing");
    expect(post?.responses?.["201"]).toMatchObject({ description: "Linked" });
  });

  test("answers 204 with an empty body", async () => {
    const response = await buildApp().request("/v1/things/t-1", { method: "DELETE" });
    expect(response.status).toBe(204);
    expect(await response.text()).toBe("");
  });

  test("answers the declared success status with the body", async () => {
    const response = await buildApp().request("/v1/things/t-2/link", { method: "POST" });
    expect(response.status).toBe(201);
    expect(await response.json()).toEqual({ linked: "t-2" });
  });

  test("a plain rejection answers code, message and extras without the error envelope", async () => {
    const response = await buildApp().request("/v1/things/busy/link", { method: "POST" });
    expect(response.status).toBe(409);
    expect(await response.json()).toEqual({
      code: "thing_not_ready",
      message: "thing is not ready",
      status: "scanning",
    });
  });
});

describe("toHonoRoute permission gate", () => {
  test("a HEAD request passes the same gate as GET", async () => {
    const denied = buildApp([]);
    expect((await denied.request("/v1/things/t-1", { method: "GET" })).status).toBe(403);
    expect((await denied.request("/v1/things/t-1", { method: "HEAD" })).status).toBe(403);
    expect((await buildApp().request("/v1/things/t-1", { method: "HEAD" })).status).toBe(200);
  });
});
