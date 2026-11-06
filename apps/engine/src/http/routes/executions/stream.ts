import type { OpenAPIHono } from "@hono/zod-openapi";
import {
  executionStatusEventConditions,
  visibleExecutionExists,
} from "../../../execution/index.ts";
import { NotFoundError } from "../../errors.ts";
import { requireAuth } from "../../middleware/auth.ts";
import { requirePermission } from "../../middleware/require-permission.ts";
import type { AppEnv } from "../../openapi.ts";
import { streamOutboxTail } from "../sse-outbox-tail.ts";

const TERMINAL_EXECUTION_EVENTS = new Set([
  "execution.succeeded",
  "execution.failed",
  "execution.refused",
  "execution.aborted",
  "execution.timed_out",
]);

export function registerExecutionStreamRoute(app: OpenAPIHono<AppEnv>): void {
  app.use("/v1/executions/:id/stream", async (c, next) => {
    const id = c.req.param("id");
    return requirePermission("execution:read", () => ({ type: "execution", id }))(c, next);
  });

  app.get("/v1/executions/:id/stream", async (c) => {
    const principal = requireAuth(c);
    const db = c.get("db");
    const id = c.req.param("id");
    if (!(await visibleExecutionExists(db, principal, id))) throw new NotFoundError("execution");
    return streamOutboxTail(c, {
      db,
      replay: "all",
      conds: () => executionStatusEventConditions(principal.tenant_id, id),
      closeAfter: (row) => TERMINAL_EXECUTION_EVENTS.has(row.type),
    });
  });
}
