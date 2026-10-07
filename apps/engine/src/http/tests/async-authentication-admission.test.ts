import { afterAll, beforeAll, expect, test } from "bun:test";
import { and, eq } from "drizzle-orm";
import { AuthProviderRegistry } from "../../auth/registry.ts";
import { executions } from "../../db/schema/index.ts";
import { createExecution } from "../../execution/state.ts";
import { createWorkflowRow } from "../../execution/tests/setup.ts";
import { createHttpTestServer, type HttpTestServer } from "./setup.ts";

let ctx: HttpTestServer;
let workflowId: string;
let originalId: string;

beforeAll(async () => {
  const registry = new AuthProviderRegistry().register({
    name: "portal_token",
    capabilities: {
      human: true,
      machine: false,
      interactive: false,
      refresh: false,
      revoke: false,
    },
    async resolve(request) {
      if (request.headers.get("authorization") !== "Bearer unsupported") return null;
      return {
        provider: "portal_token",
        kind: "user",
        id: ctx.userId,
        tenant_id: ctx.tenantId,
        roles: ["admin"],
      };
    },
  });
  ctx = await createHttpTestServer("async-authentication-admission", { appOptions: { registry } });
  const workflow = await createWorkflowRow(ctx, {
    name: "Async authentication admission",
    slug: "async-authentication-admission",
    steps: [{ id: "echo", kind: "transform", expression: "$input" }],
  });
  workflowId = workflow.workflow_id;
  originalId = await createExecution(ctx.db, {
    tenant_id: ctx.tenantId,
    workflow_id: workflowId,
    workflow_version_id: workflow.version_id,
    source_kind: "saved",
    source_ref: null,
    request_source: "api",
    input: null,
  });
});

afterAll(async () => {
  if (ctx) await ctx.cleanup();
});

for (const operation of ["run", "rerun"]) {
  test(`unsupported authenticated async ${operation} is refused before creating an execution`, async () => {
    const response = await fetch(
      `${ctx.baseUrl}/v1/executions${operation === "rerun" ? `/${originalId}/rerun` : ""}`,
      {
        method: "POST",
        headers: { Authorization: "Bearer unsupported", "content-type": "application/json" },
        body: JSON.stringify(
          operation === "rerun"
            ? { async: true }
            : { source: "saved", workflow_id: workflowId, async: true },
        ),
      },
    );
    expect(response.status).toBe(400);
    expect(await response.json()).toMatchObject({ code: "execution_authentication_unsupported" });
    const rows = await ctx.db
      .select({ id: executions.id })
      .from(executions)
      .where(and(eq(executions.tenant_id, ctx.tenantId), eq(executions.workflow_id, workflowId)));
    expect(rows.map((row) => row.id)).toEqual([originalId]);
  });
}
