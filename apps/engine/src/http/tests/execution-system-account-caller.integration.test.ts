import { afterAll, beforeAll, expect, test } from "bun:test";
import { createHash } from "node:crypto";
import { and, eq } from "drizzle-orm";
import type { PgBoss } from "pg-boss";
import {
  apiKeys,
  auditLog,
  executionSteps,
  executions,
  systemAccounts,
} from "../../db/schema/index.ts";
import { createWorkflowRow } from "../../execution/tests/setup.ts";
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
let keyId: string;

beforeAll(async () => {
  ctx = await createHttpTestServer("execution-system-account-caller");
  await ctx.db
    .update(systemAccounts)
    .set({ role_id: await builtinRoleId(ctx.db, "admin") })
    .where(eq(systemAccounts.id, ctx.systemAccountId));
  key = "wf_live_SYS_execution_system_account_caller_000";
  const [apiKey] = await ctx.db
    .insert(apiKeys)
    .values({
      tenant_id: ctx.tenantId,
      system_account_id: ctx.systemAccountId,
      prefix: key.slice(0, 12),
      token_sha256: createHash("sha256").update(key).digest("hex"),
      scopes: ["*"],
    })
    .returning({ id: apiKeys.id });
  if (!apiKey) throw new Error("system account API key fixture missing");
  keyId = apiKey.id;
  boss = await createBoss({ connectionString: ctx.testDb.url });
  app = createApp({ db: ctx.db, boss, registry: buildDefaultRegistry(ctx.db) });
  await registerExecutionRunHandler({ boss, db: ctx.db });
}, 30_000);

afterAll(async () => {
  if (boss) await disposeBoss(boss);
  if (ctx) await ctx.cleanup();
}, 30_000);

test("authenticated system account caller reaches workflow output and exact execution audit", async () => {
  const { workflow_id } = await createWorkflowRow(ctx, {
    name: "System account caller attribution",
    slug: "system-account-caller-attribution",
    steps: [
      {
        id: "identity",
        kind: "transform",
        language: "javascript",
        expression: "return input.scope.$caller;",
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
      input: { $caller: { principalId: "spoofed", principalKind: "user" } },
    }),
  });
  expect(response.status).toBe(202);
  const accepted = (await response.json()) as { execution_id: string };
  const row = await waitFor(
    async () => {
      const [execution] = await ctx.db
        .select()
        .from(executions)
        .where(
          and(eq(executions.tenant_id, ctx.tenantId), eq(executions.id, accepted.execution_id)),
        );
      return execution && !["queued", "running"].includes(execution.status) ? execution : null;
    },
    { tries: 150, sleepMs: 200, label: "system account queued caller" },
  );
  const caller = {
    tenantId: ctx.tenantId,
    principalId: ctx.systemAccountId,
    principalKind: "system_account" as const,
    provider: "api_key",
    productId: null,
  };
  expect(row.status).toBe("succeeded");
  expect(row.caller_context).toEqual(caller);
  expect(row.authorization_context).toMatchObject({
    source: { kind: "api_key", api_key_id: keyId },
  });
  const [step] = await ctx.db
    .select({ output: executionSteps.output_preview })
    .from(executionSteps)
    .where(
      and(eq(executionSteps.tenant_id, ctx.tenantId), eq(executionSteps.execution_id, row.id)),
    );
  expect(step?.output).toEqual(caller);
  const lifecycle = await waitFor(
    async () => {
      const entries = await ctx.db
        .select({
          action: auditLog.action,
          tenant_id: auditLog.tenant_id,
          resource_type: auditLog.resource_type,
          resource_id: auditLog.resource_id,
          actor_type: auditLog.actor_type,
          actor_id: auditLog.actor_id,
        })
        .from(auditLog)
        .where(
          and(
            eq(auditLog.tenant_id, ctx.tenantId),
            eq(auditLog.resource_type, "execution"),
            eq(auditLog.resource_id, row.id),
          ),
        );
      const lifecycle = entries.filter(
        (entry) => entry.action === "execution.started" || entry.action === "execution.completed",
      );
      return lifecycle.length === 2 ? lifecycle : null;
    },
    { tries: 50, sleepMs: 20, label: "system account execution lifecycle audit" },
  );
  expect(lifecycle).toHaveLength(2);
  expect(lifecycle.map((entry) => entry.action).sort()).toEqual([
    "execution.completed",
    "execution.started",
  ]);
  for (const entry of lifecycle) {
    expect(entry).toEqual({
      action: entry.action,
      tenant_id: ctx.tenantId,
      resource_type: "execution",
      resource_id: row.id,
      actor_type: "system_account",
      actor_id: ctx.systemAccountId,
    });
  }
});
