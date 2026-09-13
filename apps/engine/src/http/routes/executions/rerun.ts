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
import {
  admitWorkflowRun,
  assertExecutionAuthorityCurrent,
  finalizeExecution,
  runExecution,
} from "../../../execution/index.ts";
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
    hold_writes: z.boolean().optional(),
    execution_authority_id: z.string().uuid().optional(),
    idempotency_key: z.string().min(1).max(200).optional(),
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

    if (!original.workflow_version_id)
      throw new HttpError(
        409,
        "workflow_version_unavailable",
        "the original version is unavailable",
      );
    let admitted: Awaited<ReturnType<typeof admitWorkflowRun>>;
    try {
      admitted = await admitWorkflowRun(
        {
          tenant_id: principal.tenant_id,
          workflow_id: original.workflow_id,
          workflow_version_id: original.workflow_version_id,
          execution_authority_id: body.execution_authority_id,
          hold_writes: body.hold_writes,
          idempotency_key: body.idempotency_key,
          request_source: "api",
          parent_execution_id: original.id,
          execution_environment: execution_mode,
          input,
        },
        db,
      );
      if (body.async && admitted.execution_authority_id && admitted.status === "queued") {
        await assertExecutionAuthorityCurrent(db, principal.tenant_id, admitted.execution_id);
      }
    } catch (error) {
      const code = (error as { code?: string }).code;
      if (code === "input_schema_violation")
        throw new HttpError(400, code, (error as Error).message);
      if (
        code?.startsWith("execution_") ||
        code?.startsWith("workflow_version_") ||
        code === "workflow_archived"
      ) {
        throw new HttpError(409, code, (error as Error).message);
      }
      throw error;
    }
    const execution_id = admitted.execution_id;
    if (admitted.replayed && admitted.status !== "queued") {
      return c.json(
        { execution_id, status: admitted.status, idempotent_replay: true },
        admitted.status === "running" ? 202 : 200,
      );
    }

    if (body.async) {
      const trace_id = c.get("trace_id") ?? null;
      const job: ExecutionRunJob = {
        tenant_id: principal.tenant_id,
        workflow_id: original.workflow_id,
        execution_id,
        input: admitted.input,
        request_source: "api",
        trace_id,
        execution_mode,
      };
      try {
        await (c.get("boss") ?? getBoss()).send(EXECUTION_RUN_QUEUE, job, { id: execution_id });
      } catch (error) {
        if (!body.idempotency_key)
          await finalizeExecution(db, principal.tenant_id, execution_id, "failed", null, {
            step_id: null,
            error_code: "enqueue_failed",
            error_message: "The rerun could not be enqueued.",
          });
        throw error;
      }
      return c.json({ execution_id, status: "queued", hold_writes: admitted.hold_writes }, 202);
    }

    const result = await runExecution({
      db,
      tenant_id: principal.tenant_id,
      source: {
        kind: "saved",
        workflow_id: original.workflow_id,
        ...(original.workflow_version_id ? { version_id: original.workflow_version_id } : {}),
      },
      input: admitted.input,
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
        hold_writes: admitted.hold_writes,
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
