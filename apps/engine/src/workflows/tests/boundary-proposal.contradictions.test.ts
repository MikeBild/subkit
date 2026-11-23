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
import {
  boundaryProposalFixtures,
  CONNECTOR,
  definition,
  STORAGE,
  viewer,
} from "./boundary-proposal-fixtures.ts";

let ctx: TestDb;

let tenant_id = "";

let workflow_id = "";

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
  await connect();
});

afterAll(async () => {
  await ctx.cleanup();
});

const { connect, record } = boundaryProposalFixtures({
  get ctx() {
    return ctx;
  },
  get workflow_id() {
    return workflow_id;
  },
  get tenant_id() {
    return tenant_id;
  },
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
    environment: "prod",
    viewer: viewer(tenant_id),
    definition: definition(listing("/startups?page=${item.n}&limit=10")),
  });
  expect(unproposable).toEqual([]);
  expect(proposals[0]?.path_rewrite).toEqual({
    path: "/startups",
    query: { page: "${item.n}", limit: "10" },
  });
  expect(proposals[0]?.boundary?.variables).toEqual({ "item.n": { class: "integer" } });

  const unproven = await proposeBoundaries(ctx.db, {
    tenant_id,
    workflow_id,
    environment: "prod",
    viewer: viewer(tenant_id),
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
    environment: "prod",
    viewer: viewer(tenant_id),
    definition: definition([
      {
        id: "store",
        kind: "request",
        protocol: "s3",
        connector_id: STORAGE,
        method: "PUT",
        s3: { key: "x" },
      },
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
      protocol: "s3",
      connector_id: STORAGE,
      method: "PUT",
      s3: { key: "x", scope: { key_prefix: "v1/radar/", max_bytes } },
    },
  ];
  const tooSmall = await proposeBoundaries(ctx.db, {
    tenant_id,
    workflow_id,
    environment: "prod",
    viewer: viewer(tenant_id),
    definition: definition(scoped(65_536)),
  });
  expect(tooSmall.proposals[0]?.s3_scope?.max_bytes).toBeGreaterThan(337_858);
  expect(tooSmall.proposals[0]?.s3_scope?.key_prefix).toBe("v1/radar/");
  expect(tooSmall.proposals[0]?.widens).toEqual([
    { field: "max_bytes", from: 65_536, to: tooSmall.proposals[0]?.s3_scope?.max_bytes ?? 0 },
  ]);
  expect(tooSmall.proposals[0]?.evidence.kind).toBe("sent");

  const roomy = await proposeBoundaries(ctx.db, {
    tenant_id,
    workflow_id,
    environment: "prod",
    viewer: viewer(tenant_id),
    definition: definition(scoped(1_000_000)),
  });
  expect(roomy.proposals).toEqual([]);
});

test("a request that was refused is not evidence and widens nothing", async () => {
  const scoped = [
    {
      id: "store",
      kind: "request",
      protocol: "s3",
      connector_id: STORAGE,
      method: "PUT",
      s3: { key: "x", scope: { key_prefix: "v1/radar/", max_bytes: 65_536 } },
    },
  ];
  await record([
    { step: "store", key: "v1/elsewhere/a.json", bytes: 337_858, refused: true },
    { step: "read_page", url: "https://api.example.test/v1/pages/never-sent", refused: true },
  ]);
  const refusedOnly = await proposeBoundaries(ctx.db, {
    tenant_id,
    workflow_id,
    environment: "prod",
    viewer: viewer(tenant_id),
    definition: definition([
      ...scoped,
      {
        id: "read_page",
        kind: "request",
        connector_id: CONNECTOR,
        method: "GET",
        path: "/v1/pages/${input.page_id}",
      },
    ]),
  });
  expect(refusedOnly).toMatchObject({
    proposals: [],
    unproposable: [{ step_id: "read_page", reason: "no_history" }],
  });

  await record([
    { step: "store", key: "v1/radar/a.json", bytes: 900 },
    { step: "store", key: "v1/elsewhere/a.json", bytes: 337_858, refused: true },
  ]);
  const mixed = await proposeBoundaries(ctx.db, {
    tenant_id,
    workflow_id,
    environment: "prod",
    viewer: viewer(tenant_id),
    definition: definition(scoped),
  });
  expect(mixed).toMatchObject({ proposals: [], unproposable: [] });
});

test("a listing records the folder it read, and that is evidence", async () => {
  await record([
    { step: "list_raw", prefix: "opportunity-radar/raw/trustmrr/" },
    { step: "list_raw", prefix: "opportunity-radar/raw/trustmrr/" },
  ]);
  const { proposals, unproposable } = await proposeBoundaries(ctx.db, {
    tenant_id,
    workflow_id,
    environment: "prod",
    viewer: viewer(tenant_id),
    definition: definition([
      {
        id: "list_raw",
        kind: "request",
        protocol: "s3",
        connector_id: STORAGE,
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
    environment: "prod",
    viewer: viewer(tenant_id),
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
    environment: "prod",
    viewer: viewer(tenant_id),
    definition: definition([
      {
        id: "send",
        kind: "request",
        connector_id: CONNECTOR,
        method: "POST",
        path: "/v1/content",
        body: "${item.markdown}",
      },
    ]),
  });
  expect(unproposable).toEqual([]);
  expect(proposals[0]?.boundary?.max_body_bytes).toBeGreaterThan(51_200);
});

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
    environment: "prod",
    viewer: viewer(tenant_id),
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
    environment: "prod",
    viewer: viewer(tenant_id),
    definition: definition([
      {
        id: "edit_page",
        kind: "request",
        connector_id: CONNECTOR,
        method: "GET",
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
    environment: "prod",
    viewer: viewer(tenant_id),
    definition: definition([{ ...fetchRoute, connector_id: deep?.id }]),
  });
  expect(proposals).toEqual([]);
  expect(unproposable).toEqual([{ step_id: "fetch_route", reason: "not_supported" }]);
});
