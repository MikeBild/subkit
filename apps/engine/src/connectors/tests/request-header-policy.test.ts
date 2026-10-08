// biome-ignore-all lint/suspicious/noTemplateCurlyInString: literal runtime placeholder is the workflow contract.
import { afterAll, beforeAll, expect, test } from "bun:test";
import { upsertCredential } from "../../credentials/service.ts";
import { resolveDefinition } from "../../execution/resolve-definition.ts";
import {
  createEngineCtx,
  createMockServer,
  type EngineTestCtx,
  jsonResponse,
  type MockServer,
} from "../../execution/tests/setup.ts";
import { createWorkflow, updateWorkflow } from "../../workflows/service.ts";
import { validateTenantWorkflowDef } from "../../workflows/tenant-validator.ts";
import { executeGraphQLRequest } from "../drivers/graphql.ts";
import { buildRequestPlan, HttpRequestInvalidError } from "../drivers/http.ts";
import { createConnector, getConnector } from "../service.ts";
import type { ConnectorView } from "../types.ts";

let ctx: EngineTestCtx;
let mock: MockServer;
let dispatches = 0;
let headers: Record<string, string | string[] | undefined> = {};
let headerConnector: ConnectorView;
let bearerConnector: ConnectorView;
let noneConnector: ConnectorView;
let sequence = 0;
beforeAll(async () => {
  ctx = await createEngineCtx("request-header-policy");
  mock = await createMockServer((req, res) => {
    dispatches++;
    headers = req.headers;
    jsonResponse(res, 200, { data: { ok: true } });
  });
  headerConnector = await connector("header");
  bearerConnector = await connector("bearer");
  noneConnector = await connector("none");
  await credential(headerConnector, { "x-subkit-token": "fixture-protected" });
  await upsertCredential(
    {
      tenant_id: ctx.tenantId,
      connector_id: bearerConnector.id,
      environment: "dev",
      mode: "bearer",
      value: { mode: "bearer", token: "fixture-bearer" },
      actor_id: null,
    },
    ctx.testDb.db,
  );
}, 120_000);
afterAll(async () => {
  await mock.close();
  await ctx.cleanup();
});
async function connector(
  auth_type: "header" | "bearer" | "none",
  driver: "http" | "graphql" = "http",
) {
  return createConnector(
    {
      tenant_id: ctx.tenantId,
      actor_id: null,
      input: {
        name: `header-policy-${++sequence}`,
        driver,
        environment: "dev",
        base_url: mock.baseUrl,
        auth_type,
        config: driver === "graphql" ? { endpoint: `${mock.baseUrl}/graphql` } : {},
      },
    },
    ctx.testDb.db,
  );
}
async function credential(conn: ConnectorView, savedHeaders: Record<string, string>) {
  await upsertCredential(
    {
      tenant_id: ctx.tenantId,
      connector_id: conn.id,
      environment: "dev",
      mode: "header",
      value: { mode: "header", headers: savedHeaders },
      actor_id: null,
    },
    ctx.testDb.db,
  );
}
function definition(conn: ConnectorView, requestHeaders: Record<string, string>) {
  return {
    name: `forward-auth-${++sequence}`,
    steps: [
      {
        id: "request",
        kind: "request",
        method: "GET",
        connector_id: conn.id,
        path: "/rpc",
        headers: requestHeaders,
      },
    ],
  };
}
async function plan(conn: ConnectorView, requestHeaders: Record<string, string>) {
  const fresh = await getConnector(ctx.tenantId, conn.id, ctx.testDb.db);
  if (!fresh) throw new Error("fixture connector missing");
  return buildRequestPlan({
    db: ctx.testDb.db,
    tenant_id: ctx.tenantId,
    connector: fresh,
    path_or_url: "/rpc",
    headers: requestHeaders,
  });
}
test("tenant-scoped create, update and draft resolution admit Authorization beside a protected custom header", async () => {
  const def = definition(headerConnector, { Authorization: "Bearer ${input.token}" });
  const created = await createWorkflow(
    { tenant_id: ctx.tenantId, def, actor_id: null },
    ctx.testDb.db,
  );
  expect(created.errors).toBeUndefined();
  if (!created.workflow) throw new Error("fixture workflow not created");
  const updated = await updateWorkflow(
    { tenant_id: ctx.tenantId, id: created.workflow.id, def, actor_id: null },
    ctx.testDb.db,
  );
  expect(updated.errors).toBeUndefined();
  const resolved = await resolveDefinition(ctx.testDb.db, ctx.tenantId, {
    kind: "draft",
    definition: def,
  });
  expect(resolved.def.steps[0]?.kind).toBe("request");
  const request = await plan(headerConnector, { aUtHoRiZaTiOn: "Bearer fixture-forwarded" });
  await fetch(request.url, { headers: request.headers });
  expect(headers.authorization).toBe("Bearer fixture-forwarded");
  expect(headers["x-subkit-token"]).toBe("fixture-protected");
});
test.each(["Authorization", "aUtHoRiZaTiOn", "X-Subkit-Token", "Cookie", "Proxy-Authorization"])(
  "persisted bearer/custom auth blocks conflicting header %s",
  async (name) => {
    const conn = name.toLowerCase() === "authorization" ? bearerConnector : headerConnector;
    const before = dispatches;
    const verdict = await validateTenantWorkflowDef(
      definition(conn, { [name]: "fixture-override" }),
      ctx.tenantId,
      ctx.testDb.db,
    );
    expect(verdict.ok).toBe(false);
    await expect(plan(conn, { [name]: "fixture-override" })).rejects.toBeInstanceOf(
      HttpRequestInvalidError,
    );
    expect(dispatches).toBe(before);
  },
);
test("none authentication permits Authorization but never Cookie, Proxy-Authorization or case duplicates", async () => {
  expect(
    (
      await validateTenantWorkflowDef(
        definition(noneConnector, { Authorization: "fixture-token" }),
        ctx.tenantId,
        ctx.testDb.db,
      )
    ).ok,
  ).toBe(true);
  for (const requestHeaders of [
    { Cookie: "fixture" },
    { "proxy-authorization": "fixture" },
    { Authorization: "one", authorization: "two" },
  ]) {
    expect(
      (
        await validateTenantWorkflowDef(
          definition(noneConnector, requestHeaders),
          ctx.tenantId,
          ctx.testDb.db,
        )
      ).ok,
    ).toBe(false);
    await expect(plan(noneConnector, requestHeaders)).rejects.toBeInstanceOf(
      HttpRequestInvalidError,
    );
  }
});
test("foreign tenant and missing persisted header credential cannot grant forwarding authority", async () => {
  const empty = await connector("header");
  expect(
    (
      await validateTenantWorkflowDef(
        definition(empty, { Authorization: "fixture" }),
        ctx.tenantId,
        ctx.testDb.db,
      )
    ).ok,
  ).toBe(false);
  await expect(plan(empty, { Authorization: "fixture" })).rejects.toBeInstanceOf(
    HttpRequestInvalidError,
  );
  expect(
    (
      await validateTenantWorkflowDef(
        definition(headerConnector, { Authorization: "fixture" }),
        "00000000-0000-4000-8000-000000000001",
        ctx.testDb.db,
      )
    ).ok,
  ).toBe(false);
});
test("credential changes after authoring revoke Authorization forwarding and custom header ownership", async () => {
  const conn = await connector("header");
  await credential(conn, { "x-budget": "fixture" });
  const def = definition(conn, { Authorization: "fixture-forwarded" });
  expect((await validateTenantWorkflowDef(def, ctx.tenantId, ctx.testDb.db)).ok).toBe(true);
  await credential(conn, { authorization: "fixture-saved", "x-budget": "fixture" });
  expect((await validateTenantWorkflowDef(def, ctx.tenantId, ctx.testDb.db)).ok).toBe(false);
  await expect(plan(conn, { Authorization: "fixture-forwarded" })).rejects.toBeInstanceOf(
    HttpRequestInvalidError,
  );
});
test("GraphQL preserves forwarded Authorization only when current saved auth does not own it", async () => {
  const conn = await connector("header", "graphql");
  await credential(conn, { "X-Subkit-Token": "fixture-protected" });
  const result = await executeGraphQLRequest({
    db: ctx.testDb.db,
    tenant_id: ctx.tenantId,
    connector: conn,
    op: { operation: "query", query: "query { ok }" },
    extra_headers: { Authorization: "Bearer fixture-forwarded" },
  });
  expect(result.status).toBe(200);
  expect(headers.authorization).toBe("Bearer fixture-forwarded");
  expect(headers["x-subkit-token"]).toBe("fixture-protected");
  const before = dispatches;
  for (const extra_headers of [
    { "x-subkit-token": "override" },
    { Cookie: "override" },
    { "Proxy-Authorization": "override" },
  ]) {
    await expect(
      executeGraphQLRequest({
        db: ctx.testDb.db,
        tenant_id: ctx.tenantId,
        connector: conn,
        op: { operation: "query", query: "query { ok }" },
        extra_headers,
      }),
    ).rejects.toBeInstanceOf(HttpRequestInvalidError);
  }
  await credential(conn, { Authorization: "fixture-owned" });
  await expect(
    executeGraphQLRequest({
      db: ctx.testDb.db,
      tenant_id: ctx.tenantId,
      connector: conn,
      op: { operation: "query", query: "query { ok }" },
      extra_headers: { authorization: "override" },
    }),
  ).rejects.toBeInstanceOf(HttpRequestInvalidError);
  expect(dispatches).toBe(before);
});
