import { afterAll, beforeAll, expect, test } from "bun:test";
import { eq, sql } from "drizzle-orm";
import {
  browserSessionCookie,
  signBrowserCsrf,
  signBrowserSession,
} from "../../auth/browser-session.ts";
import { connectors, executions, sessions } from "../../db/schema/index.ts";
import { createMockServer, jsonResponse, type MockServer } from "../../execution/tests/setup.ts";
import { createHttpTestServer, type HttpTestServer } from "./setup.ts";

let ctx: HttpTestServer;
let upstream: MockServer;
let connectorId: string;
let headers: Record<string, string>;
let requests = 0;

beforeAll(async () => {
  ctx = await createHttpTestServer("product-inline-execution");
  upstream = await createMockServer((_request, response) => {
    requests++;
    jsonResponse(response, 200, { private: "inline-product-read-canary" });
  });
  const [connector] = await ctx.db
    .insert(connectors)
    .values({
      tenant_id: ctx.tenantId,
      slug: "product-inline-target",
      display_name: "Product inline target",
      driver: "http",
      auth_type: "none",
      environment: "dev",
      base_url: upstream.baseUrl,
      config: {},
    })
    .returning();
  if (!connector) throw new Error("connector fixture missing");
  connectorId = connector.id;
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
  if (!session) throw new Error("session fixture missing");
  const payload = { tenant_id: ctx.tenantId, user_id: ctx.userId, session_id: session.id };
  headers = {
    cookie: browserSessionCookie(await signBrowserSession(payload)),
    "x-subkit-csrf": await signBrowserCsrf(payload),
    "Content-Type": "application/json",
  };
}, 30_000);

afterAll(async () => {
  if (upstream) await upstream.close();
  if (ctx) await ctx.cleanup();
}, 30_000);

for (const source of ["draft", "step"]) {
  for (const readRequest of [false, true]) {
    test(`product principal cannot execute ${source} ${readRequest ? "read connector" : "transform"} by declaring its product`, async () => {
      const step = readRequest
        ? {
            id: "read",
            kind: "request",
            connector_id: connectorId,
            method: "GET",
            path: "/private",
          }
        : { id: "observe", kind: "transform", language: "javascript", expression: "return 1;" };
      const response = await fetch(`${ctx.baseUrl}/v1/executions`, {
        method: "POST",
        headers,
        body: JSON.stringify({
          source,
          hold_writes: true,
          product_id: "harmoniqs",
          ...(source === "draft"
            ? {
                definition: {
                  name: "Self declared product",
                  product_id: "harmoniqs",
                  steps: [step],
                },
              }
            : { step }),
          input: { product_id: "harmoniqs", $caller: { principalId: ctx.userId } },
        }),
      });
      expect(response.status).toBe(403);
      const body = await response.text();
      expect(body).toContain("caller_saved_workflow_required");
      expect(body).not.toContain("inline-product-read-canary");
      const rows = await ctx.db
        .select({ id: executions.id })
        .from(executions)
        .where(eq(executions.tenant_id, ctx.tenantId));
      expect(rows).toHaveLength(0);
      expect(requests).toBe(0);
    });
  }
}
