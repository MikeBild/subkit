import { afterAll, beforeAll, expect, test } from "bun:test";
import { and, eq } from "drizzle-orm";
import { serializeStep } from "../../api/operations/execution-representation.ts";
import { upsertCredential } from "../../credentials/service.ts";
import { auditLog } from "../../db/schema/audit.ts";
import { connectors, executionSteps, requestHooks } from "../../db/schema/index.ts";
import { runExecution } from "../engine.ts";
import {
  createEngineCtx,
  createMockServer,
  createWorkflowRow,
  type EngineTestCtx,
  jsonResponse,
  type MockServer,
} from "./setup.ts";

let ctx: EngineTestCtx;
let mock: MockServer;
let sequence = 0;
const SECRET = "s3cr3t-appid-value";
const STATIC_SECRET = "s3cr3t-static-value";

beforeAll(async () => {
  ctx = await createEngineCtx("query-credential-urls");
  mock = await createMockServer((_, res) => jsonResponse(res, 200, { ok: true }));
}, 30_000);
afterAll(async () => {
  await mock.close();
  await ctx.cleanup();
}, 30_000);

async function run(step: Record<string, unknown>, options: Record<string, unknown> = {}) {
  const slug = `query-credential-urls-${++sequence}`;
  const db = ctx.testDb.db;
  const [connector] = await db
    .insert(connectors)
    .values({
      tenant_id: ctx.tenantId,
      slug,
      display_name: slug,
      driver: "http",
      auth_type: "query",
      environment: "dev",
      base_url: `${mock.baseUrl}/endpoint`,
      config: { static_query: { partner: STATIC_SECRET } },
    })
    .returning();
  if (!connector) throw new Error("missing connector fixture");
  await upsertCredential(
    {
      tenant_id: ctx.tenantId,
      connector_id: connector.id,
      environment: "dev",
      mode: "query",
      actor_id: null,
      value: { mode: "query", query: { appid: SECRET } },
    },
    db,
  );
  const workflow = await createWorkflowRow(ctx, {
    name: slug,
    slug,
    steps: [{ id: "call", kind: "request", connector_id: connector.id, ...step }],
  });
  const result = await runExecution({
    db,
    tenant_id: ctx.tenantId,
    source: { kind: "saved", workflow_id: workflow.workflow_id },
    input: null,
    ...(Object.keys(options).length > 0 ? { options } : {}),
  });
  const rows = await db
    .select()
    .from(executionSteps)
    .where(
      and(
        eq(executionSteps.tenant_id, ctx.tenantId),
        eq(executionSteps.execution_id, result.execution_id),
      ),
    );
  const audit = await db
    .select()
    .from(auditLog)
    .where(and(eq(auditLog.tenant_id, ctx.tenantId), eq(auditLog.resource_id, connector.id)));
  return { result, rows, audit };
}

function expectClean(value: unknown) {
  const text = JSON.stringify(value);
  expect(text).not.toContain(SECRET);
  expect(text).not.toContain(STATIC_SECRET);
}

test("the request is sent with the credential, and nothing recorded holds its value", async () => {
  const reached: string[] = [];
  mock.setHandler((req, res) => {
    reached.push(String(req.url));
    jsonResponse(res, 200, { ok: true });
  });
  const { result, rows, audit } = await run({
    method: "GET",
    path: "/items",
    query: { tz: "UTC" },
  });
  expect(result.status).toBe("succeeded");
  expect(reached).toEqual([`/endpoint/items?tz=UTC&partner=${STATIC_SECRET}&appid=${SECRET}`]);
  expect(rows[0]?.request_meta).toMatchObject({
    url: `${mock.baseUrl}/endpoint/items?tz=UTC&partner=***&appid=***`,
  });
  expectClean(rows);
  expectClean(result);
  expectClean(audit);
});

test("a failed request records its address without the credential value", async () => {
  mock.setHandler((_, res) => jsonResponse(res, 404, { error: "nope" }));
  const { result, rows, audit } = await run({ method: "GET", path: "/missing" });
  expect(result.status).toBe("failed");
  expect((rows[0]?.error as { resolved_url?: string } | null)?.resolved_url).toBe(
    `${mock.baseUrl}/endpoint/missing?partner=***&appid=***`,
  );
  expectClean(rows);
  expectClean(result);
  expectClean(audit);
});

