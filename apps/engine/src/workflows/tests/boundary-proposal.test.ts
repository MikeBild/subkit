import { afterAll, beforeAll, expect, test } from "bun:test";
import { eq } from "drizzle-orm";
import { executionSteps, executions, tenants, workflows } from "../../db/schema/index.ts";
import { createTestDb, type TestDb } from "../../db/tests/setup.ts";
import { proposeBoundaries } from "../boundary-proposal.ts";
import { boundaryProposalFixtures, CONNECTOR, definition } from "./boundary-proposal-fixtures.ts";

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
});

afterAll(async () => {
  await ctx.cleanup();
});

const { record } = boundaryProposalFixtures({
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
