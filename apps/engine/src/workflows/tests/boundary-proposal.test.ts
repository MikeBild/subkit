// A proposal has to be justified by what the step really did, or not made.
//
// The approval dialog's answer to an unbounded step was "investigate the cause
// in the chat" — a technical question put to the one person who cannot answer
// it, in front of three production workflows that stayed blocked for weeks.
// SubKit can read what each step has been doing and say it itself. What it must
// never do is fill the gap with something that merely looks right: a rule
// nobody can point at is how an authoring model ends up rewriting code that was
// correct.

import { afterAll, beforeAll, expect, test } from "bun:test";
import { eq } from "drizzle-orm";
import { executionSteps, executions, tenants, workflows } from "../../db/schema/index.ts";
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

async function record(rows: Array<{ step: string; url?: string; key?: string }>) {
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
      status: "succeeded" as const,
      request_meta: {
        driver: row.key ? "s3" : "http",
        ...(row.url ? { url: row.url } : {}),
        ...(row.key ? { key: row.key } : {}),
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
  // The evidence travels with the proposal: a reviewer must be able to see
  // what it was read from, not just what it concluded.
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
  // `alpha.beta` is a file name by form; the narrowest covering class is taken
  // over a list, because it stays right when a new value of the same form
  // appears.
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
    { step: "store", key: "v1/facts/year=2026/month=09/a.json" },
    { step: "store", key: "v1/facts/year=2026/month=08/b.json" },
  ]);
  const { proposals } = await proposeBoundaries(ctx.db, {
    tenant_id,
    workflow_id,
    definition: definition([
      { id: "store", kind: "request", connector_id: CONNECTOR, method: "PUT", s3: { key: "x" } },
    ]),
  });
  // Cut back to a folder: `v1/facts/year=2026/month=0` would admit every
  // sibling sharing those letters, which is not a folder anyone declared.
  expect(proposals[0]?.s3_scope?.key_prefix).toBe("v1/facts/year=2026/");
  expect(proposals[0]?.s3_scope?.max_bytes).toBeGreaterThan(0);
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
  // A human approved that text. Replacing it from history would move a reviewed
  // rule without anyone deciding to.
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
  // The dead end this closes: a paginating step is refused a boundary while it
  // has no page cap, and the cap is not something the author can know better
  // than the runtime — which has counted the pages of every run.
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
  // Twice the largest run that really happened, so a slightly bigger week is
  // not a refused run — and nothing at all if no run ever counted pages.
  expect(proposals[0]?.max_pages).toBe(14);

  const capped = await proposeBoundaries(ctx.db, {
    tenant_id,
    workflow_id,
    definition: definition([{ ...paging, pagination: { ...paging.pagination, max_pages: 4 } }]),
  });
  // A cap the author already chose is theirs; this never moves it.
  expect(capped.proposals[0]?.max_pages).toBeUndefined();
});

test("a held request is evidence too — target and size both", async () => {
  // A preview holds every write, so a step that has only ever been previewed
  // records no dispatch. It does record what it resolved to, content and all.
  // Without reading that, the steps a preparation run just exercised are
  // exactly the ones SubKit would still call unknowable.
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
  // Read from the content it would have sent, with headroom — never invented.
  expect(proposals[0]?.boundary?.max_body_bytes).toBeGreaterThan(0);
});

test("the preparation run the dialog itself asks for counts as evidence", async () => {
  // Two paths record the same fact differently: a dry-run preview leaves
  // `held_request` in the result envelope, the preparation run leaves
  // `prepared_request_review` in the request metadata. Reading only the first
  // meant the run a reviewer had just been told to perform produced nothing
  // this derivation could use — the dead end looked like the workflow's fault.
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
  // Loop iterations record `read_page[0]`, `read_page[1]`, … Matching the bare
  // id found nothing for exactly the steps that run most often: on production a
  // workflow had twelve such rows and the derivation reported "never ran".
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
});
