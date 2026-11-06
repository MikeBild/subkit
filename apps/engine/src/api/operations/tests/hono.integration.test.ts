import { afterAll, beforeAll, describe, expect, test } from "bun:test";
import { z } from "@hono/zod-openapi";
import { createTestDb, type TestDb } from "../../../db/tests/setup.ts";
import { errorMiddleware, mapKnownErrorResponse } from "../../../http/middleware/error.ts";
import { createOpenApiApp } from "../../../http/openapi.ts";
import { adminPrincipal } from "../../../test-helpers/principals.ts";
import { seedTenant } from "../../../test-helpers/seed.ts";
import { toHonoRoute } from "../hono.ts";
import { defineOperation, plainRejection, reject } from "../index.ts";

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

let seenScope: { request_source?: string; hasBoss: boolean } | null = null;

const accept = defineOperation({
  id: "things.accept",
  permission: "workflow:write",
  effect: "write",
  audit: "workflow.updated",
  handler: async (scope, input: { id: string; mode: string; name: string }) => {
    seenScope = {
      ...(scope.request_source ? { request_source: scope.request_source } : {}),
      hasBoss: scope.boss !== undefined,
    };
    return input.id === "gone" ? reject.payloadTooLarge("too big", { limit: 1 }) : input;
  },
  http: {
    method: "post",
    path: "/v1/things/{id}/accept",
    tags: ["things"],
    params: IdParam,
    headers: z.object({ "x-mode": z.string() }),
    body: z.object({ name: z.string().min(2) }),
    response: z.object({ id: z.string(), mode: z.string(), name: z.string() }),
    success: [
      { status: 200, description: "Replayed" },
      { status: 201, description: "Accepted" },
      { status: 202, description: "Queued", empty: true },
    ],
    statusFor: (result) => (result.mode === "queue" ? 202 : result.mode === "new" ? 201 : 200),
    invalid: (issues) => reject.unprocessable("body invalid", { issues }, "validation_failed"),
    toInput: (request) => ({
      id: (request.param as { id: string }).id,
      mode: (request.header as { "x-mode": string })["x-mode"],
      name: (request.json as { name: string }).name,
    }),
    toBody: (result) => result,
  },
});

let seenRequest: { method: string; trace: string | undefined } | null = null;

const whoami = defineOperation({
  id: "things.whoami",
  permission: null,
  effect: "read",
  handler: async (scope) => ({ id: scope.actor.id ?? "" }),
  http: {
    method: "get",
    path: "/v1/things-self",
    tags: ["things"],
    response: z.object({ id: z.string() }),
    toInput: () => ({}),
    toBody: (result) => result,
  },
});

const guarded = defineOperation({
  id: "things.guarded",
  permission: "workflow:read",
  requiredPermissions: [
    { permission: "schedule:read", resource: { type: "workflow", param: "id" } },
  ],
  effect: "write",
  audit: "workflow.updated",
  handler: async (scope, input: { id: string; level: string }) => {
    seenRequest = { method: scope.request?.method ?? "", trace: scope.trace_id };
    if (input.level === "admin") await scope.ensurePermission?.("rbac:write");
    if (input.level === "busy")
      return reject.status(409, "busy", "thing is busy", undefined, "retry in a minute");
    return { id: input.id };
  },
  http: {
    method: "post",
    path: "/v1/things/{id}/guarded",
    tags: ["things"],
    params: IdParam,
    body: z.object({ level: z.string() }),
    bodyRequired: true,
    response: z.object({ id: z.string() }),
    errors: {
      401: "Unauthenticated",
      409: {
        description: "Busy",
        schema: z.object({ code: z.literal("busy"), retry: z.boolean() }),
      },
    },
    toInput: (request) => ({
      id: (request.param as { id: string }).id,
      level: (request.json as { level: string }).level,
    }),
    toBody: (result) => result,
  },
});

const unsecured = defineOperation({
  id: "things.unsecured",
  permission: null,
  effect: "write",
  audit: "workflow.updated",
  handler: async () => ({ id: "x" }),
  http: {
    method: "post",
    path: "/v1/things-unsecured",
    tags: ["things"],
    body: z.object({ note: z.string().optional() }),
    bodyRequired: false,
    security: null,
    response: z.object({ id: z.string() }),
    toInput: () => ({}),
    toBody: (result) => result,
  },
});

