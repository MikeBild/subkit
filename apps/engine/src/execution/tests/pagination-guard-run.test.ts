import { afterAll, beforeAll, beforeEach, describe, expect, test } from "bun:test";
import { connectors } from "../../db/schema/index.ts";
import { runExecution } from "../engine.ts";
import type { RequestPaginationSummary } from "../types.ts";
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
let connectorId: string;
const hits: string[] = [];

beforeAll(async () => {
  ctx = await createEngineCtx("pagination-guard-run");
  mock = await createMockServer((req, res) => {
    const url = new URL(req.url ?? "/", "http://mock");
    hits.push(`${url.pathname}${url.search}`);
    if (url.pathname === "/stuck") {
      jsonResponse(res, 200, { items: [{ id: 1 }, { id: 2 }] });
      return;
    }
    if (url.pathname === "/cursor-loop") {
      const cursor = url.searchParams.get("cursor");
      jsonResponse(res, 200, {
        items: [{ id: cursor ?? "start" }],
        next: cursor === null ? "a" : cursor === "a" ? "b" : "a",
      });
      return;
    }
    const page = Number(url.searchParams.get("page") ?? "1");
    jsonResponse(res, 200, { items: [{ id: page * 2 - 1 }, { id: page * 2 }] });
  });
  const [connector] = await ctx.testDb.db
    .insert(connectors)
    .values({
      tenant_id: ctx.tenantId,
      slug: "paging-guard",
      display_name: "Paging guard",
      driver: "http",
      environment: "dev",
      auth_type: "none",
      base_url: mock.baseUrl,
      config: {},
    })
    .returning();
  if (!connector) throw new Error("connector insert failed");
  connectorId = connector.id;
});

afterAll(async () => {
  await mock.close();
  await ctx.cleanup();
});

beforeEach(() => {
  hits.length = 0;
});

async function run(slug: string, path: string, pagination: Record<string, unknown>) {
  const { workflow_id } = await createWorkflowRow(ctx, {
    name: slug,
    slug,
    steps: [
      {
        id: "items",
        kind: "request",
        method: "GET",
        connector_id: connectorId,
        path,
        side_effects: "read",
        max_retries: 0,
        pagination: { items_path: "items", max_pages: 10, ...pagination },
      },
    ],
  });
  return runExecution({
    db: ctx.testDb.db,
    tenant_id: ctx.tenantId,
    source: { kind: "saved", workflow_id },
    input: null,
  });
}

function summaryOf(result: Awaited<ReturnType<typeof run>>): RequestPaginationSummary | undefined {
  const meta = result.steps[0]?.request_meta as { pagination?: RequestPaginationSummary };
  return meta?.pagination;
}

describe("http pagination guard", () => {
  test("stops at a page that repeats an earlier one and says so", async () => {
    const result = await run("paging-duplicate", "/stuck", {
      strategy: "page",
      page_size: 2,
    });
    expect(result.status).toBe("succeeded");
    expect(result.output).toEqual([{ id: 1 }, { id: 2 }]);
    expect(hits).toHaveLength(2);
    expect(summaryOf(result)).toMatchObject({
      limit: "duplicate_page",
      complete: false,
      pages: 2,
      items: 2,
    });
    expect(result.warnings?.map((warning) => warning.code)).toEqual(["pagination_duplicate_page"]);
  });

  test("refuses a cursor that comes back again", async () => {
    const result = await run("paging-cursor-loop", "/cursor-loop", {
      strategy: "cursor",
      cursor_request_param: "cursor",
      cursor_response_path: "next",
    });
    expect(result.status).toBe("failed");
    expect((result.steps[0]?.error as { code?: string } | null)?.code).toBe(
      "pagination_cursor_repeated",
    );
    expect(hits).toEqual(["/cursor-loop", "/cursor-loop?cursor=a", "/cursor-loop?cursor=b"]);
  });

  test("stop_when ends the pagination as complete", async () => {
    const result = await run("paging-stop-when", "/numbers", {
      strategy: "page",
      page_size: 2,
      stop_when: "(page, info) => info.items >= 4 && page.items.length === 2",
    });
    expect(result.status).toBe("succeeded");
    expect(result.output).toEqual([{ id: 1 }, { id: 2 }, { id: 3 }, { id: 4 }]);
    expect(hits).toHaveLength(2);
    expect(summaryOf(result)).toMatchObject({ limit: null, complete: true, pages: 2 });
    expect(result.warnings).toBeUndefined();
  });

  test("a stop_when that does not answer true or false fails the step", async () => {
    const result = await run("paging-stop-when-bad", "/numbers", {
      strategy: "page",
      page_size: 2,
      stop_when: "(page) => page.items.length",
    });
    expect(result.status).toBe("failed");
    expect((result.steps[0]?.error as { code?: string } | null)?.code).toBe(
      "pagination_stop_when_failed",
    );
    expect(hits).toHaveLength(1);
  });
});
