import { afterAll, beforeAll, beforeEach, expect, test } from "bun:test";
import type { IncomingMessage, ServerResponse } from "node:http";
import { upsertCredential } from "../../credentials/service.ts";
import { connectors } from "../../db/schema/index.ts";
import { runExecution } from "../engine.ts";
import {
  createEngineCtx,
  createMockServer,
  createWorkflowRow,
  type EngineTestCtx,
  jsonResponse,
  type MockServer,
} from "./setup.ts";

const TOKEN = "paged-sources-fixture-token";
const SINCE = "2026-01-01T00:00:00.000Z";
const COMMITS = Array.from({ length: 237 }, (_, index) => ({ sha: `sha-${index}` }));
const ISSUES = Array.from({ length: 130 }, (_, index) => ({ id: 1000 + index }));
const OPEN = Array.from({ length: 100 }, (_, index) => ({ id: 5000 + index }));
const NODES = Array.from({ length: 73 }, (_, index) => ({ id: `node-${index}` }));

let ctx: EngineTestCtx;
let mock: MockServer;
let connectorId: string;
let repeatIssue = false;
const seen: string[] = [];

function send(res: ServerResponse, body: unknown, link?: string) {
  if (link) res.setHeader("link", link);
  jsonResponse(res, 200, body);
}

async function graphqlAfter(req: IncomingMessage): Promise<unknown> {
  const chunks: Buffer[] = [];
  for await (const chunk of req) chunks.push(chunk as Buffer);
  return JSON.parse(Buffer.concat(chunks).toString("utf8")).variables?.after ?? null;
}

async function handle(req: IncomingMessage, res: ServerResponse) {
  const url = new URL(req.url ?? "/", mock.baseUrl);
  if (req.headers.authorization !== `Bearer ${TOKEN}`) return jsonResponse(res, 401, {});
  if (url.pathname === "/graphql") {
    const after = await graphqlAfter(req);
    seen.push(`graphql ${String(after)}`);
    const start = after === null ? 0 : Number(String(after).replace("cursor-", ""));
    const more = start + 50 < NODES.length;
    return send(res, {
      data: {
        user: {
          projectV2: {
            items: {
              totalCount: NODES.length,
              nodes: NODES.slice(start, start + 50),
              pageInfo: { hasNextPage: more, endCursor: more ? `cursor-${start + 50}` : null },
            },
          },
        },
      },
    });
  }
  const page = Number(url.searchParams.get("page") ?? "1");
  seen.push(`${url.pathname} ${url.searchParams.get("state") ?? ""} ${page}`);
  if (url.pathname === "/repos/acme/app/commits") {
    if (url.searchParams.get("since") !== SINCE) return jsonResponse(res, 422, {});
    const next =
      page < 3
        ? `<${mock.baseUrl}/repositories/9/commits?sha=main&since=${SINCE}&per_page=100&page=${page + 1}>; rel="next"`
        : undefined;
    return send(res, COMMITS.slice((page - 1) * 100, page * 100), next);
  }
  if (url.pathname === "/repos/acme/app/issues" && url.searchParams.get("state") === "all") {
    if (url.searchParams.get("after") === null)
      return send(
        res,
        ISSUES.slice(0, 100),
        `<${mock.baseUrl}/repositories/9/issues?state=all&per_page=100&after=Y3Vyc29y&page=2>; rel="next"`,
      );
    const rest = ISSUES.slice(100);
    return send(res, repeatIssue ? [ISSUES[99], ...rest] : rest);
  }
  if (url.pathname === "/repos/acme/app/issues")
    return page === 1
      ? send(
          res,
          OPEN,
          `<${mock.baseUrl}/repos/acme/app/issues?state=open&per_page=100&page=2>; rel="next"`,
        )
      : send(res, []);
  return jsonResponse(res, 404, {});
}

beforeAll(async () => {
  ctx = await createEngineCtx("paged-sources-run");
  mock = await createMockServer(handle);
  const [connector] = await ctx.testDb.db
    .insert(connectors)
    .values({
      tenant_id: ctx.tenantId,
      slug: "paged-sources",
      display_name: "Paged sources",
      driver: "http",
      environment: "dev",
      auth_type: "bearer",
      base_url: mock.baseUrl,
      config: {},
    })
    .returning();
  if (!connector) throw new Error("connector insert failed");
  connectorId = connector.id;
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
  repeatIssue = false;
});