const validate = defineOperation({
  id: "things.validate",
  permission: "workflow:read",
  effect: "read",
  handler: async () => ({ ok: true as const, issues: [] as string[] }),
  http: {
    method: "post",
    path: "/v1/things-validate",
    tags: ["things"],
    body: z.object({ name: z.string().min(2) }),
    response: z.object({ ok: z.boolean(), issues: z.array(z.string()) }),
    invalid: (issues) => ({ status: 200, body: { ok: false, issues: issues.map((i) => i.path) } }),
    responseHeaders: () => ({ "cache-control": "no-store" }),
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
  toHonoRoute(app, accept);
  toHonoRoute(app, whoami);
  toHonoRoute(app, guarded);
  toHonoRoute(app, unsecured);
  toHonoRoute(app, validate);
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

describe("toHonoRoute success, header and validation bindings", () => {
  const post = (id: string, mode: string, body: unknown) =>
    buildApp().request(`/v1/things/${id}/accept`, {
      method: "POST",
      headers: { "content-type": "application/json", "x-mode": mode },
      body: JSON.stringify(body),
    });

  test("documents every declared success status", () => {
    const spec = buildApp().getOpenAPI31Document({
      openapi: "3.1.0",
      info: { title: "t", version: "0" },
    });
    const responses = spec.paths?.["/v1/things/{id}/accept"]?.post?.responses ?? {};
    expect(responses["200"]).toMatchObject({ description: "Replayed" });
    expect(responses["201"]).toMatchObject({ description: "Accepted" });
    expect(responses["202"]).toEqual({ description: "Queued" });
  });

  test("picks the status from the result and reads the header", async () => {
    const created = await post("t-1", "new", { name: "ab" });
    expect(created.status).toBe(201);
    expect(await created.json()).toEqual({ id: "t-1", mode: "new", name: "ab" });
    expect((await post("t-1", "again", { name: "ab" })).status).toBe(200);
    const queued = await post("t-1", "queue", { name: "ab" });
    expect(queued.status).toBe(202);
    expect(await queued.text()).toBe("");
  });

  test("passes the request source into the scope", async () => {
    await post("t-1", "new", { name: "ab" });
    expect(seenScope).toEqual({ request_source: "api", hasBoss: false });
  });

  test("answers an invalid body through the binding's own rejection", async () => {
    const response = await post("t-1", "new", { name: "a" });
    expect(response.status).toBe(422);
    const body = (await response.json()) as {
      code: string;
      details: { issues: { path: string }[] };
    };
    expect(body.code).toBe("validation_failed");
    expect(body.details.issues[0]?.path).toBe("name");
  });

  test("maps a payload-too-large rejection to 413", async () => {
    const response = await post("gone", "new", { name: "ab" });
    expect(response.status).toBe(413);
    expect(((await response.json()) as { code: string }).code).toBe("payload_too_large");
  });
});

describe("toHonoRoute permission variants", () => {
  const guardedPost = (app: ReturnType<typeof buildApp>, level: string) =>
    app.request("/v1/things/t-1/guarded", {
      method: "POST",
      headers: { "content-type": "application/json" },
      body: JSON.stringify({ level }),
    });

  test("an operation without a permission only needs an authenticated caller", async () => {
    const response = await buildApp([]).request("/v1/things-self");
    expect(response.status).toBe(200);
    expect(await response.json()).toEqual({ id: adminPrincipal(tenant_id).id });
  });

  test("every required permission is checked and a caller with all of them passes", async () => {
    expect((await guardedPost(buildApp([]), "plain")).status).toBe(403);
    const allowed = await guardedPost(buildApp(), "plain");
    expect(allowed.status).toBe(200);
    expect(seenRequest?.method).toBe("POST");
  });

  test("the handler can check a further permission through the scope", async () => {
    expect((await guardedPost(buildApp(), "admin")).status).toBe(200);
  });

  test("a rejection hint reaches the error body", async () => {
    const response = await guardedPost(buildApp(), "busy");
    expect(response.status).toBe(409);
    expect(await response.json()).toMatchObject({ code: "busy", hint: "retry in a minute" });
  });

  test("documents a required body and the extra error statuses", () => {
    const spec = buildApp().getOpenAPI31Document({
      openapi: "3.1.0",
      info: { title: "t", version: "0" },
    });
    const post = spec.paths?.["/v1/things/{id}/guarded"]?.post;
    expect((post?.requestBody as { required?: boolean } | undefined)?.required).toBe(true);
    expect(Object.keys(post?.responses ?? {})).toEqual(["200", "401", "409"]);
    const conflict = post?.responses?.["409"] as {
      content: { "application/json": { schema: { properties?: Record<string, unknown> } } };
    };
    expect(Object.keys(conflict.content["application/json"].schema.properties ?? {})).toEqual([
      "code",
      "retry",
    ]);
  });
});

describe("toHonoRoute documentation overrides", () => {
  test("omits security when the binding sets it to null and documents an optional body", async () => {
    const spec = buildApp().getOpenAPI31Document({
      openapi: "3.1.0",
      info: { title: "t", version: "0" },
    });
    const post = spec.paths?.["/v1/things-unsecured"]?.post;
    expect(post?.security).toBeUndefined();
    expect((post?.requestBody as { required?: boolean } | undefined)?.required).toBe(false);
    expect(spec.paths?.["/v1/things/{id}/guarded"]?.post?.security).toEqual([{ bearerAuth: [] }]);
    const response = await buildApp([]).request("/v1/things-unsecured", {
      method: "POST",
      headers: { "content-type": "application/json" },
      body: "{}",
    });
    expect(response.status).toBe(200);
  });
});

describe("toHonoRoute validation results and response headers", () => {
  const post = (body: unknown) =>
    buildApp().request("/v1/things-validate", {
      method: "POST",
      headers: { "content-type": "application/json" },
      body: JSON.stringify(body),
    });

  test("an invalid body can answer a success status with a result body", async () => {
    const response = await post({ name: "a" });
    expect(response.status).toBe(200);
    expect(await response.json()).toEqual({ ok: false, issues: ["name"] });
  });

  test("a valid answer carries the binding's response headers", async () => {
    const response = await post({ name: "ab" });
    expect(response.status).toBe(200);
    expect(response.headers.get("cache-control")).toBe("no-store");
    expect(await response.json()).toEqual({ ok: true, issues: [] });
  });
});
