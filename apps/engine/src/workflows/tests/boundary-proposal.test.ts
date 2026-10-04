import { afterAll, beforeAll, expect, test } from "bun:test";
import { eq } from "drizzle-orm";
import {
  connectors,
  executionSteps,
  executions,
  tenants,
  workflows,
} from "../../db/schema/index.ts";
import { createTestDb, type TestDb } from "../../db/tests/setup.ts";
import { proposeBoundaries } from "../boundary-proposal.ts";
import type { WorkflowDef } from "../types.ts";

let ctx: TestDb;
let tenant_id = "";
let workflow_id = "";

const CONNECTOR = "00000000-0000-4000-8000-000000000001";

beforeAll(async () => {
  ctx = await createTestDb("boundary_proposal");
  const [tenant] = await ctx.db
    .insert(tenants)
    .values({ slug: "proposal-owner", display_name: "Proposal owner" })
    .returning();
  tenant_id = tenant?.id ?? "";
  const [wf] = await ctx.db
    .insert(workflows)
    .values({ tenant_id, slug: "proposal-wf", name: "Proposal", lifecycle: "active" })
    .returning();
  workflow_id = wf?.id ?? "";
});
afterAll(async () => {
  await ctx.cleanup();
});

async function record(
  rows: Array<{
    step: string;
    url?: string;
    key?: string;
    prefix?: string;
    bytes?: number;
    refused?: true;
  }>,
) {
  await ctx.db.delete(executions).where(eq(executions.workflow_id, workflow_id));
  const [execution] = await ctx.db
    .insert(executions)
    .values({
      tenant_id,
      workflow_id,
      status: "succeeded",
      request_source: "api",
      execution_mode: "prod",
    })
    .returning();
  await ctx.db.insert(executionSteps).values(
    rows.map((row, index) => ({
      tenant_id,
      execution_id: execution?.id as string,
      step_key: row.step,
      step_index: index,
      kind: "request" as const,
      status: row.refused ? ("failed" as const) : ("succeeded" as const),
      request_meta: {
        driver: row.key || row.prefix ? "s3" : "http",
        ...(row.url ? { url: row.url } : {}),
        ...(row.key ? { key: row.key } : {}),
        ...(row.prefix ? { prefix: row.prefix } : {}),
        ...(row.bytes ? { bytes_out: row.bytes } : {}),
        ...(row.refused ? { refused: true } : {}),
      },
    })),
  );
}

const definition = (steps: unknown[]): WorkflowDef =>
  ({ name: "Proposal", steps }) as unknown as WorkflowDef;

const read = {
  id: "read_page",
  kind: "request",
  connector_id: CONNECTOR,
  method: "GET",
  // biome-ignore lint/suspicious/noTemplateCurlyInString: authored placeholder
  path: "/v1/pages/${input.page_id}",
};

test("a value the step really sent decides its rule, and the narrowest one wins", async () => {
  await record([
    {
      step: "read_page",
      url: "https://api.example.test/v1/pages/8f14e45f-ceea-467a-87f3-b3b6e4d0f8a1",
    },
    {
      step: "read_page",
      url: "https://api.example.test/v1/pages/2c1a3b44-5d6e-4f70-8192-a3b4c5d6e7f8",
    },
  ]);
  const { proposals, unproposable } = await proposeBoundaries(ctx.db, {
    tenant_id,
    workflow_id,
    definition: definition([read]),
  });
  expect(unproposable).toEqual([]);
  expect(proposals[0]?.boundary?.variables).toEqual({ "input.page_id": { class: "uuid" } });
  expect(proposals[0]?.boundary?.max_body_bytes).toBe(0);
  expect(proposals[0]?.evidence.observations).toBe(2);
  expect(proposals[0]?.evidence.sample).toContain("/v1/pages/");
});

test("values no class covers are listed, and only while the list is readable", async () => {
  await record([
    { step: "read_page", url: "https://api.example.test/v1/pages/alpha.beta" },
    { step: "read_page", url: "https://api.example.test/v1/pages/gamma.delta" },
  ]);
  const listed = await proposeBoundaries(ctx.db, {
    tenant_id,
    workflow_id,
    definition: definition([read]),
  });
  expect(listed.proposals[0]?.boundary?.variables).toEqual({
    "input.page_id": { class: "file_name" },
  });

  await record([
    { step: "read_page", url: "https://api.example.test/v1/pages/a%2Fb" },
    { step: "read_page", url: "https://api.example.test/v1/pages/c%2Fd" },
  ]);
  const escaped = await proposeBoundaries(ctx.db, {
    tenant_id,
    workflow_id,
    definition: definition([read]),
  });
  expect(escaped.proposals).toEqual([]);
  expect(escaped.unproposable).toEqual([
    { step_id: "read_page", reason: "values_not_describable" },
  ]);
});

