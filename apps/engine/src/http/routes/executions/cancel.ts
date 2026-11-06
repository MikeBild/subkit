import { createRoute, type OpenAPIHono } from "@hono/zod-openapi";
import { ErrorSchema, IdParam } from "../../../api/common-schemas.ts";
import { readRequestSource } from "../../../audit/index.ts";
import { cancelExecutionRequest } from "../../../execution/index.ts";
import { NotFoundError } from "../../errors.ts";
import { requireAuth } from "../../middleware/auth.ts";
import { requirePermission } from "../../middleware/require-permission.ts";
import type { AppEnv } from "../../openapi.ts";

const cancelRoute = createRoute({
  method: "post",
  path: "/v1/executions/{id}/cancel",
  tags: ["executions"],
  summary: "Cancel an in-flight execution",
  security: [{ bearerAuth: [] }],
  request: { params: IdParam },
  responses: {
    202: { description: "Cancellation requested" },
    404: { description: "Not found", content: { "application/json": { schema: ErrorSchema } } },
  },
});

export function registerCancelRoute(app: OpenAPIHono<AppEnv>): void {
  app.use("/v1/executions/:id/cancel", async (c, next) => {
    const id = c.req.param("id");
    return requirePermission("execution:abort", () => ({ type: "execution", id }))(c, next);
  });

  app.openapi(cancelRoute, async (c) => {
    const principal = requireAuth(c);
    const { id } = c.req.valid("param");
    const found = await cancelExecutionRequest(c.get("db"), {
      principal,
      execution_id: id,
      request_source: readRequestSource(c) ?? "api",
      boss: c.get("boss"),
    });
    if (!found) throw new NotFoundError("execution");
    return c.body(null, 202);
  });
}
