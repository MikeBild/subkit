import { afterAll, beforeAll, expect, test } from "bun:test";
import { and, eq, sql } from "drizzle-orm";
import { AuditAction } from "../../audit/types.ts";
import {
  browserSessionCookie,
  signBrowserCsrf,
  signBrowserSession,
} from "../../auth/browser-session.ts";
import { createConnector, updateConnector } from "../../connectors/service.ts";
import { upsertCredential } from "../../credentials/service.ts";
import {
  auditLog,
  executionSteps,
  executions,
  roles,
  sessions,
  users,
} from "../../db/schema/index.ts";
import { TEST_DB_HOOK_TIMEOUT } from "../../db/tests/setup.ts";
import {
  createMockServer,
  createWorkflowRow,
  jsonResponse,
  type MockServer,
} from "../../execution/tests/setup.ts";
import { createBoss, disposeBoss } from "../../queue/boss.ts";
import { registerExecutionRunHandler } from "../../queue/handlers/execution-run.ts";
import { grantResource, revokeResource } from "../../rbac/grants.ts";
import { builtinRoleId } from "../../rbac/roles.ts";
import { waitFor } from "../../test-helpers/determinism/wait.ts";
import { buildDefaultRegistry, createApp } from "../server.ts";
import { createHttpTestServer, type HttpTestServer } from "./setup.ts";

let ctx: HttpTestServer;
let upstream: MockServer;
let upstreamRequests = 0;
beforeAll(async () => {
  ctx = await createHttpTestServer("queued-header-authorization");
  upstream = await createMockServer((_request, response) => {
    upstreamRequests++;
    jsonResponse(response, 200, { ok: true });
  });
}, TEST_DB_HOOK_TIMEOUT);
afterAll(async () => {
  if (upstream) await upstream.close();
  if (ctx) await ctx.cleanup();
}, TEST_DB_HOOK_TIMEOUT);