test("no history means no proposal — silence, never a plausible guess", async () => {
  await record([{ step: "other_step", url: "https://api.example.test/v1/pages/x" }]);
  const { proposals, unproposable } = await proposeBoundaries(ctx.db, {
    tenant_id,
    workflow_id,
    definition: definition([read]),
  });
  expect(proposals).toEqual([]);
  expect(unproposable).toEqual([{ step_id: "read_page", reason: "no_history" }]);
});

test("a step that sends content gets no invented size ceiling", async () => {
  await record([
    { step: "send", url: "https://api.example.test/v1/pages/8f14e45f-ceea-467a-87f3-b3b6e4d0f8a1" },
  ]);
  const { unproposable } = await proposeBoundaries(ctx.db, {
    tenant_id,
    workflow_id,
    definition: definition([
      {
        id: "send",
        kind: "request",
        connector_id: CONNECTOR,
        method: "PATCH",
        // biome-ignore lint/suspicious/noTemplateCurlyInString: authored placeholder
        path: "/v1/pages/${input.page_id}",
        body: { archived: true },
      },
    ]),
  });
  expect(unproposable).toEqual([{ step_id: "send", reason: "body_size_unknown" }]);
});

test("a storage step is given the deepest folder that holds everything it touched", async () => {
  await record([
    { step: "store", key: "v1/facts/year=2026/month=09/a.json", bytes: 4096 },
    { step: "store", key: "v1/facts/year=2026/month=08/b.json", bytes: 337_858 },
  ]);
  const { proposals } = await proposeBoundaries(ctx.db, {
    tenant_id,
    workflow_id,
    definition: definition([
      { id: "store", kind: "request", connector_id: CONNECTOR, method: "PUT", s3: { key: "x" } },
    ]),
  });
  expect(proposals[0]?.s3_scope?.key_prefix).toBe("v1/facts/year=2026/");
  expect(proposals[0]?.s3_scope?.max_bytes).toBeGreaterThan(337_858);
});

test("a step that already declares a boundary is left alone", async () => {
  await record([
    {
      step: "read_page",
      url: "https://api.example.test/v1/pages/8f14e45f-ceea-467a-87f3-b3b6e4d0f8a1",
    },
  ]);
  const { proposals, unproposable } = await proposeBoundaries(ctx.db, {
    tenant_id,
    workflow_id,
    definition: definition([
      {
        ...read,
        boundary: {
          variables: { "input.page_id": { class: "identifier" } },
          max_body_bytes: 0,
          max_calls: 1,
        },
      },
    ]),
  });
  expect(proposals).toEqual([]);
  expect(unproposable).toEqual([]);
});

test("a path whose placeholder is not a whole segment is reported, not half-proposed", async () => {
  await record([{ step: "partial", url: "https://api.example.test/v1/pages/page-123" }]);
  const { unproposable } = await proposeBoundaries(ctx.db, {
    tenant_id,
    workflow_id,
    definition: definition([
      {
        id: "partial",
        kind: "request",
        connector_id: CONNECTOR,
        method: "GET",
        // biome-ignore lint/suspicious/noTemplateCurlyInString: authored placeholder
        path: "/v1/pages/page-${input.n}",
      },
    ]),
  });
  expect(unproposable).toEqual([{ step_id: "partial", reason: "path_not_comparable" }]);
});

