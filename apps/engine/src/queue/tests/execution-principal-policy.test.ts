import { afterAll, beforeAll, expect, test } from "bun:test";
import { and, eq, sql } from "drizzle-orm";
import type { PgBoss } from "pg-boss";
import type { ResolvedPrincipal } from "../../auth/types.ts";
import {
  connectors,
  executionSteps,
  executions,
  requestHooks,
  roles,
  sessions,
  users,
} from "../../db/schema/index.ts";
import { authorizationContextFromPrincipal } from "../../execution/authorization-context.ts";
import { callerFromPrincipal } from "../../execution/caller-context.ts";
import { runExecution } from "../../execution/engine.ts";
import { createExecution } from "../../execution/state.ts";
import {
  createEngineCtx,
  createMockServer,
  createWorkflowRow,
  type EngineTestCtx,
  jsonResponse,
  type MockServer,
} from "../../execution/tests/setup.ts";
import { waitFor } from "../../test-helpers/determinism/wait.ts";
import { createBoss, disposeBoss } from "../boss.ts";
import { registerExecutionRunHandler } from "../handlers/execution-run.ts";
import { EXECUTION_RUN_QUEUE, type ExecutionRunJob } from "../queues.ts";

let ctx: EngineTestCtx;
let boss: PgBoss;
let server: MockServer;
let principal: ResolvedPrincipal;
let workflowId: string;
let versionId: string;
let adminRoleId: string;
let upstreamRequests = 0;

beforeAll(async () => {
  ctx = await createEngineCtx("execution-principal-policy");
  server = await createMockServer((_request, response) => {
    upstreamRequests += 1;
    jsonResponse(response, 200, { ok: true });
  });
  const [connector] = await ctx.testDb.db
    .insert(connectors)
    .values({
      tenant_id: ctx.tenantId,
      slug: "hook-policy-target",
      display_name: "Hook policy target",
      driver: "http",
      auth_type: "none",
      environment: "dev",
      base_url: server.baseUrl,
      config: {},
    })
    .returning();
  if (!connector) throw new Error("connector fixture missing");
  const [role] = await ctx.testDb.db
    .insert(roles)
    .values({ tenant_id: ctx.tenantId, name: "admin" })
    .returning();
  if (!role) throw new Error("role fixture missing");
  adminRoleId = role.id;
  const [user] = await ctx.testDb.db
    .insert(users)
    .values({
      tenant_id: ctx.tenantId,
      email: "queued-policy@example.test",
      role_id: role.id,
      status: "active",
    })
    .returning();
  if (!user) throw new Error("user fixture missing");
  const [session] = await ctx.testDb.db
    .insert(sessions)
    .values({
      tenant_id: ctx.tenantId,
      user_id: user.id,
      expires_at: sql`clock_timestamp() + interval '1 hour'`,
    })
    .returning();
  if (!session) throw new Error("session fixture missing");
  principal = {
    id: user.id,
    kind: "user",
    provider: "test",
    tenant_id: ctx.tenantId,
    roles: ["admin"],
    auth_source: { kind: "browser_session", session_id: session.id },
  };
  await ctx.testDb.db.insert(requestHooks).values({
    tenant_id: ctx.tenantId,
    role: "admin",
    source: "return { allow: false, reason: 'request_policy_denied' };",
    version: 1,
    enabled: true,
  });
  const workflow = await createWorkflowRow(ctx, {
    name: "Queued authenticated request policy",
    slug: "queued-authenticated-request-policy",
    steps: [
      {
        id: "read",
        kind: "request",
        connector_id: connector.id,
        method: "GET",
        path: "/resource",
        max_retries: 0,
      },
    ],
  });
  workflowId = workflow.workflow_id;
  versionId = workflow.version_id;
  boss = await createBoss({ connectionString: ctx.testDb.url });
  await registerExecutionRunHandler({ boss, db: ctx.testDb.db });
}, 30_000);

afterAll(async () => {
  if (boss) await disposeBoss(boss);
  if (server) await server.close();
  if (ctx) await ctx.cleanup();
}, 30_000);

