import { afterAll, beforeAll, beforeEach, describe, expect, test } from "bun:test";
import type { IncomingMessage, ServerResponse } from "node:http";
import { and, eq } from "drizzle-orm";
import { upsertCredential } from "../../credentials/service.ts";
import { auditLog, connectors } from "../../db/schema/index.ts";
import { getTestNow } from "../../test-helpers/determinism/clock.ts";
import { runExecution } from "../engine.ts";
import { withRateLimitClockForTests } from "../steps/request/rate-limit.ts";
import {
  createEngineCtx,
  createMockServer,
  createWorkflowRow,
  type EngineTestCtx,
  jsonResponse,
  type MockServer,
} from "./setup.ts";

const TOKEN = "graphql-path-fixture-token";
const NODES = ["a", "b", "c", "d", "e"].map((id) => ({ id }));

interface SeenRequest {
  url: string;
  method: string;
  authorization: string | undefined;
  apiVersion: string | undefined;
  after: unknown;
}

let ctx: EngineTestCtx;
let mock: MockServer;
let connectorId: string;
const seen: SeenRequest[] = [];
let answer: (
  after: unknown,
  call: number,
) => { status: number; headers?: Record<string, string>; body: unknown };

function page(after: unknown) {
  const start = after === null ? 0 : Number(String(after).replace("cursor-", ""));
  const nodes = NODES.slice(start, start + 2);
  const next = start + 2 < NODES.length;
  return {
    data: {
      user: {
        projectV2: {
          items: {
            totalCount: NODES.length,
            nodes,
            pageInfo: { hasNextPage: next, endCursor: next ? `cursor-${start + 2}` : null },
          },
        },
      },
    },
  };
}

async function readBody(req: IncomingMessage): Promise<{ variables?: { after?: unknown } }> {
  const chunks: Buffer[] = [];
  for await (const chunk of req) chunks.push(chunk as Buffer);
  return JSON.parse(Buffer.concat(chunks).toString("utf8"));
}

beforeAll(async () => {
  ctx = await createEngineCtx("graphql-over-http-path");
  mock = await createMockServer(async (req: IncomingMessage, res: ServerResponse) => {
    const body = await readBody(req);
    const after = body.variables?.after ?? null;
    seen.push({
      url: req.url ?? "",
      method: req.method ?? "",
      authorization: req.headers.authorization,
      apiVersion: req.headers["x-github-api-version"] as string | undefined,
      after,
    });
    if (req.headers.authorization !== `Bearer ${TOKEN}`) {
      jsonResponse(res, 401, { message: "Bad credentials" });
      return;
    }
    const reply = answer(after, seen.length);
    for (const [key, value] of Object.entries(reply.headers ?? {})) res.setHeader(key, value);
    jsonResponse(res, reply.status, reply.body);
  });
  const [connector] = await ctx.testDb.db
    .insert(connectors)
    .values({
      tenant_id: ctx.tenantId,
      slug: "github-http",
      display_name: "GitHub REST",
      driver: "http",
      environment: "dev",
      auth_type: "bearer",
      base_url: mock.baseUrl,
      config: {
        static_headers: { "X-GitHub-Api-Version": "2022-11-28" },
        static_query: { fixture: "1" },
      },
    })
    .returning();
  connectorId = connector!.id;
  await upsertCredential(
    {
      tenant_id: ctx.tenantId,
      connector_id: connectorId,
      environment: "dev",
      mode: "bearer",
      actor_id: null,
      value: { mode: "bearer", token: TOKEN },
    },
    ctx.testDb.db,
  );
});

afterAll(async () => {
  await mock.close();
  await ctx.cleanup();
});

beforeEach(() => {
  seen.length = 0;
  answer = (after) => ({ status: 200, body: page(after) });
});

const QUERY =
  "query Items($after: String, $login: String!, $number: Int!) { user(login: $login) { projectV2(number: $number) { items(first: 2, after: $after) { totalCount nodes { id } pageInfo { hasNextPage endCursor } } } } }";

function projectStep(extra: Record<string, unknown> = {}, graphql: Record<string, unknown> = {}) {
  return {
    kind: "request",
    id: "project_items",
    connector_id: connectorId,
    method: "GET",
    path: "/graphql",
    graphql: {
      operation: "query",
      query: QUERY,
      variables: { after: null, login: "MikeBild", number: 4 },
      cursor_pagination: {
        connection_path: "user.projectV2.items",
        cursor_variable: "after",
        items_field: "nodes",
        max_pages: 10,
        max_items: 100,
      },
      ...graphql,
    },
    ...extra,
  };
}