test("a step that pages without a cap is given the number it really fetched", async () => {
  await ctx.db.delete(executions).where(eq(executions.workflow_id, workflow_id));
  const [execution] = await ctx.db
    .insert(executions)
    .values({
      tenant_id,
      workflow_id,
      status: "succeeded",
      request_source: "api",
      execution_mode: "prod",
    })
    .returning();
  await ctx.db.insert(executionSteps).values(
    [3, 7, 2].map((pages, index) => ({
      tenant_id,
      execution_id: execution?.id as string,
      step_key: "read_page",
      step_index: index,
      kind: "request" as const,
      status: "succeeded" as const,
      request_meta: {
        driver: "http",
        url: "https://api.example.test/v1/pages/8f14e45f-ceea-467a-87f3-b3b6e4d0f8a1",
        pages_fetched: pages,
      },
    })),
  );
  const paging = {
    ...read,
    pagination: {
      strategy: "cursor",
      cursor_request_param: "start_cursor",
      cursor_response_path: "$.next_cursor",
    },
  };
  const { proposals } = await proposeBoundaries(ctx.db, {
    tenant_id,
    workflow_id,
    definition: definition([paging]),
  });
  expect(proposals[0]?.max_pages).toBe(14);

  const capped = await proposeBoundaries(ctx.db, {
    tenant_id,
    workflow_id,
    definition: definition([{ ...paging, pagination: { ...paging.pagination, max_pages: 4 } }]),
  });
  expect(capped.proposals[0]?.max_pages).toBeUndefined();
});

test("a held request is evidence too — target and size both", async () => {
  await ctx.db.delete(executions).where(eq(executions.workflow_id, workflow_id));
  const [execution] = await ctx.db
    .insert(executions)
    .values({
      tenant_id,
      workflow_id,
      status: "succeeded",
      request_source: "api",
      execution_mode: "prod",
    })
    .returning();
  await ctx.db.insert(executionSteps).values({
    tenant_id,
    execution_id: execution?.id as string,
    step_key: "send",
    step_index: 0,
    kind: "request" as const,
    status: "succeeded" as const,
    request_meta: { driver: "http", method: "PATCH" },
    output_preview: [
      {
        send: {
          data: null,
          held: true,
          held_request: {
            url: "https://api.example.test/v1/pages/8f14e45f-ceea-467a-87f3-b3b6e4d0f8a1",
            method: "PATCH",
            body: { archived: true },
          },
        },
      },
    ],
  });
  const { proposals, unproposable } = await proposeBoundaries(ctx.db, {
    tenant_id,
    workflow_id,
    definition: definition([
      {
        id: "send",
        kind: "request",
        connector_id: CONNECTOR,
        method: "PATCH",
        // biome-ignore lint/suspicious/noTemplateCurlyInString: authored placeholder
        path: "/v1/pages/${input.page_id}",
        body: { archived: true },
      },
    ]),
  });
  expect(unproposable).toEqual([]);
  expect(proposals[0]?.boundary?.variables).toEqual({ "input.page_id": { class: "uuid" } });
  expect(proposals[0]?.boundary?.max_body_bytes).toBeGreaterThan(0);
});

test("the preparation run the dialog itself asks for counts as evidence", async () => {
  await ctx.db.delete(executions).where(eq(executions.workflow_id, workflow_id));
  const [execution] = await ctx.db
    .insert(executions)
    .values({
      tenant_id,
      workflow_id,
      status: "succeeded",
      request_source: "api",
      execution_mode: "prod",
    })
    .returning();
  await ctx.db.insert(executionSteps).values({
    tenant_id,
    execution_id: execution?.id as string,
    step_key: "send",
    step_index: 0,
    kind: "request" as const,
    status: "succeeded" as const,
    request_meta: {
      driver: "http",
      method: "PATCH",
      url: null,
      extras: {
        held: true,
        prepared_request_review: {
          url: "https://api.example.test/v1/pages/2c1a3b44-5d6e-4f70-8192-a3b4c5d6e7f8",
          method: "PATCH",
          redacted_request_json: JSON.stringify({ body: { archived: true }, url_query: {} }),
        },
      },
    },
  });
  const { proposals, unproposable } = await proposeBoundaries(ctx.db, {
    tenant_id,
    workflow_id,
    definition: definition([
      {
        id: "send",
        kind: "request",
        connector_id: CONNECTOR,
        method: "PATCH",
        // biome-ignore lint/suspicious/noTemplateCurlyInString: authored placeholder
        path: "/v1/pages/${input.page_id}",
        body: { archived: true },
      },
    ]),
  });
  expect(unproposable).toEqual([]);
  expect(proposals[0]?.boundary?.variables).toEqual({ "input.page_id": { class: "uuid" } });
  expect(proposals[0]?.boundary?.max_body_bytes).toBeGreaterThan(0);
});

