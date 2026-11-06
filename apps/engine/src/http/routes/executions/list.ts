import { createRoute, type OpenAPIHono, z } from "@hono/zod-openapi";
import { ErrorSchema, IdParam } from "../../../api/common-schemas.ts";
import { readRequestSource } from "../../../audit/index.ts";
import {
  authorizeSensitiveResume,
  executionStatusEventConditions,
  findVisibleExecutionRow,
  isSensitivePayload,
  recoverExecutionPayload,
  visibleExecutionExists,
} from "../../../execution/index.ts";
import { NotFoundError } from "../../errors.ts";
import { requireAuth } from "../../middleware/auth.ts";
import { requirePermission } from "../../middleware/require-permission.ts";
import type { AppEnv } from "../../openapi.ts";
import { streamOutboxTail } from "../sse-outbox-tail.ts";
import { admissionRefusal } from "./admission-errors.ts";

const getSensitiveResultRoute = createRoute({
  method: "get",
  path: "/v1/executions/{id}/result",
  tags: ["executions"],
  summary: "Get the result of a sensitive execution for its original caller",
  security: [{ bearerAuth: [] }],
  request: { params: IdParam },
  responses: {
    200: {
      description: "OK",
      content: { "application/json": { schema: z.object({ result: z.unknown() }) } },
    },
    403: {
      description: "The authenticated caller does not match the original sensitive execution",
      content: { "application/json": { schema: ErrorSchema } },
    },
    404: { description: "Not found", content: { "application/json": { schema: ErrorSchema } } },
  },
});

export function registerExecutionResultRoutes(app: OpenAPIHono<AppEnv>): void {
  app.use("/v1/executions/:id/stream", async (c, next) => {
    const id = c.req.param("id");
    return requirePermission("execution:read", () => ({ type: "execution", id }))(c, next);
  });
  app.use("/v1/executions/:id/result", async (c, next) => {
    const id = c.req.param("id");
    return requirePermission("execution:read", () => ({ type: "execution", id }))(c, next);
  });

  app.openapi(getSensitiveResultRoute, async (c) => {
    const principal = requireAuth(c);
    const db = c.get("db");
    const { id } = c.req.valid("param");
    const row = await findVisibleExecutionRow(db, principal, id);
    if (
      !row ||
      row.status !== "succeeded" ||
      !isSensitivePayload(row.input) ||
      !isSensitivePayload(row.sensitive_result)
    )
      throw new NotFoundError("execution_result");
    try {
      await authorizeSensitiveResume(db, row, principal);
    } catch (error) {
      return admissionRefusal(error, {
        db,
        principal,
        workflow_id: row.workflow_id,
        request_source: readRequestSource(c) ?? "api",
        execution_id: row.id,
      });
    }
    return c.json(
      {
        result: recoverExecutionPayload(
          row.sensitive_result,
          principal.tenant_id,
          row.id,
          "result",
        ),
      },
      200,
    );
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

const TERMINAL_EXECUTION_EVENTS = new Set([
  "execution.succeeded",
  "execution.failed",
  "execution.refused",
  "execution.aborted",
  "execution.timed_out",
]);
