import { afterAll, beforeAll, expect, test } from "bun:test";
import { and, eq, sql } from "drizzle-orm";
import type { PgBoss } from "pg-boss";
import {
  browserSessionCookie,
  signBrowserCsrf,
  signBrowserSession,
} from "../../auth/browser-session.ts";
import { auditLog, executionSteps, executions, sessions } from "../../db/schema/index.ts";
import type { CallerContext } from "../../execution/caller-context.ts";
import { isSensitivePayload, recoverExecutionPayload } from "../../execution/sensitive-payload.ts";
import { createWorkflowRow } from "../../execution/tests/setup.ts";
import { createBoss, disposeBoss } from "../../queue/boss.ts";
import { registerExecutionRunHandler } from "../../queue/handlers/execution-run.ts";
import { waitFor } from "../../test-helpers/determinism/wait.ts";
import { buildDefaultRegistry, createApp } from "../server.ts";
import { createHttpTestServer, type HttpTestServer } from "./setup.ts";

let ctx: HttpTestServer;
let boss: PgBoss;
let app: ReturnType<typeof createApp>;
const secret = "ASYNC-SENSITIVE-CALLER-INPUT-CANARY";

async function expectExecutionAuditCaller(execution_id: string, caller: CallerContext) {
  const readExecutionEntries = async () => {
    const entries = await ctx.db
      .select({
        action: auditLog.action,
        actor_type: auditLog.actor_type,
        actor_id: auditLog.actor_id,
      })
      .from(auditLog)
      .where(
        and(
          eq(auditLog.tenant_id, ctx.tenantId),
          eq(auditLog.resource_type, "execution"),
          eq(auditLog.resource_id, execution_id),
        ),
      );
    return entries.filter(
      (entry) => entry.action === "execution.started" || entry.action === "execution.completed",
    );
  };
  const executionEntries = await waitFor(
    async () => {
      const found = await readExecutionEntries();
      return found.length >= 2 ? found : null;
    },
    { tries: 100, sleepMs: 50, label: "execution started and completed audit entries" },
  );
  expect(executionEntries).toHaveLength(2);
  expect(executionEntries.map((entry) => entry.action).sort()).toEqual([
    "execution.completed",
    "execution.started",
  ]);
  for (const entry of executionEntries) {
    expect(entry).toMatchObject({ actor_type: caller.principalKind, actor_id: caller.principalId });
  }
}

beforeAll(async () => {
  ctx = await createHttpTestServer("execution-caller-async");
  boss = await createBoss({ connectionString: ctx.testDb.url });
  app = createApp({ db: ctx.db, boss, registry: buildDefaultRegistry(ctx.db) });
  await registerExecutionRunHandler({ boss, db: ctx.db });
}, 30_000);

afterAll(async () => {
  if (boss) await disposeBoss(boss);
  if (ctx) await ctx.cleanup();
}, 30_000);

