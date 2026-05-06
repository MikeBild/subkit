// Cancel an in-flight execution — POST /v1/executions/{id}/cancel.
//
// Three-stage flow:
//   (a) If the execution is still queued, mark the pg-boss job
//       cancelled so the worker never picks it up.
//   (b) Signal the in-process AbortController if the execution is
//       running on this process.
//   (c) Otherwise, write an abort_requested outbox event so another
//       worker process can observe it.
//
// Phase 4 of the 2026-05 architecture audit (issue #92).

import { createRoute, type OpenAPIHono } from "@hono/zod-openapi";
import { and, eq } from "drizzle-orm";
import { ErrorSchema, IdParam } from "../../../api/common-schemas.ts";
import { writeEvent } from "../../../db/events.ts";
import { executions } from "../../../db/schema/index.ts";
import { cancel as abortCancel, getAbort } from "../../../execution/index.ts";
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
    if (!row) throw new NotFoundError("execution");

    // (a) If the execution is still queued, mark the pg-boss job
    // cancelled so the worker never picks it up.
    if (row.status === "queued") {
      try {
        const { getBoss } = await import("../../../queue/boss.ts");
        const boss = getBoss();
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
    }

    // (b) Signal the in-process AbortController if the execution is
    // running on this process.
    const signaled = abortCancel(id, "cancelled");

    // (c) Otherwise, write an abort_requested outbox event so another
    // worker process can observe it. In P4 everything runs in one
    // process so this is effectively a future-cluster-mode hint.
    if (!signaled && row.status === "running" && !getAbort(id)) {
      await db.transaction(async (tx) => {
        await writeEvent(tx, {
          tenant_id: principal.tenant_id,
          channel: "execution.status",
          type: "execution.abort_requested",
          payload: { execution_id: id },
        });
      });
    }
    return c.body(null, 202);
  });
}
