import { afterAll, beforeAll, expect, test } from "bun:test";
import { createHash } from "node:crypto";
import { and, eq } from "drizzle-orm";
import type { PgBoss } from "pg-boss";
import { AuditAction } from "../../audit/types.ts";
import {
  apiKeys,
  auditLog,
  executionSteps,
  executions,
  systemAccounts,
} from "../../db/schema/index.ts";
import { createWorkflowRow } from "../../execution/tests/setup.ts";
import { deleteSystemAccount } from "../../identity/service.ts";
import { createBoss, disposeBoss } from "../../queue/boss.ts";
import { registerExecutionRunHandler } from "../../queue/handlers/execution-run.ts";
import { builtinRoleId } from "../../rbac/roles.ts";
import { waitFor } from "../../test-helpers/determinism/wait.ts";
import { buildDefaultRegistry, createApp } from "../server.ts";
import { createHttpTestServer, type HttpTestServer } from "./setup.ts";

let ctx: HttpTestServer;
let boss: PgBoss;
let app: ReturnType<typeof createApp>;
let key: string;

beforeAll(async () => {
  ctx = await createHttpTestServer("execution-system-account-queue-denial");
  await ctx.db
    .update(systemAccounts)
    .set({ role_id: await builtinRoleId(ctx.db, "admin") })
    .where(eq(systemAccounts.id, ctx.systemAccountId));
  key = "wf_live_SYS_execution_system_account_queue_denial_000";
  await ctx.db.insert(apiKeys).values({
    tenant_id: ctx.tenantId,
    system_account_id: ctx.systemAccountId,
    prefix: key.slice(0, 12),
    token_sha256: createHash("sha256").update(key).digest("hex"),
    scopes: ["*"],
  });
  boss = await createBoss({ connectionString: ctx.testDb.url });
  app = createApp({ db: ctx.db, boss, registry: buildDefaultRegistry(ctx.db) });
}, 30_000);

afterAll(async () => {
  if (boss) await disposeBoss(boss);
  if (ctx) await ctx.cleanup();
}, 30_000);

test("queued system-account execution is denied and audited after account deletion", async () => {
  const { workflow_id } = await createWorkflowRow(ctx, {
    name: "System account queue denial",
    slug: "system-account-queue-denial",
    steps: [
      {
        id: "identity",
        kind: "transform",
        language: "javascript",
        expression: "return { dispatched: true };",
      },
    ],
  });
  const response = await app.request("/v1/executions", {
    method: "POST",
    headers: { Authorization: `Bearer ${key}`, "Content-Type": "application/json" },
    body: JSON.stringify({
      source: "saved",
      workflow_id,
      hold_writes: true,
      async: true,
      input: {},
    }),
  });
  expect(response.status).toBe(202);
  const accepted = (await response.json()) as { execution_id: string };
  const [queued] = await ctx.db
    .select()
    .from(executions)
    .where(and(eq(executions.tenant_id, ctx.tenantId), eq(executions.id, accepted.execution_id)));
  expect(queued?.status).toBe("queued");
  expect(queued?.caller_context).toMatchObject({
    tenantId: ctx.tenantId,
    principalId: ctx.systemAccountId,
    principalKind: "system_account",
    provider: "api_key",
  });

  const deleted = await deleteSystemAccount(
    { tenant_id: ctx.tenantId, id: ctx.systemAccountId, actor_id: ctx.userId },
    ctx.db,
  );
  expect(deleted).not.toBeNull();
  expect(deleted?.deleted_at).toBeInstanceOf(Date);
  await registerExecutionRunHandler({ boss, db: ctx.db });

  const terminal = await waitFor(
    async () => {
      const [execution] = await ctx.db
        .select()
        .from(executions)
        .where(
          and(eq(executions.tenant_id, ctx.tenantId), eq(executions.id, accepted.execution_id)),
        );
      return execution && !["queued", "running"].includes(execution.status) ? execution : null;
    },
    { tries: 150, sleepMs: 200, label: "deleted system account queue authorization" },
  );
  expect(terminal.status).toBe("failed");
  expect(terminal.failure).toMatchObject({ error_code: "execution_authentication_unavailable" });
  const steps = await ctx.db
    .select()
    .from(executionSteps)
    .where(
      and(eq(executionSteps.tenant_id, ctx.tenantId), eq(executionSteps.execution_id, terminal.id)),
    );
  expect(steps).toHaveLength(0);

  const denials = await ctx.db
    .select({
      actor_type: auditLog.actor_type,
      actor_id: auditLog.actor_id,
      result: auditLog.result,
      reason: auditLog.reason,
      metadata: auditLog.metadata,
    })
    .from(auditLog)
    .where(
      and(
        eq(auditLog.tenant_id, ctx.tenantId),
        eq(auditLog.action, AuditAction.POLICY_DENIED),
        eq(auditLog.resource_type, "execution"),
        eq(auditLog.resource_id, terminal.id),
      ),
    );
  expect(denials).toHaveLength(1);
  expect(denials[0]).toMatchObject({
    actor_type: "system_account",
    actor_id: ctx.systemAccountId,
    result: "denied",
    reason: "execution_authentication_unavailable",
    metadata: { workflow_id, request_source: "queue" },
  });
});
