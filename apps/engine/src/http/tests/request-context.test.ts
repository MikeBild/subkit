import { afterAll, beforeAll, expect, test } from "bun:test";
import { type ServerType, serve } from "@hono/node-server";
import { Hono } from "hono";
import { modelTenantContext } from "../../llm/core/hosted-budget-middleware.ts";
import { getContext, type LogContext, withContext } from "../../logging/context.ts";
import { authMiddleware } from "../middleware/auth.ts";
import { traceMiddleware } from "../middleware/trace.ts";
import type { AppEnv } from "../openapi.ts";
import { buildDefaultRegistry } from "../server.ts";
import { createHttpTestServer, type HttpTestServer } from "./setup.ts";

let fixture: HttpTestServer;
let server: ServerType;
let baseUrl: string;

beforeAll(async () => {
  fixture = await createHttpTestServer("request-context");
  const app = new Hono<AppEnv>();
  app.use("*", traceMiddleware());
  app.use("*", async (c, next) => {
    c.set("db", fixture.db);
    await next();
  });
  app.use("*", authMiddleware(buildDefaultRegistry(fixture.db)));
  app.get("/context", (c) =>
    c.json({
      context: getContext(),
      principal_id: c.get("principal")?.id ?? null,
      model_tenant: modelTenantContext() ?? null,
    }),
  );
  server = withContext(
    {
      tenant_id: "00000000-0000-0000-0000-000000000000",
      actor_id: "boot",
      auth_via: "token_exchange",
      execution_id: "boot-execution",
      workflow_id: "boot-workflow",
      execution_privacy: "sensitive",
      request_source: "cli",
    },
    () => serve({ hostname: "127.0.0.1", port: 0, fetch: app.fetch }),
  );
  const address = (server as { address: () => { port: number } | null }).address();
  if (!address) throw new Error("missing test server address");
  baseUrl = `http://127.0.0.1:${address.port}`;
});

afterAll(async () => {
  if (server) {
    const closeable = server as ServerType & {
      closeIdleConnections?: () => void;
      closeAllConnections?: () => void;
    };
    closeable.closeIdleConnections?.();
    closeable.closeAllConnections?.();
    await new Promise<void>((resolve) => server.close(() => resolve()));
  }
  await fixture?.cleanup();
});

test("binds a verified principal and then leaves an anonymous request without authority", async () => {
  const authenticated = await fetch(`${baseUrl}/context`, {
    headers: {
      authorization: `Bearer ${fixture.apiKey}`,
      "x-trace-id": "authenticated-context-proof",
    },
  });
  expect(authenticated.status).toBe(200);
  const authenticatedBody = (await authenticated.json()) as {
    context: LogContext;
    principal_id: string;
    model_tenant: string;
  };
  expect(authenticatedBody.principal_id).toBe(fixture.userId);
  expect(authenticatedBody.model_tenant).toBe(fixture.tenantId);
  expect(authenticatedBody.context.tenant_id).toBe(fixture.tenantId);
  expect(authenticatedBody.context.actor_id).toBe(fixture.userId);
  expect(authenticatedBody.context.auth_via).toBeUndefined();
  expect(authenticatedBody.context.execution_id).toBeUndefined();
  expect(authenticatedBody.context.workflow_id).toBeUndefined();
  expect(authenticatedBody.context.execution_privacy).toBeUndefined();
  expect(authenticatedBody.context.trace_id).toBe("authenticated-context-proof");

  const anonymous = await fetch(`${baseUrl}/context`, {
    headers: {
      "x-subkit-tenant": fixture.tenantId,
      "x-trace-id": "anonymous-context-proof",
    },
  });
  expect(anonymous.status).toBe(200);
  const anonymousBody = (await anonymous.json()) as {
    context: LogContext;
    principal_id: null;
    model_tenant: null;
  };
  expect(anonymousBody.principal_id).toBeNull();
  expect(anonymousBody.model_tenant).toBeNull();
  expect(anonymousBody.context.tenant_id).toBeUndefined();
  expect(anonymousBody.context.actor_id).toBeUndefined();
  expect(anonymousBody.context.auth_via).toBeUndefined();
  expect(anonymousBody.context.execution_id).toBeUndefined();
  expect(anonymousBody.context.workflow_id).toBeUndefined();
  expect(anonymousBody.context.execution_privacy).toBeUndefined();
  expect(anonymousBody.context.trace_id).toBe("anonymous-context-proof");
  expect(anonymousBody.context.request_source).toBe("api");
});
