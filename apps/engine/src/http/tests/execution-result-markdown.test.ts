import { afterAll, beforeAll, expect, test } from "bun:test";
import { executions, workflows, workflowVersions } from "../../db/schema/index.ts";
import { createHttpTestServer, type HttpTestServer } from "./setup.ts";

let srv: HttpTestServer;
const ids: Record<"with" | "without", string> = { with: "", without: "" };

beforeAll(async () => {
  srv = await createHttpTestServer("execution-result-markdown");
  const [wf] = await srv.db
    .insert(workflows)
    .values({ tenant_id: srv.tenantId, slug: "wf-md", name: "Md", lifecycle: "active" })
    .returning();
  const [version] = await srv.db
    .insert(workflowVersions)
    .values({ tenant_id: srv.tenantId, workflow_id: wf!.id, version: 1, dag: { steps: [] } })
    .returning();
  const base = {
    tenant_id: srv.tenantId,
    workflow_id: wf!.id,
    workflow_version_id: version!.id,
    status: "succeeded" as const,
    request_source: "api",
    execution_mode: "prod" as const,
    started_at: new Date("2026-03-02T08:00:00.000Z"),
    finished_at: new Date("2026-03-02T08:00:01.000Z"),
  };
  const [withMd] = await srv.db
    .insert(executions)
    .values({ ...base, result_markdown: "# Report", result_markdown_truncated: true })
    .returning({ id: executions.id });
  const [withoutMd] = await srv.db.insert(executions).values(base).returning({ id: executions.id });
  ids.with = withMd!.id;
  ids.without = withoutMd!.id;
});

afterAll(async () => {
  await srv.cleanup();
});

async function detail(id: string) {
  const res = await fetch(`${srv.baseUrl}/v1/executions/${id}`, {
    headers: { authorization: `Bearer ${srv.apiKey}` },
  });
  expect(res.status).toBe(200);
  return (await res.json()) as {
    result_markdown: string | null;
    result_markdown_truncated: boolean;
  };
}

test("run detail carries the stored Markdown result and whether it was cut", async () => {
  expect(await detail(ids.with)).toMatchObject({
    result_markdown: "# Report",
    result_markdown_truncated: true,
  });
});

test("a run without a Markdown result says so with null", async () => {
  expect(await detail(ids.without)).toMatchObject({
    result_markdown: null,
    result_markdown_truncated: false,
  });
});
