import { afterAll, beforeAll, expect, test } from "bun:test";
import { and, eq } from "drizzle-orm";
import { createConnector, updateConnector } from "../../connectors/service.ts";
import { upsertCredential } from "../../credentials/service.ts";
import { executionSteps } from "../../db/schema/index.ts";
import { TEST_DB_HOOK_TIMEOUT } from "../../db/tests/setup.ts";
import { createWorkflow } from "../../workflows/service.ts";
import { validateTenantWorkflowDef } from "../../workflows/tenant-validator.ts";
import { runExecution } from "../engine.ts";
import { createExecution } from "../state.ts";
import {
  createEngineCtx,
  createMockServer,
  type EngineTestCtx,
  jsonResponse,
  type MockServer,
} from "./setup.ts";

let ctx: EngineTestCtx;
let upstream: MockServer;
let requests = 0;
let sequence = 0;
beforeAll(async () => {
  ctx = await createEngineCtx("header-auth-change");
  upstream = await createMockServer((_request, response) => {
    requests++;
    jsonResponse(response, 200, { ok: true });
  });
}, TEST_DB_HOOK_TIMEOUT);
afterAll(async () => {
  if (upstream) await upstream.close();
  if (ctx) await ctx.cleanup();
}, TEST_DB_HOOK_TIMEOUT);

async function connector(environment: "dev" | "prod", slug: string) {
  return createConnector(
    {
      tenant_id: ctx.tenantId,
      actor_id: null,
      input: {
        name: slug,
        slug,
        driver: "http",
        environment,
        base_url: upstream.baseUrl,
        auth_type: "none",
        config: {},
      },
    },
    ctx.testDb.db,
  );
}
async function protect(id: string, environment: "dev" | "prod") {
  await updateConnector(ctx.tenantId, id, { auth_type: "bearer" }, null, ctx.testDb.db);
  await upsertCredential(
    {
      tenant_id: ctx.tenantId,
      connector_id: id,
      environment,
      mode: "bearer",
      value: { mode: "bearer", token: "synthetic-protected-bearer" },
      actor_id: null,
    },
    ctx.testDb.db,
  );
}
function definition(id: string, slug: string) {
  return {
    name: slug,
    slug,
    steps: [
      {
        id: "read",
        kind: "request",
        connector_id: id,
        path: "/read",
        method: "GET",
        max_retries: 0,
        headers: { aUtHoRiZaTiOn: "synthetic-forwarded-token" },
      },
    ],
  };
}

for (const resume of [false, true]) {
  test(`saved workflow refuses changed authentication before upstream dispatch${resume ? " on persisted queued resume" : ""}`, async () => {
    const slug = `auth-change-${++sequence}`;
    const conn = await connector("dev", slug);
    const created = await createWorkflow(
      { tenant_id: ctx.tenantId, actor_id: null, def: definition(conn.id, slug) },
      ctx.testDb.db,
    );
    if (!created.workflow?.current_version_id) throw new Error("saved workflow fixture missing");
    const workflow = created.workflow;
    const queued = resume
      ? await createExecution(ctx.testDb.db, {
          tenant_id: ctx.tenantId,
          workflow_id: workflow.id,
          workflow_version_id: workflow.current_version_id,
          source_kind: "saved",
          source_ref: null,
          request_source: "api",
          hold_writes: true,
          input: null,
        })
      : undefined;
    await protect(conn.id, "dev");
    const before = requests;
    const result = await runExecution({
      db: ctx.testDb.db,
      tenant_id: ctx.tenantId,
      source: { kind: "saved", workflow_id: workflow.id },
      input: null,
      options: { hold_writes: true, ...(queued ? { existing_execution_id: queued } : {}) },
    });
    expect(result.status).toBe("failed");
    expect(requests).toBe(before);
    const steps = await ctx.testDb.db
      .select()
      .from(executionSteps)
      .where(
        and(
          eq(executionSteps.tenant_id, ctx.tenantId),
          eq(executionSteps.execution_id, result.execution_id),
        ),
      );
    expect(steps).toHaveLength(1);
    expect(steps[0]?.error).toMatchObject({
      message: "request headers conflict with connector authentication",
    });
  });
}

test("validation combines same-tenant dev and prod authentication without granting a dev-only forwarding exception", async () => {
  const slug = `environment-auth-${++sequence}`;
  const dev = await connector("dev", slug);
  await connector("prod", slug);
  const def = definition(dev.id, `${slug}-workflow`);
  expect((await validateTenantWorkflowDef(def, ctx.tenantId, ctx.testDb.db)).ok).toBe(true);
  const prod = await import("../../connectors/service.ts").then(({ getConnectorForEnvironment }) =>
    getConnectorForEnvironment(ctx.tenantId, dev.id, "prod", ctx.testDb.db),
  );
  if (!prod || prod.id === dev.id) throw new Error("prod connector fixture missing");
  await protect(prod.id, "prod");
  expect((await validateTenantWorkflowDef(def, ctx.tenantId, ctx.testDb.db)).ok).toBe(false);
  expect(requests).toBe(0);
});
