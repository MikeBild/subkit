// POST /v1/executions/{id}/rerun — faithful rerun with lineage.
//
// Creates a new execution pinned to the SAME workflow_version_id as
// the original (a rerun is a question about that version's behavior,
// not the workflow's latest), with `parent_execution_id` pointing at
// the original and input defaulting to the original's persisted
// `input` column. Saved-source executions only — draft/step runs have
// no persisted definition to rehydrate; re-POST those to
// POST /v1/executions instead.

import { createRoute, type OpenAPIHono, z } from "@hono/zod-openapi";
import { and, eq } from "drizzle-orm";
import { ErrorSchema, IdParam } from "../../../api/common-schemas.ts";
import { executions } from "../../../db/schema/index.ts";
import type { ExecutionMode } from "../../../execution/index.ts";
import { createExecution, runExecution } from "../../../execution/index.ts";
import type { ExecutionRunJob } from "../../../queue/index.ts";
import { EXECUTION_RUN_QUEUE, getBoss } from "../../../queue/index.ts";
import { HttpError, NotFoundError } from "../../errors.ts";
import { requireAuth } from "../../middleware/auth.ts";
import { requirePermission } from "../../middleware/require-permission.ts";
import type { AppEnv } from "../../openapi.ts";
import { enforceSavedWorkflowAllowlist } from "./run.ts";
import { RunResponseSchema } from "./schemas.ts";

const RerunBody = z
  .object({
    /** Override the original input. Omit to reuse it verbatim. */
    input: z.unknown().optional(),
    /** Queue the rerun (202 + execution_id) instead of running inline. */
    async: z.boolean().optional(),
  })
  .openapi("RerunExecutionBody");

const rerunRoute = createRoute({
  method: "post",
  path: "/v1/executions/{id}/rerun",
  tags: ["executions"],
  summary: "Rerun an execution with lineage to the original",
  description:
    "Runs the SAME workflow version as the original execution with the original input (overridable). The new execution's parent_execution_id points at the original, so the chain is queryable via GET /v1/executions?parent_execution_id=.",
  security: [{ bearerAuth: [] }],
  request: {
    params: IdParam,
    body: { content: { "application/json": { schema: RerunBody } } },
  },
  responses: {
    200: {
      description: "Rerun completed",
      content: { "application/json": { schema: RunResponseSchema } },
    },
    202: {
      description: "Rerun queued",
      content: { "application/json": { schema: RunResponseSchema } },
    },
    404: { description: "Not found", content: { "application/json": { schema: ErrorSchema } } },
    409: {
      description: "Original execution is not rerunnable",
      content: { "application/json": { schema: ErrorSchema } },
    },
  },
});

export function registerRerunRoute(app: OpenAPIHono<AppEnv>): void {
  // workflow:run, resource-scoped to the original's workflow when the
  // row resolves — mirrors the body-peek pattern POST /v1/executions
  // uses for its middleware gate.
  app.use("/v1/executions/:id/rerun", async (c, next) => {
    const id = c.req.param("id");
    const principal = c.get("principal");
    const db = c.get("db");
    if (principal && db) {
      const rows = await db
        .select({ workflow_id: executions.workflow_id })
        .from(executions)
        .where(and(eq(executions.tenant_id, principal.tenant_id), eq(executions.id, id)))
        .limit(1);
      const workflowId = rows[0]?.workflow_id;
      if (workflowId) {
        return requirePermission("workflow:run", () => ({ type: "workflow", id: workflowId }))(
          c,
          next,
        );
      }
    }
    return requirePermission("workflow:run")(c, next);
  });

  app.openapi(rerunRoute, async (c) => {
    const principal = requireAuth(c);
    const db = c.get("db");
    const { id } = c.req.valid("param");
    const body = c.req.valid("json");

    const rows = await db
      .select()
      .from(executions)
      .where(and(eq(executions.tenant_id, principal.tenant_id), eq(executions.id, id)))
      .limit(1);
    const original = rows[0];
    if (!original) throw new NotFoundError("execution");
    if (original.source_kind !== "saved" || !original.workflow_id) {
      throw HttpError.withEnvelope(
        409,
        "conflict",
        `execution has source_kind='${original.source_kind}' — only saved-workflow executions can be rerun`,
        {
          hint: "draft and step runs carry their definition in the original request — re-POST it to POST /v1/executions (sk workflows run --draft/--step)",
        },
      );
    }

    await enforceSavedWorkflowAllowlist(principal, original.workflow_id, db);

    const input = body.input !== undefined ? body.input : (original.input ?? null);
    const execution_mode: ExecutionMode = original.execution_mode ?? "dev";

    // Create the row up-front for both paths (the queue-worker pattern):
    // it pins the original's workflow_version_id, carries the lineage,
    // and stamps `source_ref.rerun_of` so the row reads as a rerun.
    const execution_id = await createExecution(db, {
      tenant_id: principal.tenant_id,
      workflow_id: original.workflow_id,
      workflow_version_id: original.workflow_version_id,
      source_kind: "saved",
      source_ref: { rerun_of: original.id },
      request_source: "api",
      parent_execution_id: original.id,
      execution_mode,
      input,
    });

    if (body.async) {
      const trace_id = c.get("trace_id") ?? null;
      const job: ExecutionRunJob = {
        tenant_id: principal.tenant_id,
        workflow_id: original.workflow_id,
        execution_id,
        input,
        request_source: "api",
        trace_id,
        execution_mode,
      };
      await (c.get("boss") ?? getBoss()).send(EXECUTION_RUN_QUEUE, job);
      return c.json({ execution_id, status: "queued" }, 202);
    }

    const result = await runExecution({
      db,
      tenant_id: principal.tenant_id,
      source: {
        kind: "saved",
        workflow_id: original.workflow_id,
        ...(original.workflow_version_id ? { version_id: original.workflow_version_id } : {}),
      },
      input,
      options: {
        request_source: "api",
        principal,
        execution_mode,
        parent_execution_id: original.id,
        existing_execution_id: execution_id,
      },
    });
    return c.json(
      {
        execution_id: result.execution_id,
        status: result.status,
        output: result.output,
        error: result.error,
        steps: result.steps,
        ...(result.connector_resolutions?.length
          ? { connector_resolutions: result.connector_resolutions }
          : {}),
        ...(result.warnings?.length ? { warnings: result.warnings } : {}),
      },
      200,
    );
  });
}