test("a step inside a loop is the same step, iteration suffix and all", async () => {
  await ctx.db.delete(executions).where(eq(executions.workflow_id, workflow_id));
  const [execution] = await ctx.db
    .insert(executions)
    .values({
      tenant_id,
      workflow_id,
      status: "succeeded",
      request_source: "api",
      execution_mode: "prod",
    })
    .returning();
  await ctx.db.insert(executionSteps).values(
    [0, 1, 2].map((index) => ({
      tenant_id,
      execution_id: execution?.id as string,
      step_key: `read_page[${index}]`,
      step_index: index,
      kind: "request" as const,
      status: "succeeded" as const,
      request_meta: {
        driver: "http",
        url: `https://api.example.test/v1/pages/8f14e45f-ceea-467a-87f3-b3b6e4d0f8a${index}`,
      },
    })),
  );
  const { proposals, unproposable } = await proposeBoundaries(ctx.db, {
    tenant_id,
    workflow_id,
    definition: definition([read]),
  });
  expect(unproposable).toEqual([]);
  expect(proposals[0]?.step_id).toBe("read_page");
  expect(proposals[0]?.boundary?.variables).toEqual({ "input.page_id": { class: "uuid" } });
  expect(proposals[0]?.evidence.observations).toBe(3);
  expect(proposals[0]?.boundary?.max_calls).toBe(6);
});

test("a folder the step's own writes contradict is corrected, one it fits is not", async () => {
  await record([
    { step: "store", key: "v1/infrastructure/manifests/year=2026/a.json", bytes: 900 },
    { step: "store", key: "v1/infrastructure/manifests/year=2026/b.json", bytes: 1200 },
  ]);
  const storage = (key_prefix: string) => [
    {
      id: "store",
      kind: "request",
      connector_id: CONNECTOR,
      method: "PUT",
      s3: { key: "x", scope: { key_prefix, max_bytes: 4096 } },
    },
  ];
  const wrong = await proposeBoundaries(ctx.db, {
    tenant_id,
    workflow_id,
    definition: definition(storage("v1/latest/")),
  });
  expect(wrong.proposals[0]?.s3_scope?.key_prefix).toBe("v1/infrastructure/manifests/year=2026/");

  const right = await proposeBoundaries(ctx.db, {
    tenant_id,
    workflow_id,
    definition: definition(storage("v1/infrastructure/")),
  });
  expect(right.proposals).toEqual([]);
  expect(right.unproposable).toEqual([{ step_id: "store", reason: "not_supported" }]);
});

test("a query inside the path is rewritten, but only when a real request proves it", async () => {
  await record([
    { step: "list", url: "https://api.example.test/startups?page=1&limit=10" },
    { step: "list", url: "https://api.example.test/startups?page=2&limit=10" },
  ]);
  const listing = (path: string) => [
    { id: "list", kind: "request", connector_id: CONNECTOR, method: "GET", path },
  ];
  const { proposals, unproposable } = await proposeBoundaries(ctx.db, {
    tenant_id,
    workflow_id,
    // biome-ignore lint/suspicious/noTemplateCurlyInString: authored placeholder
    definition: definition(listing("/startups?page=${item.n}&limit=10")),
  });
  expect(unproposable).toEqual([]);
  expect(proposals[0]?.path_rewrite).toEqual({
    path: "/startups",
    // biome-ignore lint/suspicious/noTemplateCurlyInString: authored placeholder
    query: { page: "${item.n}", limit: "10" },
  });
  expect(proposals[0]?.boundary?.variables).toEqual({ "item.n": { class: "integer" } });

  const unproven = await proposeBoundaries(ctx.db, {
    tenant_id,
    workflow_id,
    // biome-ignore lint/suspicious/noTemplateCurlyInString: authored placeholder
    definition: definition(listing("/startups?page=${item.n}&limit=10&sort=revenue")),
  });
  expect(unproven.proposals).toEqual([]);
  expect(unproven.unproposable).toEqual([{ step_id: "list", reason: "path_not_comparable" }]);
});

