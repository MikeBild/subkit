import { createRoute, type OpenAPIHono, z } from "@hono/zod-openapi";
import { ErrorSchema, IdParam } from "../../../api/common-schemas.ts";
import {
  findPrincipalSignalTarget,
  findTokenSignalTarget,
  isSensitivePayload,
} from "../../../execution/index.ts";
import { appendSignal } from "../../../workflow-signals/service.ts";
import { HttpError, NotFoundError, UnauthorizedError } from "../../errors.ts";
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
    query: z.object({ token: z.string().optional() }),
    body: { content: { "application/json": { schema: SignalRequestSchema } } },
  },
  responses: {
    202: {
      description: "Signal accepted",
      content: { "application/json": { schema: SignalResponseSchema } },
    },
    404: { description: "Not found", content: { "application/json": { schema: ErrorSchema } } },
    409: {
      description: "Sensitive executions do not accept persistent signals",
      content: { "application/json": { schema: ErrorSchema } },
    },
  },
});

export function registerSignalRoute(app: OpenAPIHono<AppEnv>): void {
  app.use("/v1/executions/:id/signals", async (c, next) => {
    if (c.req.query("token")) return next();
    const id = c.req.param("id");
    return requirePermission("execution:signal", () => ({ type: "execution", id }))(c, next);
  });

  app.openapi(signalRoute, async (c) => {
    const db = c.get("db");
    const { id } = c.req.valid("param");
    const body = c.req.valid("json");
    const { token } = c.req.valid("query");

    const target = token
      ? await findTokenSignalTarget(db, { execution_id: id, token, event_name: body.event })
      : await findPrincipalSignalTarget(db, requireAuth(c), id);
    if (!target.ok && target.reason === "token_rejected")
      throw new UnauthorizedError(`signal token rejected: ${target.detail}`);
    if (!target.ok) throw new NotFoundError("execution");

    if (isSensitivePayload(target.input))
      throw new HttpError(
        409,
        "sensitive_execution_unsupported",
        "Sensitive executions do not accept persistent signals.",
      );

    const { id: signal_id } = await appendSignal(db, {
      tenant_id: target.tenant_id,
      execution_id: id,
      event_name: body.event,
      ...(body.payload ? { payload: body.payload as Record<string, unknown> } : {}),
    });
    return c.json({ signal_id }, 202);
  });
}
