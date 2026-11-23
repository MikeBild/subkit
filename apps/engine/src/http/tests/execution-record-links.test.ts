import { afterAll, beforeAll, expect, test } from "bun:test";
import {
  connectors,
  executionSteps,
  executions,
  workflows,
  workflowVersions,
} from "../../db/schema/index.ts";
import { createHttpTestServer, type HttpTestServer } from "./setup.ts";

let srv: HttpTestServer;
const ids = { plain: "", held: "", sensitive: "", foreign: "" };
const STARTED = new Date("2026-03-02T08:00:00.000Z");

const issue = { number: 42, html_url: "https://github.com/acme/app/issues/42" };

function step(execution_id: string, connector_id: string, output: unknown, extra = {}) {
  return {
    tenant_id: srv.tenantId,
    execution_id,
    step_key: "create_issue",
    step_index: 0,
    kind: "request",
    status: "succeeded",
    output_preview: output,
    request_meta: {
      driver: "http",
      method: "POST",
      url: "https://api.github.com/repos/acme/app/issues",
      status: 201,
      connector: { connector_id, connector_slug: "gh", base_url: "https://api.github.com" },
    },
    started_at: STARTED,
    finished_at: STARTED,
    ...extra,
  };
}

beforeAll(async () => {
  srv = await createHttpTestServer("execution-record-links");
  const [wf] = await srv.db
    .insert(workflows)
    .values({ tenant_id: srv.tenantId, slug: "wf-links", name: "Links", lifecycle: "active" })
    .returning();
  const [version] = await srv.db
    .insert(workflowVersions)
    .values({ tenant_id: srv.tenantId, workflow_id: wf!.id, version: 1, dag: { steps: [] } })
    .returning();
  const [github] = await srv.db
    .insert(connectors)
    .values({
      tenant_id: srv.tenantId,
      slug: "gh",
      display_name: "GitHub",
      driver: "http",
      base_url: "https://api.github.com",
      template_slug: "github",
    })
    .returning();
  const [custom] = await srv.db
    .insert(connectors)
    .values({
      tenant_id: srv.tenantId,
      slug: "custom",
      display_name: "Custom",
      driver: "http",
      base_url: "https://api.github.com",
    })
    .returning();
  const base = {
    tenant_id: srv.tenantId,
    workflow_id: wf!.id,
    workflow_version_id: version!.id,
    status: "succeeded" as const,
    request_source: "api",
    execution_mode: "prod" as const,
    started_at: STARTED,
    finished_at: new Date("2026-03-02T08:00:01.000Z"),
  };
  const insertRun = async (values: Record<string, unknown> = {}) => {
    const [row] = await srv.db
      .insert(executions)
      .values({ ...base, ...values })
      .returning({ id: executions.id });
    return row!.id;
  };
  ids.plain = await insertRun();
  ids.held = await insertRun();
  ids.foreign = await insertRun();
  ids.sensitive = await insertRun({
    input: { $sensitive: true, ciphertext: "c2VhbGVk", iv: "aXY=", auth_tag: "dGFn" },
  });
  await srv.db
    .insert(executionSteps)
    .values([
      step(ids.plain, github!.id, issue),
      step(ids.held, github!.id, issue, { held: true }),
      step(ids.foreign, custom!.id, issue),
      step(ids.sensitive, github!.id, issue),
    ]);
});

afterAll(async () => {
  await srv.cleanup();
});

async function detail(id: string) {
  const res = await fetch(`${srv.baseUrl}/v1/executions/${id}`, {
    headers: { authorization: `Bearer ${srv.apiKey}` },
  });
  expect(res.status).toBe(200);
  return (await res.json()) as { record_links: unknown[] };
}

test("run detail links the record a request step created in the external system", async () => {
  expect((await detail(ids.plain)).record_links).toEqual([
    {
      label: "acme/app#42",
      url: "https://github.com/acme/app/issues/42",
      connector: "github",
      connector_name: "GitHub",
      step_key: "create_issue",
    },
  ]);
});

test("held writes, sensitive runs and connectors without a built-in template carry no links", async () => {
  expect((await detail(ids.held)).record_links).toEqual([]);
  expect((await detail(ids.sensitive)).record_links).toEqual([]);
  expect((await detail(ids.foreign)).record_links).toEqual([]);
});