test("a write whose size was never measured gets no ceiling at all", async () => {
  await record([{ step: "store", key: "v1/facts/year=2026/a.json" }]);
  const { proposals, unproposable } = await proposeBoundaries(ctx.db, {
    tenant_id,
    workflow_id,
    definition: definition([
      { id: "store", kind: "request", connector_id: CONNECTOR, method: "PUT", s3: { key: "x" } },
    ]),
  });
  expect(proposals).toEqual([]);
  expect(unproposable).toEqual([{ step_id: "store", reason: "body_size_unknown" }]);
});

test("a ceiling the step's own writes exceed is the same contradiction as a wrong folder", async () => {
  await record([
    { step: "store", key: "v1/radar/products/a.json", bytes: 337_858 },
    { step: "store", key: "v1/radar/products/b.json", bytes: 12_000 },
  ]);
  const scoped = (max_bytes: number) => [
    {
      id: "store",
      kind: "request",
      connector_id: CONNECTOR,
      method: "PUT",
      s3: { key: "x", scope: { key_prefix: "v1/radar/", max_bytes } },
    },
  ];
  const tooSmall = await proposeBoundaries(ctx.db, {
    tenant_id,
    workflow_id,
    definition: definition(scoped(65_536)),
  });
  expect(tooSmall.proposals[0]?.s3_scope?.max_bytes).toBeGreaterThan(337_858);
  expect(tooSmall.proposals[0]?.s3_scope?.key_prefix).toBe("v1/radar/");

  const roomy = await proposeBoundaries(ctx.db, {
    tenant_id,
    workflow_id,
    definition: definition(scoped(1_000_000)),
  });
  expect(roomy.proposals).toEqual([]);
});

test("the row that proves the contradiction is the refused one", async () => {
  await record([{ step: "store", key: "v1/radar/products/a.json", bytes: 337_858, refused: true }]);
  const { proposals } = await proposeBoundaries(ctx.db, {
    tenant_id,
    workflow_id,
    definition: definition([
      {
        id: "store",
        kind: "request",
        connector_id: CONNECTOR,
        method: "PUT",
        s3: { key: "x", scope: { key_prefix: "v1/radar/", max_bytes: 65_536 } },
      },
    ]),
  });
  expect(proposals[0]?.s3_scope?.max_bytes).toBeGreaterThan(337_858);
  expect(proposals[0]?.s3_scope?.key_prefix).toBe("v1/radar/");
});

test("a listing records the folder it read, and that is evidence", async () => {
  await record([
    { step: "list_raw", prefix: "opportunity-radar/raw/trustmrr/" },
    { step: "list_raw", prefix: "opportunity-radar/raw/trustmrr/" },
  ]);
  const { proposals, unproposable } = await proposeBoundaries(ctx.db, {
    tenant_id,
    workflow_id,
    definition: definition([
      {
        id: "list_raw",
        kind: "request",
        connector_id: CONNECTOR,
        method: "LIST",
        s3: { key: "x" },
      },
    ]),
  });
  expect(unproposable).toEqual([]);
  expect(proposals[0]?.s3_scope?.key_prefix).toBe("opportunity-radar/raw/trustmrr/");
  expect(proposals[0]?.evidence.observations).toBe(2);
});

test("what a request sent is measured, and that is the ceiling", async () => {
  await record([
    { step: "send", url: "https://api.example.test/v1/content", bytes: 40_000 },
    { step: "send", url: "https://api.example.test/v1/content", bytes: 9_000 },
  ]);
  const { proposals, unproposable } = await proposeBoundaries(ctx.db, {
    tenant_id,
    workflow_id,
    definition: definition([
      {
        id: "send",
        kind: "request",
        connector_id: CONNECTOR,
        method: "POST",
        path: "/v1/content",
        body: { title: "x" },
      },
    ]),
  });
  expect(unproposable).toEqual([]);
  expect(proposals[0]?.boundary?.max_body_bytes).toBeGreaterThan(40_000);
});

test("an omitted body still reports its size", async () => {
  await record([{ step: "send", url: "https://api.example.test/v1/content" }]);
  await ctx.db
    .update(executionSteps)
    .set({
      request_meta: {
        driver: "http",
        method: "POST",
        extras: {
          held: true,
          prepared_request_review: {
            url: "https://api.example.test/v1/content",
            method: "POST",
            redacted_request_json: JSON.stringify({ body: null }),
            opaque_payload_omitted: true,
            body_bytes: 51_200,
          },
        },
      },
    })
    .where(eq(executionSteps.step_key, "send"));
  const { proposals, unproposable } = await proposeBoundaries(ctx.db, {
    tenant_id,
    workflow_id,
    definition: definition([
      {
        id: "send",
        kind: "request",
        connector_id: CONNECTOR,
        method: "POST",
        path: "/v1/content",
        // biome-ignore lint/suspicious/noTemplateCurlyInString: authored placeholder
        body: "${item.markdown}",
      },
    ]),
  });
  expect(unproposable).toEqual([]);
  expect(proposals[0]?.boundary?.max_body_bytes).toBeGreaterThan(51_200);
});