function listStep(id: string, query: Record<string, string>, extra: Record<string, unknown>) {
  return {
    id,
    kind: "request",
    connector_id: connectorId,
    method: "GET",
    path: id === "commits" ? "/repos/acme/app/commits" : "/repos/acme/app/issues",
    query,
    side_effects: "read",
    on_error: "continue",
    max_retries: 0,
    pagination: {
      strategy: "link",
      link_params: id === "commits" ? ["page"] : ["after", "page"],
      limit_param: "per_page",
      page_size: 100,
      max_pages: 10,
      on_limit: "truncate",
      unique_by: id === "commits" ? "sha" : "id",
      ...extra,
    },
  };
}

const SUMMARY =
  "const s = input.scope; const source = id => ({ count: Array.isArray(s[id].data) ? s[id].data.length : 0, pagination: s[id].pagination || null, error: s[id].error ? s[id].error.code : null }); const items = s.project.data ? s.project.data.user.projectV2.items : null; return { commits: source('commits'), issues: source('issues'), open: source('open'), project: { count: items ? items.nodes.length : 0, total: items ? items.totalCount : null, pagination: s.project.pagination || null, error: s.project.error ? s.project.error.code : null } };";

function steps(commitsExtra: Record<string, unknown> = {}) {
  return [
    {
      id: "window",
      kind: "transform",
      language: "javascript",
      expression: `return { since: '${SINCE}' };`,
    },
    listStep("commits", { sha: "main", since: "${scope.window.data.since}" }, commitsExtra),
    listStep("issues", { state: "all" }, {}),
    listStep("open", { state: "open" }, {}),
    {
      id: "project",
      kind: "request",
      protocol: "graphql",
      connector_id: connectorId,
      method: "POST",
      path: "/graphql",
      side_effects: "read",
      on_error: "continue",
      graphql: {
        operation: "query",
        query:
          'query Items($after: String) { user(login: "acme") { projectV2(number: 1) { items(first: 50, after: $after) { totalCount nodes { id } pageInfo { hasNextPage endCursor } } } } }',
        variables: { after: null },
        cursor_pagination: {
          connection_path: "user.projectV2.items",
          cursor_variable: "after",
          items_field: "nodes",
          max_pages: 10,
          max_items: 1000,
        },
      },
    },
    { id: "summary", kind: "transform", language: "javascript", expression: SUMMARY },
  ];
}

async function run(slug: string, commitsExtra: Record<string, unknown> = {}) {
  const { workflow_id } = await createWorkflowRow(ctx, {
    name: slug,
    slug,
    execution_privacy: "sensitive",
    steps: steps(commitsExtra),
  });
  return runExecution({
    db: ctx.testDb.db,
    tenant_id: ctx.tenantId,
    source: { kind: "saved", workflow_id },
    input: {},
  });
}

const complete = (pages: number, items: number, duplicates = 0) => ({
  pages,
  items,
  duplicates_dropped: duplicates,
  complete: true,
  truncated: false,
});

test("a sensitive run reads every REST and GraphQL page and exposes completeness to transforms", async () => {
  const first = await run("paged-sources-complete");
  expect(first.status).toBe("succeeded");
  expect(first.warnings ?? []).toEqual([]);
  expect(first.output).toEqual({
    commits: { count: 237, pagination: complete(3, 237), error: null },
    issues: { count: 130, pagination: complete(2, 130), error: null },
    open: { count: 100, pagination: complete(2, 100), error: null },
    project: { count: 73, total: 73, pagination: complete(2, 73), error: null },
  });
  expect(seen.filter((entry) => entry.startsWith("/repositories"))).toEqual([]);
  const order = [...seen];
  seen.length = 0;
  const second = await run("paged-sources-repeat");
  expect(second.output).toEqual(first.output);
  expect([...seen].sort()).toEqual([...order].sort());
});

test("a row repeated across pages is read once and counted", async () => {
  repeatIssue = true;
  const result = await run("paged-sources-duplicate");
  expect((result.output as { issues: unknown }).issues).toEqual({
    count: 130,
    pagination: complete(2, 130, 1),
    error: null,
  });
});

test("a page limit truncates one source explicitly while the others stay complete", async () => {
  const result = await run("paged-sources-truncated", { max_pages: 2 });
  expect(result.status).toBe("succeeded");
  expect(result.warnings).toEqual([
    expect.objectContaining({ code: "pagination_truncated", step_key: "commits" }),
  ]);
  const output = result.output as Record<
    string,
    { count: number; pagination: unknown; error: unknown }
  >;
  expect(output.commits).toEqual({
    count: 200,
    pagination: { pages: 2, items: 200, duplicates_dropped: 0, complete: false, truncated: true },
    error: null,
  });
  expect(output.issues?.pagination).toEqual(complete(2, 130));
  expect(seen.filter((entry) => entry.startsWith("/repos/acme/app/commits"))).toHaveLength(2);
});