test("the authenticated request policy denies a synchronous run before upstream dispatch", async () => {
  const result = await runExecution({
    db: ctx.testDb.db,
    tenant_id: ctx.tenantId,
    source: { kind: "saved", workflow_id: workflowId },
    input: null,
    options: { hold_writes: true, principal },
  });
  expect(result.status).toBe("failed");
  expect(result.steps[0]?.error).toMatchObject({ code: "policy.denied" });
  expect(upstreamRequests).toBe(0);
});

async function queuedRun() {
  const executionId = await createExecution(ctx.testDb.db, {
    tenant_id: ctx.tenantId,
    workflow_id: workflowId,
    workflow_version_id: versionId,
    source_kind: "saved",
    source_ref: null,
    request_source: "api",
    hold_writes: true,
    caller_context: callerFromPrincipal(principal, ctx.tenantId),
    authorization_context: authorizationContextFromPrincipal(principal),
    input: null,
  });
  await boss.send(
    EXECUTION_RUN_QUEUE,
    {
      tenant_id: ctx.tenantId,
      workflow_id: workflowId,
      execution_id: executionId,
      input: null,
      request_source: "api",
    } satisfies ExecutionRunJob,
    { id: executionId },
  );
  const execution = await waitFor(
    async () => {
      const [row] = await ctx.testDb.db
        .select()
        .from(executions)
        .where(and(eq(executions.tenant_id, ctx.tenantId), eq(executions.id, executionId)));
      return row && !["queued", "running"].includes(row.status) ? row : null;
    },
    { tries: 150, sleepMs: 200, label: "queued request policy" },
  );
  const [step] = await ctx.testDb.db
    .select()
    .from(executionSteps)
    .where(
      and(eq(executionSteps.tenant_id, ctx.tenantId), eq(executionSteps.execution_id, executionId)),
    );
  return { execution, step };
}

test("the same authenticated request policy denies a queued run before upstream dispatch", async () => {
  const { execution, step } = await queuedRun();
  expect(execution.status).toBe("failed");
  expect(step?.error).toMatchObject({ code: "policy.denied" });
  expect(upstreamRequests).toBe(0);
}, 40_000);

test("a revoked source session refuses the queued run before any step is created", async () => {
  const source = principal.auth_source;
  if (source?.kind !== "browser_session") throw new Error("session source fixture missing");
  await ctx.testDb.db
    .update(sessions)
    .set({ revoked_at: sql`clock_timestamp()` })
    .where(and(eq(sessions.tenant_id, ctx.tenantId), eq(sessions.id, source.session_id)));
  try {
    const { execution, step } = await queuedRun();
    expect(execution.status).toBe("failed");
    expect(execution.failure).toMatchObject({
      error_code: "execution_authentication_unavailable",
    });
    expect(step).toBeUndefined();
    expect(upstreamRequests).toBe(0);
  } finally {
    await ctx.testDb.db
      .update(sessions)
      .set({ revoked_at: null })
      .where(and(eq(sessions.tenant_id, ctx.tenantId), eq(sessions.id, source.session_id)));
  }
}, 40_000);

test("removing the current workflow permission refuses the queue despite admitted admin roles", async () => {
  const [role] = await ctx.testDb.db
    .insert(roles)
    .values({ tenant_id: ctx.tenantId, name: "without-workflow-permission" })
    .returning();
  if (!role) throw new Error("replacement role fixture missing");
  await ctx.testDb.db
    .update(users)
    .set({ role_id: role.id })
    .where(and(eq(users.tenant_id, ctx.tenantId), eq(users.id, principal.id)));
  try {
    const { execution, step } = await queuedRun();
    expect(execution.status).toBe("failed");
    expect(execution.failure).toMatchObject({
      error_code: "execution_authentication_unavailable",
    });
    expect(step).toBeUndefined();
    expect(upstreamRequests).toBe(0);
  } finally {
    await ctx.testDb.db
      .update(users)
      .set({ role_id: adminRoleId })
      .where(and(eq(users.tenant_id, ctx.tenantId), eq(users.id, principal.id)));
  }
}, 40_000);