// biome-ignore lint/suspicious/noTemplateCurlyInString: authored placeholder
const ROUTE_TEMPLATE = "${item.path}";
const fetchRoute = {
  id: "fetch_route",
  kind: "request",
  connector_id: CONNECTOR,
  method: "GET",
  path: ROUTE_TEMPLATE,
};

test("a step that varies its whole address is described, not reported as indescribable", async () => {
  await ctx.db.delete(executions).where(eq(executions.workflow_id, workflow_id));
  const [execution] = await ctx.db
    .insert(executions)
    .values({
      tenant_id,
      workflow_id,
      status: "succeeded",
      request_source: "api",
      execution_mode: "prod",
    })
    .returning();
  const routes = ["/de/", "/de/datenstand/", "/robots.txt", "/"];
  await ctx.db.insert(executionSteps).values(
    routes.map((route, index) => ({
      tenant_id,
      execution_id: execution?.id as string,
      step_key: `fetch_route[${index}]`,
      step_index: index,
      kind: "request" as const,
      status: "succeeded" as const,
      request_meta: { driver: "http", url: `https://www.example.test${route}` },
    })),
  );
  const { proposals, unproposable } = await proposeBoundaries(ctx.db, {
    tenant_id,
    workflow_id,
    definition: definition([fetchRoute]),
  });
  expect(unproposable).toEqual([]);
  expect(proposals[0]?.boundary?.variables).toEqual({ "item.path": { class: "path" } });
  expect(proposals[0]?.evidence.observations).toBe(4);
  expect(proposals[0]?.boundary?.max_calls).toBe(8);
});

test("a deeper address than the template does not get a rule fitted to its last segment", async () => {
  await record([
    { step: "edit_page", url: "https://api.example.test/blog/a/edit" },
    { step: "edit_page", url: "https://api.example.test/blog/b/edit" },
  ]);
  const { proposals, unproposable } = await proposeBoundaries(ctx.db, {
    tenant_id,
    workflow_id,
    definition: definition([
      {
        id: "edit_page",
        kind: "request",
        connector_id: CONNECTOR,
        method: "GET",
        // biome-ignore lint/suspicious/noTemplateCurlyInString: authored placeholder
        path: "/${input.slug}/edit",
      },
    ]),
  });
  expect(proposals).toEqual([]);
  expect(unproposable).toEqual([{ step_id: "edit_page", reason: "path_not_comparable" }]);
});

test("a whole-path rule is not proposed under a connector whose base carries a path", async () => {
  const [deep] = await ctx.db
    .insert(connectors)
    .values({
      tenant_id,
      slug: "deep-base",
      display_name: "Deep base",
      driver: "http",
      auth_type: "none",
      environment: "prod",
      base_url: "https://api.example.test/v2",
    })
    .returning();
  await ctx.db.delete(executions).where(eq(executions.workflow_id, workflow_id));
  const [execution] = await ctx.db
    .insert(executions)
    .values({
      tenant_id,
      workflow_id,
      status: "succeeded",
      request_source: "api",
      execution_mode: "prod",
    })
    .returning();
  await ctx.db.insert(executionSteps).values({
    tenant_id,
    execution_id: execution?.id as string,
    step_key: "fetch_route",
    step_index: 0,
    kind: "request" as const,
    status: "succeeded" as const,
    request_meta: { driver: "http", url: "https://api.example.test/v2/de/" },
  });
  const { proposals, unproposable } = await proposeBoundaries(ctx.db, {
    tenant_id,
    workflow_id,
    definition: definition([{ ...fetchRoute, connector_id: deep?.id }]),
  });
  expect(proposals).toEqual([]);
  expect(unproposable).toEqual([{ step_id: "fetch_route", reason: "not_supported" }]);
});
