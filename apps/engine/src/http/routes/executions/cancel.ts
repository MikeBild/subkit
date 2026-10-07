import { createRoute, type OpenAPIHono } from "@hono/zod-openapi";
import { and, eq } from "drizzle-orm";
import { ErrorSchema, IdParam } from "../../../api/common-schemas.ts";
import { actorType, readRequestSource } from "../../../audit/index.ts";
import { executions } from "../../../db/schema/index.ts";
import {
  cancel as abortCancel,
  executionVisibleToPrincipal,
  finalizeExecution,
  requestExecutionAbort,
} from "../../../execution/index.ts";
import { logger } from "../../../logging/index.ts";
import { EXECUTION_RUN_QUEUE } from "../../../queue/index.ts";
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
    const db = c.get("db");
    const { id } = c.req.valid("param");
    const rows = await db
      .select()
      .from(executions)
      .where(and(eq(executions.tenant_id, principal.tenant_id), eq(executions.id, id)))
      .limit(1);
    const row = rows[0];
    if (!row || !executionVisibleToPrincipal(row.caller_context, principal))
      throw new NotFoundError("execution");

    if (row.status === "queued" || row.status === "running") {
      await requestExecutionAbort(db, {
        tenant_id: principal.tenant_id,
        execution_id: id,
        actor_type: actorType(principal),
        actor_id: principal.id,
        request_source: readRequestSource(c) ?? "api",
      });
    }

    if (row.status === "queued") {
      try {
        const { getBoss } = await import("../../../queue/boss.ts");
        const boss = c.get("boss") ?? getBoss();
        const jobs = await boss.findJobs<{ execution_id: string }>(EXECUTION_RUN_QUEUE, {
          data: { execution_id: id },
        });
        if (jobs.length > 0) {
          const ids = jobs.map((j: { id: string }) => j.id);
          await boss.cancel(EXECUTION_RUN_QUEUE, ids);
        }
      } catch (err) {
        logger.debug({
          module: "queue",
          action: "cancel.skipped",
          msg: "could not cancel queued job (pg-boss not started or no matching job)",
          execution_id: id,
          error: err instanceof Error ? err.message : String(err),
        });
      }
      await finalizeExecution(db, principal.tenant_id, id, "aborted", null, null, ["queued"]);
    }

    abortCancel(id, "cancelled");
    return c.body(null, 202);
  });
}