async function run(name: string, step: Record<string, unknown>, sensitive = false) {
  const { workflow_id } = await createWorkflowRow(ctx, {
    name,
    ...(sensitive ? { execution_privacy: "sensitive" } : {}),
    steps: [step],
  });
  return runExecution({
    db: ctx.testDb.db,
    tenant_id: ctx.tenantId,
    source: { kind: "saved", workflow_id },
    input: null,
  });
}

const items = (output: unknown) =>
  (output as { user: { projectV2: { items: { nodes: Array<{ id: string }> } } } }).user.projectV2
    .items.nodes;

describe("graphql block on an http connector through path /graphql", () => {
  test("reads every cursor page with the connector credential, headers and query", async () => {
    const result = await run("gql-path-pages", projectStep());
    expect(result.status).toBe("succeeded");
    expect(items(result.output).map((node) => node.id)).toEqual(["a", "b", "c", "d", "e"]);
    expect(seen.map((entry) => entry.after)).toEqual([null, "cursor-2", "cursor-4"]);
    for (const entry of seen) {
      expect(entry).toMatchObject({
        url: "/graphql?fixture=1",
        method: "POST",
        authorization: `Bearer ${TOKEN}`,
        apiVersion: "2022-11-28",
      });
    }
    const meta = result.steps[0]?.request_meta as { driver?: string } | null;
    expect(meta?.driver).toBe("graphql");
    const invoked = await ctx.testDb.db
      .select()
      .from(auditLog)
      .where(
        and(
          eq(auditLog.tenant_id, ctx.tenantId),
          eq(auditLog.action, "connector.invoked"),
          eq(auditLog.resource_id, connectorId),
          eq(auditLog.resource_type, "connector"),
        ),
      );
    const forRun = invoked.filter(
      (row) => (row.metadata as { execution_id?: string }).execution_id === result.execution_id,
    );
    expect(forRun).toHaveLength(3);
    expect(forRun.every((row) => (row.metadata as { path?: string }).path === "/graphql")).toBe(
      true,
    );
    expect(JSON.stringify(invoked)).not.toContain(TOKEN);
  });

  test("two runs read identical output in identical order", async () => {
    const first = await run("gql-path-determinism-1", projectStep());
    const firstSeen = seen.map((entry) => entry.after);
    seen.length = 0;
    const second = await run("gql-path-determinism-2", projectStep());
    expect(second.output).toEqual(first.output);
    expect(seen.map((entry) => entry.after)).toEqual(firstSeen);
  });

  test("a repeated node fails as incomplete", async () => {
    answer = (after) => {
      const body = page(after);
      if (after === "cursor-2") body.data.user.projectV2.items.nodes = [{ id: "a" }, { id: "d" }];
      return { status: 200, body };
    };
    const result = await run("gql-path-duplicate", projectStep());
    expect(result.status).toBe("failed");
    expect((result.steps[0]?.error as { code?: string })?.code).toBe(
      "graphql_pagination_incomplete",
    );
  });

  test("a mutation with cursor pagination is refused before any request", async () => {
    const result = await run(
      "gql-path-mutation",
      projectStep(
        {},
        {
          operation: "mutation",
          query: "mutation Change($after: String) { change(after: $after) { id } }",
          cursor_pagination: {
            connection_path: "change",
            cursor_variable: "after",
            items_field: "nodes",
            max_pages: 2,
            max_items: 10,
          },
        },
      ),
    );
    expect((result.steps[0]?.error as { code?: string })?.code).toBe(
      "graphql_pagination_not_read_only",
    );
    expect(seen).toHaveLength(0);
  });

  test.each([
    ["missing path", { path: undefined }, "graphql_path_required"],
    ["foreign path", { path: "//127.0.0.2/graphql" }, "graphql_endpoint_invalid"],
    ["step url", { url: "http://127.0.0.2/graphql" }, "graphql_endpoint_invalid"],
    ["non-graphql path", { path: "/admin/cache/purge" }, "graphql_endpoint_invalid"],
    ["dispatch path", { path: "/repos/o/r/dispatches" }, "graphql_endpoint_invalid"],
  ])("%s is refused before any request", async (label, extra, code) => {
    const result = await run(`gql-path-refused-${label.replace(/\s/g, "-")}`, projectStep(extra));
    expect(result.status).toBe("failed");
    expect((result.steps[0]?.error as { code?: string; message?: string })?.code).toBe(code);
    expect(JSON.stringify(result.steps[0]?.error)).not.toContain("127.0.0.2");
    expect(seen).toHaveLength(0);
  });

  test("a sensitive run reads all pages and keeps a safe failure code", async () => {
    const ok = await run("gql-path-sensitive", projectStep(), true);
    expect(ok.status).toBe("succeeded");
    expect(seen).toHaveLength(3);
    answer = (after) => {
      const body = page(after);
      if (after === "cursor-2") body.data.user.projectV2.items.nodes = [{ id: "a" }, { id: "d" }];
      return { status: 200, body };
    };
    const failed = await run("gql-path-sensitive-failed", projectStep(), true);
    expect(failed.status).toBe("failed");
    expect(failed.error?.code).toBe("graphql_pagination_incomplete");
    expect((failed.steps[0]?.error as { code?: string })?.code).toBe(
      "graphql_pagination_incomplete",
    );
  });

  test.each([
    ["missing path", { path: undefined }, "graphql_path_required"],
    ["foreign path", { path: "//127.0.0.2/graphql" }, "graphql_endpoint_invalid"],
  ])("a sensitive run keeps the %s code at run and step level", async (label, extra, code) => {
    const result = await run(
      `gql-path-sensitive-refused-${label.replace(/\s/g, "-")}`,
      projectStep(extra),
      true,
    );
    expect(result.status).toBe("failed");
    expect(result.error?.code).toBe(code);
    expect((result.steps[0]?.error as { code?: string })?.code).toBe(code);
    expect(JSON.stringify(result)).not.toContain("127.0.0.2");
    expect(seen).toHaveLength(0);
  });
});