test("a real product browser session admits an asynchronous saved product workflow", async () => {
  const [session] = await ctx.db
    .insert(sessions)
    .values({
      tenant_id: ctx.tenantId,
      user_id: ctx.userId,
      product_id: "harmoniqs",
      expires_at: sql`clock_timestamp() + interval '1 hour'`,
      absolute_expires_at: sql`clock_timestamp() + interval '1 hour'`,
    })
    .returning();
  if (!session) throw new Error("product session fixture missing");
  const payload = { tenant_id: ctx.tenantId, user_id: ctx.userId, session_id: session.id };
  const { workflow_id } = await createWorkflowRow(ctx, {
    name: "Browser queued product caller",
    slug: "browser-queued-product-caller",
    product_id: "harmoniqs",
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
    headers: {
      cookie: browserSessionCookie(await signBrowserSession(payload)),
      "x-subkit-csrf": await signBrowserCsrf(payload),
      "Content-Type": "application/json",
    },
    body: JSON.stringify({
      source: "saved",
      workflow_id,
      hold_writes: true,
      async: true,
      input: { $caller: { principalId: "foreign", productId: "another-product" } },
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
    { tries: 150, sleepMs: 200, label: "browser product queued caller" },
  );
  expect(row.status).toBe("succeeded");
  const caller: CallerContext = {
    tenantId: ctx.tenantId,
    principalId: ctx.userId,
    principalKind: "user",
    provider: "browser_session",
    productId: "harmoniqs",
  };
  expect(row.caller_context).toEqual(caller);
  expect(row.caller_origin).toBe("principal");
  await expectExecutionAuditCaller(row.id, caller);
  expect(row.authorization_context).toMatchObject({
    source: { kind: "browser_session", session_id: session.id },
  });
  const [step] = await ctx.db
    .select({ output: executionSteps.output_preview })
    .from(executionSteps)
    .where(
      and(
        eq(executionSteps.tenant_id, ctx.tenantId),
        eq(executionSteps.execution_id, accepted.execution_id),
      ),
    );
  expect(step?.output).toEqual(caller);
}, 40_000);

for (const sensitive of [false, true]) {
  test(`HTTP async admission restores trusted caller and ${sensitive ? "encrypted" : "ordinary"} input in worker`, async () => {
    const { workflow_id } = await createWorkflowRow(ctx, {
      name: "HTTP queued caller",
      slug: sensitive ? "http-queued-sensitive-caller" : "http-queued-caller",
      ...(sensitive ? { execution_privacy: "sensitive" } : {}),
      steps: [
        {
          id: "echo",
          kind: "transform",
          language: "javascript",
          expression: "return { caller: input.scope.$caller, text: input.input.text };",
        },
      ],
    });
    const input = {
      text: secret,
      caller_origin: "trusted_system",
      $caller: { principalId: "spoofed", productId: "harmoniqs" },
    };
    const response = await app.request("/v1/executions", {
      method: "POST",
      headers: { Authorization: `Bearer ${ctx.apiKey}`, "Content-Type": "application/json" },
      body: JSON.stringify({
        source: "saved",
        workflow_id,
        hold_writes: true,
        async: true,
        caller_origin: "trusted_system",
        input,
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
      { tries: 150, sleepMs: 200, label: "HTTP admitted queued caller" },
    );
    expect(row.status).toBe("succeeded");
    const caller: CallerContext = {
      tenantId: ctx.tenantId,
      principalId: ctx.userId,
      principalKind: "user",
      provider: "api_key",
      productId: null,
    };
    expect(row.caller_context).toEqual(caller);
    expect(row.caller_origin).toBe("principal");
    await expectExecutionAuditCaller(row.id, caller);
    expect(row.authorization_context).toMatchObject({
      source: { kind: "api_key", api_key_id: ctx.apiKeyId },
    });
    const result = { caller, text: secret };
    const steps = await ctx.db
      .select()
      .from(executionSteps)
      .where(
        and(
          eq(executionSteps.tenant_id, ctx.tenantId),
          eq(executionSteps.execution_id, accepted.execution_id),
        ),
      );
    expect(steps).toHaveLength(1);
    if (sensitive) {
      expect(isSensitivePayload(row.input)).toBe(true);
      expect(isSensitivePayload(row.sensitive_result)).toBe(true);
      expect(recoverExecutionPayload(row.input, ctx.tenantId, row.id)).toEqual(input);
      expect(recoverExecutionPayload(row.sensitive_result, ctx.tenantId, row.id, "result")).toEqual(
        result,
      );
      const audit = await ctx.db
        .select()
        .from(auditLog)
        .where(and(eq(auditLog.tenant_id, ctx.tenantId), eq(auditLog.resource_id, row.id)));
      expect(JSON.stringify({ row, steps, audit })).not.toContain(secret);
      const downloaded = await app.request(`/v1/executions/${row.id}/result`, {
        headers: { Authorization: `Bearer ${ctx.apiKey}` },
      });
      expect(downloaded.status).toBe(200);
      expect(await downloaded.json()).toEqual({ result });
    } else {
      expect(steps[0]?.output_preview).toEqual(result);
    }
  }, 40_000);
}