test("a held write shows its address without the credential value", async () => {
  let requests = 0;
  mock.setHandler((_, res) => {
    requests++;
    jsonResponse(res, 200, { ok: true });
  });
  const { result, rows } = await run(
    { method: "POST", path: "/items", body: { name: "a" } },
    { hold_writes: true },
  );
  expect(requests).toBe(0);
  const held = result.steps.find((step) => step.step_key === "call");
  expect(held?.held).toBe(true);
  expect(held?.held_request?.url).toBe(`${mock.baseUrl}/endpoint/items?partner=***&appid=***`);
  expectClean(rows);
  expectClean(result);
});

test("every page of a paginated read is recorded without the credential value", async () => {
  let page = 0;
  mock.setHandler((_, res) => {
    page++;
    jsonResponse(res, 200, {
      items: [{ id: page }, { id: page + 100 }],
      next: page < 2 ? "p2" : null,
    });
  });
  const { result, rows, audit } = await run({
    method: "GET",
    path: "/items",
    pagination: {
      strategy: "cursor",
      cursor_request_param: "cursor",
      cursor_response_path: "$.next",
      items_path: "$.items",
      max_pages: 3,
    },
  });
  expect(result.status).toBe("succeeded");
  expect(page).toBe(2);
  expectClean(rows);
  expectClean(result);
  expectClean(audit);
});

test("a row written before the fix is returned scrubbed by the execution API", async () => {
  mock.setHandler((_, res) => jsonResponse(res, 200, { ok: true }));
  const { rows } = await run({ method: "GET", path: "/items" });
  const row = rows[0];
  if (!row) throw new Error("missing step row");
  const old = {
    ...row,
    request_meta: { driver: "http", url: "https://api.example.test/v1?api_key=s3cr3t-old&page=2" },
    error: { code: "http_4xx", resolved_url: "https://api.example.test/v1?token=s3cr3t-old" },
  } as typeof row;
  const shown = serializeStep(old);
  expect(JSON.stringify(shown)).not.toContain("s3cr3t-old");
  expect(shown.request_meta).toEqual({
    driver: "http",
    url: "https://api.example.test/v1?api_key=***&page=2",
  });
});

test("a policy hook that denies the request leaves no credential value in its audit row", async () => {
  const role = "query-credential-deny";
  const [hook] = await ctx.testDb.db
    .insert(requestHooks)
    .values({
      tenant_id: ctx.tenantId,
      role,
      source: `return { allow: !input.request.url.includes(${JSON.stringify(SECRET)}), reason: "saw " + input.request.url };`,
      version: 1,
      enabled: true,
    })
    .returning();
  if (!hook) throw new Error("missing hook fixture");
  let requests = 0;
  mock.setHandler((_, res) => {
    requests++;
    jsonResponse(res, 200, { ok: true });
  });
  const { result, rows } = await run(
    { method: "GET", path: "/items", query: { tz: "UTC" } },
    {
      principal: {
        provider: "test",
        kind: "user",
        id: "00000000-0000-4000-8000-000000000001",
        tenant_id: ctx.tenantId,
        roles: [role],
      },
    },
  );
  expect(requests).toBe(0);
  expect(result.status).toBe("failed");
  expect(result.steps[0]?.error).toMatchObject({
    code: "policy.denied",
    message: `saw ${mock.baseUrl}/endpoint/items?tz=UTC&partner=***&appid=***`,
  });
  const denials = await ctx.testDb.db
    .select()
    .from(auditLog)
    .where(and(eq(auditLog.tenant_id, ctx.tenantId), eq(auditLog.resource_id, hook.id)));
  expect(denials).toHaveLength(1);
  expect(denials[0]?.action).toBe("policy.denied");
  expect((denials[0]?.metadata as { url?: string } | undefined)?.url).toBe(
    `${mock.baseUrl}/endpoint/items?tz=UTC&partner=***&appid=***`,
  );
  expectClean(denials);
  expectClean(rows);
  expectClean(result);
});
