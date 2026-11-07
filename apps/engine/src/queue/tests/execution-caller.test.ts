import { afterAll, beforeAll, expect, test } from "bun:test";
import { and, eq, sql } from "drizzle-orm";
import type { PgBoss } from "pg-boss";
import type { ResolvedPrincipal } from "../../auth/types.ts";
import { executionSteps, executions, roles, sessions, users } from "../../db/schema/index.ts";
import { authorizationContextFromPrincipal } from "../../execution/authorization-context.ts";
import { createExecution } from "../../execution/state.ts";
import {
  createEngineCtx,
  createWorkflowRow,
  type EngineTestCtx,
} from "../../execution/tests/setup.ts";
import { builtinRoleId } from "../../rbac/roles.ts";
import { waitFor } from "../../test-helpers/determinism/wait.ts";
import { createBoss, disposeBoss } from "../boss.ts";
import { registerExecutionRunHandler } from "../handlers/execution-run.ts";
import { EXECUTION_RUN_QUEUE, type ExecutionRunJob } from "../queues.ts";

let ctx: EngineTestCtx;
let boss: PgBoss;

beforeAll(async () => {
  ctx = await createEngineCtx("execution-caller");
  boss = await createBoss({ connectionString: ctx.testDb.url });
  await registerExecutionRunHandler({ boss, db: ctx.testDb.db });
}, 30_000);

afterAll(async () => {
  if (boss) await disposeBoss(boss);
  if (ctx) await ctx.cleanup();
}, 30_000);

test("queue restores the persisted caller instead of a caller supplied in the job input", async () => {
  const role = { id: await builtinRoleId(ctx.testDb.db, "admin") };
  const [user] = await ctx.testDb.db
    .insert(users)
    .values({
      tenant_id: ctx.tenantId,
      email: "queued-caller@example.test",
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
      product_id: "harmoniqs",
      expires_at: sql`clock_timestamp() + interval '1 hour'`,
    })
    .returning();
  if (!session) throw new Error("session fixture missing");
  const principal: ResolvedPrincipal = {
    tenant_id: ctx.tenantId,
    id: user.id,
    kind: "user",
    provider: "test",
    product_id: "harmoniqs",
    roles: ["admin"],
    auth_source: { kind: "browser_session", session_id: session.id },
  };
  const { workflow_id, version_id } = await createWorkflowRow(ctx, {
    name: "Queued product caller",
    slug: "queued-product-caller",
    product_id: "harmoniqs",
    steps: [
      {
        id: "observe",
        kind: "transform",
        language: "javascript",
        expression: "return input.scope.$caller ?? null;",
      },
    ],
  });
  const caller = {
    tenantId: ctx.tenantId,
    principalId: user.id,
    principalKind: "user" as const,
    provider: "test",
    productId: "harmoniqs",
  };
  const input = {
    owner_id: "another-owner",
    $caller: {
      tenantId: ctx.tenantId,
      principalId: "another-owner",
      productId: "another-product",
    },
  };
  const parameters = {
    tenant_id: ctx.tenantId,
    workflow_id,
    workflow_version_id: version_id,
    source_kind: "saved" as const,
    source_ref: null,
    request_source: "api" as const,
    hold_writes: true,
    caller_context: caller,
    authorization_context: authorizationContextFromPrincipal(principal),
    input,
  };
  const execution_id = await createExecution(ctx.testDb.db, parameters);
  await boss.send(
    EXECUTION_RUN_QUEUE,
    {
      tenant_id: ctx.tenantId,
      workflow_id,
      execution_id,
      input,
      request_source: "api",
    } satisfies ExecutionRunJob,
    { id: execution_id },
  );
  const row = await waitFor(
    async () => {
      const [current] = await ctx.testDb.db
        .select()
        .from(executions)
        .where(and(eq(executions.tenant_id, ctx.tenantId), eq(executions.id, execution_id)));
      return current && !["queued", "running"].includes(current.status) ? current : null;
    },
    { tries: 150, sleepMs: 200, label: "queued caller restoration" },
  );
  expect(row.status).toBe("succeeded");
  const [step] = await ctx.testDb.db
    .select()
    .from(executionSteps)
    .where(
      and(
        eq(executionSteps.tenant_id, ctx.tenantId),
        eq(executionSteps.execution_id, execution_id),
      ),
    );
  expect(step?.output_preview).toEqual(caller);
}, 40_000);