describe("GitHub GraphQL rate limits through path /graphql", () => {
  test("a primary limit in a 200 response waits for the reset and continues", async () => {
    answer = (after, call) =>
      call === 2
        ? {
            status: 200,
            headers: {
              "x-ratelimit-remaining": "0",
              "x-ratelimit-reset": String(Math.floor(Date.now() / 1000)), // allow-wall-clock
            },
            body: { errors: [{ type: "RATE_LIMITED", message: "API rate limit exceeded" }] },
          }
        : { status: 200, body: page(after) };
    const result = await run("gql-path-primary-limit", projectStep());
    expect(result.status).toBe("succeeded");
    expect(items(result.output)).toHaveLength(5);
    expect(seen.map((entry) => entry.after)).toEqual([null, "cursor-2", "cursor-2", "cursor-4"]);
  });

  test("a secondary limit 403 with retry-after retries", async () => {
    answer = (after, call) =>
      call === 1
        ? {
            status: 403,
            headers: { "retry-after": "1" },
            body: { message: "You have exceeded a secondary rate limit." },
          }
        : { status: 200, body: page(after) };
    const result = await run("gql-path-secondary-limit", projectStep());
    expect(result.status).toBe("succeeded");
    expect(seen).toHaveLength(4);
  });

  test("secondary limits wait on the shared clock, one minute doubling per attempt", async () => {
    const now = getTestNow();
    const waits: number[] = [];
    answer = (after, call) =>
      call <= 2
        ? {
            status: 403,
            headers: {},
            body: { message: "You have exceeded a secondary rate limit." },
          }
        : { status: 200, body: page(after) };
    const result = await withRateLimitClockForTests(
      { now: () => now, sleep: async (ms) => void waits.push(ms) },
      () =>
        run("gql-path-secondary-clock", projectStep({ timeout_ms: 10 * 60_000, max_retries: 3 })),
    );
    expect(result.status).toBe("succeeded");
    expect(waits).toEqual([60_000, 120_000]);
    expect(items(result.output)).toHaveLength(5);
  });

  test("a secondary limit past the deadline on the shared clock fails without sleeping", async () => {
    const now = getTestNow();
    const waits: number[] = [];
    answer = () => ({
      status: 403,
      headers: {},
      body: { message: "You have exceeded a secondary rate limit." },
    });
    const result = await withRateLimitClockForTests(
      { now: () => now, sleep: async (ms) => void waits.push(ms) },
      () => run("gql-path-secondary-deadline", projectStep({ timeout_ms: 30_000, max_retries: 3 })),
    );
    expect(result.status).toBe("failed");
    expect((result.steps[0]?.error as { code?: string })?.code).toBe("upstream_rate_limited");
    expect(waits).toEqual([]);
    expect(seen).toHaveLength(1);
  });

  test("a limit past the step deadline fails without further requests", async () => {
    answer = () => ({
      status: 403,
      headers: { "retry-after": "3600" },
      body: { message: "You have exceeded a secondary rate limit." },
    });
    const result = await run("gql-path-limit-deadline", projectStep({ timeout_ms: 30_000 }));
    expect(result.status).toBe("failed");
    expect((result.steps[0]?.error as { code?: string })?.code).toBe("upstream_rate_limited");
    expect(seen).toHaveLength(1);
  });
});
