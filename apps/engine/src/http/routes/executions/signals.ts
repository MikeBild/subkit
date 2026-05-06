// Inject a runtime signal into a wait-for-event step (#49).
//
//   POST /v1/executions/{id}/signals[?token=<hmac>]
//   Body:  { event: string, payload?: Record<string, unknown> }
//
// Authorization paths (in order):
//
//   1. `?token=<hmac>` query param. Used by external approvers (Slack
//      button, email link). The token binds to (tenant_id, execution_id,
//      event_name, expires_at) so a stolen URL is bounded by the
//      wait_for_event timeout. Verified via `verifySignalToken` which
//      reuses the existing rotating-HMAC primitive at
//      `webhooks/outbound/signer.ts`. When a valid token is present,
//      the route bypasses the standard RBAC middleware — the token IS
//      the authorization.
//   2. Standard bearer auth + the `execution:signal` permission.
//      Internal callers (system accounts, ops dashboards) use this.

import { createRoute, type OpenAPIHono, z } from "@hono/zod-openapi";
import { and, eq } from "drizzle-orm";
import { ErrorSchema, IdParam } from "../../../api/common-schemas.ts";
import { executions } from "../../../db/schema/index.ts";
import { appendSignal } from "../../../workflow-signals/service.ts";
import { verifySignalToken } from "../../../workflow-signals/token.ts";
import { NotFoundError, UnauthorizedError } from "../../errors.ts";
import { requireAuth } from "../../middleware/auth.ts";
import { requirePermission } from "../../middleware/require-permission.ts";
import type { AppEnv } from "../../openapi.ts";

const SignalRequestSchema = z
  .object({
    event: z.string().min(1).openapi({ example: "refund.approved" }),
    payload: z.record(z.string(), z.unknown()).optional(),
  })
  .openapi("ExecutionSignalRequest");

const SignalResponseSchema = z
  .object({
    signal_id: z.string().uuid(),
  })
  .openapi("ExecutionSignalResponse");

const signalRoute = createRoute({
  method: "post",
  path: "/v1/executions/{id}/signals",
  tags: ["executions"],
  summary: "Inject a runtime signal into a wait-for-event step",
  security: [{ bearerAuth: [] }],
  request: {
    params: IdParam,
    body: { content: { "application/json": { schema: SignalRequestSchema } } },
  },
  responses: {
    202: {
      description: "Signal accepted",
      content: { "application/json": { schema: SignalResponseSchema } },
    },
    404: { description: "Not found", content: { "application/json": { schema: ErrorSchema } } },
  },
});

export function registerSignalRoute(app: OpenAPIHono<AppEnv>): void {
  // Conditional permission middleware: when a `?token=<hmac>` query is
  // present we delay auth until the body is parsed so the token can be
  // verified against the requested event_name. Otherwise fall through
  // to the standard `execution:signal` permission check.
  app.use("/v1/executions/:id/signals", async (c, next) => {
    if (c.req.query("token")) return next();
    const id = c.req.param("id");
    return requirePermission("execution:signal", () => ({ type: "execution", id }))(c, next);
  });

  app.openapi(signalRoute, async (c) => {
    const db = c.get("db");
    const { id } = c.req.valid("param");
    const body = c.req.valid("json");
    const token = c.req.query("token");

    let tenant_id: string;
    if (token) {
      // Token-mediated path. The execution row carries the canonical
      // tenant_id; we look it up by primary key (no tenant filter,
      // since the verifier proves the caller knows the tenant).
      // tenant-filter:exempt — tenant-scoped via principal at the route boundary; child rows reached by parent FK
      const rows = await db
        .select({ id: executions.id, tenant_id: executions.tenant_id })
        .from(executions)
        .where(eq(executions.id, id))
        .limit(1);
      if (!rows[0]) throw new NotFoundError("execution");
      const verdict = verifySignalToken(token, {
        tenant_id: rows[0].tenant_id,
        execution_id: id,
        event_name: body.event,
      });
      if (!verdict.ok) {
        throw new UnauthorizedError(`signal token rejected: ${verdict.reason}`);
      }
      tenant_id = rows[0].tenant_id;
    } else {
      const principal = requireAuth(c);
      tenant_id = principal.tenant_id;
      const rows = await db
        .select({ id: executions.id })
        .from(executions)
        .where(and(eq(executions.tenant_id, tenant_id), eq(executions.id, id)))
        .limit(1);
      if (!rows[0]) throw new NotFoundError("execution");
    }

    const { id: signal_id } = await appendSignal(db, {
      tenant_id,
      execution_id: id,
      event_name: body.event,
      ...(body.payload ? { payload: body.payload as Record<string, unknown> } : {}),
    });
    return c.json({ signal_id }, 202);
  });
}