for (const change of ["session", "grant", "connector", "prod"] as const) {
  test(`HTTP enqueue rechecks ${change} before real broker dispatch`, async () => {
    const boss = await createBoss({ connectionString: ctx.testDb.url });
    try {
      const app = createApp({ db: ctx.db, boss, registry: buildDefaultRegistry(ctx.db) });
      let roleId = await builtinRoleId(ctx.db, "admin");
      if (change === "grant") {
        const [role] = await ctx.db
          .insert(roles)
          .values({ tenant_id: ctx.tenantId, name: "queued-resource-only" })
          .returning();
        if (!role) throw new Error("resource-only role missing");
        roleId = role.id;
      }
      const [user] = await ctx.db
        .insert(users)
        .values({ tenant_id: ctx.tenantId, email: `queue-${change}@example.test`, role_id: roleId })
        .returning();
      if (!user) throw new Error("queued user missing");
      const [session] = await ctx.db
        .insert(sessions)
        .values({
          tenant_id: ctx.tenantId,
          user_id: user.id,
          expires_at: sql`clock_timestamp() + interval '1 hour'`,
          absolute_expires_at: sql`clock_timestamp() + interval '1 hour'`,
        })
        .returning();
      if (!session) throw new Error("queued session missing");
      const slug = `queue-auth-${change}`;
      const dev = await createConnector(
        {
          tenant_id: ctx.tenantId,
          actor_id: null,
          input: {
            name: slug,
            slug,
            driver: "http",
            environment: "dev",
            base_url: upstream.baseUrl,
            auth_type: "none",
            config: {},
          },
        },
        ctx.db,
      );
      const target =
        change === "prod"
          ? await createConnector(
              {
                tenant_id: ctx.tenantId,
                actor_id: null,
                input: {
                  name: slug,
                  slug,
                  driver: "http",
                  environment: "prod",
                  base_url: upstream.baseUrl,
                  auth_type: "none",
                  config: {},
                },
              },
              ctx.db,
            )
          : dev;
      const { workflow_id } = await createWorkflowRow(ctx, {
        name: slug,
        slug,
        steps: [
          {
            id: "protected",
            kind: "request",
            connector_id: dev.id,
            method: "GET",
            path: "/protected",
            max_retries: 0,
            headers: { aUtHoRiZaTiOn: "synthetic-forwarded-auth" },
          },
        ],
      });
      const grant =
        change === "grant"
          ? await grantResource(ctx.db, {
              tenant_id: ctx.tenantId,
              subject_type: "user",
              subject_id: user.id,
              resource_type: "workflow",
              resource_id: workflow_id,
              permission: "workflow:run",
            })
          : null;
      const payload = { tenant_id: ctx.tenantId, user_id: user.id, session_id: session.id };
      const response = await app.request("/v1/executions", {
        method: "POST",
        headers: {
          cookie: browserSessionCookie(await signBrowserSession(payload)),
          "x-subkit-csrf": await signBrowserCsrf(payload),
          "content-type": "application/json",
          "x-subkit-environment": change === "prod" ? "prod" : "dev",
        },
        body: JSON.stringify({
          source: "saved",
          workflow_id,
          async: true,
          hold_writes: true,
          input: {},
        }),
      });
      expect(response.status).toBe(202);
      const accepted = (await response.json()) as { execution_id: string };
      const before = await ctx.db
        .select()
        .from(executions)
        .where(
          and(eq(executions.tenant_id, ctx.tenantId), eq(executions.id, accepted.execution_id)),
        );
      expect(before[0]?.status).toBe("queued");
      expect(before[0]?.execution_mode).toBe(change === "prod" ? "prod" : "dev");
      expect(before[0]?.caller_context).toMatchObject({
        tenantId: ctx.tenantId,
        principalId: user.id,
        provider: "browser_session",
      });
      if (change === "session")
        await ctx.db
          .update(sessions)
          .set({ revoked_at: sql`clock_timestamp()` })
          .where(and(eq(sessions.tenant_id, ctx.tenantId), eq(sessions.id, session.id)));
      if (grant) expect(await revokeResource(ctx.db, ctx.tenantId, grant.id)).toBe(true);
      if (change === "connector" || change === "prod") {
        await updateConnector(ctx.tenantId, target.id, { auth_type: "bearer" }, null, ctx.db);
        await upsertCredential(
          {
            tenant_id: ctx.tenantId,
            connector_id: target.id,
            environment: target.environment,
            mode: "bearer",
            value: { mode: "bearer", token: "synthetic-saved-auth" },
            actor_id: null,
          },
          ctx.db,
        );
      }
      await registerExecutionRunHandler({ boss, db: ctx.db });
      const terminal = await waitFor(
        async () => {
          const [row] = await ctx.db
            .select()
            .from(executions)
            .where(
              and(eq(executions.tenant_id, ctx.tenantId), eq(executions.id, accepted.execution_id)),
            );
          return row && !["queued", "running"].includes(row.status) ? row : null;
        },
        { tries: 150, sleepMs: 200, label: `broker ${change} reauthorization` },
      );
      expect(terminal.status).toBe("failed");
      expect(upstreamRequests).toBe(0);
      const steps = await ctx.db
        .select()
        .from(executionSteps)
        .where(
          and(
            eq(executionSteps.tenant_id, ctx.tenantId),
            eq(executionSteps.execution_id, terminal.id),
          ),
        );
      if (change === "session" || change === "grant") {
        expect(terminal.failure).toMatchObject({
          error_code: "execution_authentication_unavailable",
        });
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
              eq(auditLog.reason, "execution_authentication_unavailable"),
            ),
          );
        expect(denials).toHaveLength(1);
        expect(denials[0]).toMatchObject({
          actor_type: "user",
          actor_id: user.id,
          result: "denied",
          reason: "execution_authentication_unavailable",
          metadata: { workflow_id, request_source: "queue" },
        });
      } else {
        expect(steps).toHaveLength(1);
        expect(steps[0]?.error).toMatchObject({
          message: "request headers conflict with connector authentication",
        });
      }
    } finally {
      await disposeBoss(boss);
    }
  }, 40_000);
}
