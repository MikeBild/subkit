// Execution list / get / steps / cancel / run.
//
// The POST /v1/executions endpoint is the single runtime entry point —
// saved, draft, and step runs all flow through it via a discriminated
// union.

import { createRoute, type OpenAPIHono, z } from "@hono/zod-openapi";
import { and, asc, desc, eq } from "drizzle-orm";
import { ErrorSchema, IdParam, paginatedResponse } from "../../api/common-schemas.ts";
import { auditAwait } from "../../audit/audit.ts";
import { AuditAction } from "../../audit/types.ts";
import type { ResolvedPrincipal } from "../../auth/types.ts";
import { writeEvent } from "../../db/events.ts";
import { executionSteps, executions } from "../../db/schema/index.ts";
import { cancel as abortCancel, getAbort } from "../../execution/abort.ts";
import { runExecution } from "../../execution/engine.ts";
import { RequestMetaSchema } from "../../execution/request-meta-schema.ts";
import { type RunExecutionSource, resolveDefinition } from "../../execution/resolve-definition.ts";
import { createExecution } from "../../execution/state.ts";
import type { ExecutionMode } from "../../execution/types.ts";
import { logger } from "../../logging/logger.ts";
import { getBoss } from "../../queue/boss.ts";
import type { ExecutionRunJob } from "../../queue/queues.ts";
import { EXECUTION_RUN_QUEUE } from "../../queue/queues.ts";
import { StepSchema, WorkflowDefSchema } from "../../workflows/types.ts";
import { BadRequestError, ForbiddenError, NotFoundError } from "../errors.ts";
import { requireAuth } from "../middleware/auth.ts";
import { requirePermission } from "../middleware/require-permission.ts";
import type { AppEnv } from "../openapi.ts";

const ExecSchema = z
  .object({
    id: z.string(),
    /** NULL for draft and step runs (no persisted workflow row). */
    workflow_id: z.string().nullable(),
    workflow_version_id: z.string().nullable(),
    source_kind: z.enum(["saved", "draft", "step"]),
    source_ref: z.record(z.string(), z.unknown()).nullable(),
    status: z.string(),
    request_source: z.string(),
    parent_execution_id: z.string().nullable(),
    started_at: z.string().nullable(),
    finished_at: z.string().nullable(),
    created_at: z.string(),
  })
  .openapi("Execution");

const ExecListResponse = paginatedResponse(ExecSchema, "ExecutionListResponse");

const StepRowSchema = z
  .object({
    id: z.string(),
    step_key: z.string(),
    step_index: z.number().nullable(),
    kind: z.string(),
    status: z.string(),
    duration_ms: z.number().nullable(),
    retry_count: z.number(),
    result_storage_uri: z.string().nullable(),
    result_preview: z.string().nullable(),
    output_preview: z.unknown().nullable(),
    error: z.unknown().nullable(),
    request_meta: z.unknown().nullable(),
    started_at: z.string().nullable(),
    finished_at: z.string().nullable(),
  })
  .openapi("ExecutionStep");

const StepListResponse = paginatedResponse(StepRowSchema, "ExecutionStepListResponse");

const listExecutionsRoute = createRoute({
  method: "get",
  path: "/v1/executions",
  tags: ["executions"],
  summary: "List executions",
  security: [{ bearerAuth: [] }],
  request: {
    query: z
      .object({
        limit: z.coerce.number().int().positive().max(200).optional(),
        workflow_id: z.string().uuid().optional(),
        status: z.string().optional(),
        request_source: z.string().optional(),
      })
      .openapi("ListExecutionsQuery"),
  },
  responses: {
    200: { description: "OK", content: { "application/json": { schema: ExecListResponse } } },
  },
});

const getExecutionRoute = createRoute({
  method: "get",
  path: "/v1/executions/{id}",
  tags: ["executions"],
  summary: "Get an execution",
  security: [{ bearerAuth: [] }],
  request: { params: IdParam },
  responses: {
    200: { description: "OK", content: { "application/json": { schema: ExecSchema } } },
    404: { description: "Not found", content: { "application/json": { schema: ErrorSchema } } },
  },
});

const getStepsRoute = createRoute({
  method: "get",
  path: "/v1/executions/{id}/steps",
  tags: ["executions"],
  summary: "List steps for an execution",
  security: [{ bearerAuth: [] }],
  request: { params: IdParam },
  responses: {
    200: { description: "OK", content: { "application/json": { schema: StepListResponse } } },
    404: { description: "Not found", content: { "application/json": { schema: ErrorSchema } } },
  },
});

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

// POST /v1/executions — the single runtime entry point.
//
// Discriminated union over `source`:
//   • saved  → references a persisted workflow by id
//   • draft  → inline WorkflowDef, no commit required
//   • step   → single StepDef, one-step synthetic workflow
//
const RuntimeRunBodySchema = z.discriminatedUnion("source", [
  z
    .object({
      source: z.literal("saved"),
      workflow_id: z.string().uuid(),
      version_id: z.string().uuid().optional(),
      input: z.unknown().optional(),
      async: z.boolean().optional(),
      request_source: z
        .enum(["api", "cli", "mcp", "webhook", "tool-chain", "scheduler", "chat"])
        .optional(),
    })
    .openapi("RunSavedBody"),
  z
    .object({
      source: z.literal("draft"),
      definition: WorkflowDefSchema,
      name: z.string().optional(),
      input: z.unknown().optional(),
      request_source: z
        .enum(["api", "cli", "mcp", "webhook", "tool-chain", "scheduler", "chat"])
        .optional(),
    })
    .openapi("RunDraftBody"),
  z
    .object({
      source: z.literal("step"),
      step: StepSchema,
      workflow_slug: z.string().optional(),
      input: z.unknown().optional(),
      scope: z.record(z.string(), z.unknown()).optional(),
      timeout_ms: z.number().int().positive().max(60_000).optional(),
      request_source: z
        .enum(["api", "cli", "mcp", "webhook", "tool-chain", "scheduler", "chat"])
        .optional(),
    })
    .openapi("RunStepBody"),
]);

const OpenApiDraftDefinitionSchema = z
  .object({
    name: z.string().min(1),
    slug: z.string().min(1).optional(),
    description: z.string().optional(),
    input_schema: z.record(z.string(), z.unknown()).optional(),
    output_schema: z.record(z.string(), z.unknown()).optional(),
    steps: z.array(z.record(z.string(), z.unknown())).min(1).max(200),
    timeout_ms: z.number().int().positive().optional(),
  })
  .openapi("ExecutionRunDraftDefinition");

const OpenApiStepSchema = z
  .object({
    kind: z.string().min(1),
  })
  .catchall(z.unknown())
  .openapi("ExecutionRunStep");

const RunBodySchema = z.discriminatedUnion("source", [
  z
    .object({
      source: z.literal("saved"),
      workflow_id: z.string().uuid(),
      version_id: z.string().uuid().optional(),
      input: z.unknown().optional(),
      async: z.boolean().optional(),
      request_source: z
        .enum(["api", "cli", "mcp", "webhook", "tool-chain", "scheduler", "chat"])
        .optional(),
    })
    .openapi("ExecutionRunSavedBody"),
  z
    .object({
      source: z.literal("draft"),
      definition: OpenApiDraftDefinitionSchema,
      name: z.string().optional(),
      input: z.unknown().optional(),
      request_source: z
        .enum(["api", "cli", "mcp", "webhook", "tool-chain", "scheduler", "chat"])
        .optional(),
    })
    .openapi("ExecutionRunDraftBody"),
  z
    .object({
      source: z.literal("step"),
      step: OpenApiStepSchema,
      workflow_slug: z.string().optional(),
      input: z.unknown().optional(),
      scope: z.record(z.string(), z.unknown()).optional(),
      timeout_ms: z.number().int().positive().max(60_000).optional(),
      request_source: z
        .enum(["api", "cli", "mcp", "webhook", "tool-chain", "scheduler", "chat"])
        .optional(),
    })
    .openapi("ExecutionRunStepBody"),
]);

const AppliedAuthMethodEnum = z.enum([
  "none",
  "bearer",
  "header",
  "query",
  "basic",
  "oauth2_static",
  "oauth2_refreshed",
]);

const ConnectorResolutionSummarySchema = z
  .object({
    step_key: z.string(),
    connector_id: z.string(),
    connector_slug: z.string(),
    driver: z.string(),
    requested_environment: z.enum(["dev", "prod"]),
    resolved_environment: z.enum(["dev", "prod"]),
    auth_method: AppliedAuthMethodEnum,
    tunnel_target: z.string().nullable().optional(),
    base_url: z.string().nullable().optional(),
  })
  .openapi("ConnectorResolutionSummary");

const RunStepSummarySchema = z
  .object({
    step_key: z.string(),
    step_index: z.number().int(),
    kind: z.string(),
    status: z.string(),
    duration_ms: z.number().nullable(),
    retry_count: z.number().int(),
    error: z.unknown().nullable(),
    // Driver-discriminated meta — published as a discriminatedUnion
    // so external clients can narrow on `.driver` from the OpenAPI
    // contract. See `execution/request-meta-schema.ts`.
    request_meta: RequestMetaSchema.nullable().optional(),
  })
  .openapi("ExecutionRunStepSummary");

const RunResponseSchema = z
  .object({
    execution_id: z.string(),
    status: z.string(),
    output: z.unknown().optional(),
    error: z.unknown().nullable().optional(),
    steps: z.array(RunStepSummarySchema).optional(),
    connector_resolutions: z.array(ConnectorResolutionSummarySchema).optional(),
    warnings: z.array(z.unknown()).optional(),
  })
  .openapi("ExecutionRunResponse");

const runExecutionRoute = createRoute({
  method: "post",
  path: "/v1/executions",
  tags: ["executions"],
  summary: "Run a saved workflow, a draft definition, or a single step",
  security: [{ bearerAuth: [] }],
  request: {
    headers: z.object({ "x-subkit-environment": z.enum(["dev", "prod"]).optional() }),
    body: { content: { "application/json": { schema: RunBodySchema } } },
  },
  responses: {
    200: {
      description: "Run completed",
      content: { "application/json": { schema: RunResponseSchema } },
    },
    202: {
      description: "Run queued",
      content: { "application/json": { schema: RunResponseSchema } },
    },
    400: { description: "Bad request", content: { "application/json": { schema: ErrorSchema } } },
    404: {
      description: "Workflow not found",
      content: { "application/json": { schema: ErrorSchema } },
    },
  },
});

function serializeExec(row: typeof executions.$inferSelect) {
  return {
    id: row.id,
    workflow_id: row.workflow_id ?? null,
    workflow_version_id: row.workflow_version_id ?? null,
    source_kind: (row.source_kind as "saved" | "draft" | "step") ?? "saved",
    source_ref: row.source_ref ?? null,
    status: row.status,
    request_source: row.request_source,
    parent_execution_id: row.parent_execution_id ?? null,
    started_at: row.started_at ? row.started_at.toISOString() : null,
    finished_at: row.finished_at ? row.finished_at.toISOString() : null,
    created_at: row.created_at.toISOString(),
  };
}

function serializeStep(row: typeof executionSteps.$inferSelect) {
  return {
    id: row.id,
    step_key: row.step_key,
    step_index: row.step_index ?? null,
    kind: row.kind,
    status: row.status,
    duration_ms: row.duration_ms ?? null,
    retry_count: row.retry_count ?? 0,
    result_storage_uri: row.result_storage_uri ?? null,
    result_preview: row.result_preview ?? null,
    output_preview: row.output_preview ?? null,
    error: row.error ?? null,
    request_meta: row.request_meta ?? null,
    started_at: row.started_at ? row.started_at.toISOString() : null,
    finished_at: row.finished_at ? row.finished_at.toISOString() : null,
  };
}

export function registerExecutionRoutes(app: OpenAPIHono<AppEnv>): void {
  // RBAC: execution reads go through `execution:read`; cancel goes
  // through `execution:abort`. POST /v1/executions currently requires
  // `workflow:run` regardless of saved vs inline source. The SSE stream
  // is read-only.
  app.use("/v1/executions", async (c, next) => {
    if (c.req.method === "GET") return requirePermission("execution:read")(c, next);
    if (c.req.method === "POST") {
      // Resource-scoped RBAC: peek at body so a `workflow:run` grant on
      // the specific workflow id authorises the call. Hono caches the
      // parsed body so the handler re-reads cheaply.
      let workflowId: string | undefined;
      try {
        const body = (await c.req.json().catch(() => null)) as { workflow_id?: string } | null;
        workflowId = body?.workflow_id;
      } catch {
        // Body may be missing / invalid — fall through to the unscoped check.
      }
      if (workflowId) {
        const targetId = workflowId;
        return requirePermission("workflow:run", () => ({
          type: "workflow",
          id: targetId,
        }))(c, next);
      }
      return requirePermission("workflow:run")(c, next);
    }
    return next();
  });
  app.use("/v1/executions/:id", async (c, next) => {
    const id = c.req.param("id");
    if (c.req.method === "GET") {
      return requirePermission("execution:read", () => ({ type: "execution", id }))(c, next);
    }
    return next();
  });
  app.use("/v1/executions/:id/steps", async (c, next) => {
    const id = c.req.param("id");
    return requirePermission("execution:read", () => ({ type: "execution", id }))(c, next);
  });
  app.use("/v1/executions/:id/cancel", async (c, next) => {
    const id = c.req.param("id");
    return requirePermission("execution:abort", () => ({ type: "execution", id }))(c, next);
  });
  app.use("/v1/executions/:id/stream", async (c, next) => {
    const id = c.req.param("id");
    return requirePermission("execution:read", () => ({ type: "execution", id }))(c, next);
  });

  app.openapi(runExecutionRoute, async (c) => {
    const principal = requireAuth(c);
    const db = c.get("db");
    const runtimeBody = RuntimeRunBodySchema.safeParse(c.req.valid("json"));
    if (!runtimeBody.success) {
      throw new BadRequestError("request validation failed", {
        code: "bad_request",
        details: runtimeBody.error.flatten(),
      });
    }
    const body = runtimeBody.data;
    await enforceWorkflowAllowlist(principal, body, db);

    // Resolve execution_mode from the `x-subkit-environment` header.
    const envHeader = c.req.header("x-subkit-environment");
    let execution_mode: ExecutionMode = "dev";
    if (envHeader === "dev" || envHeader === "prod") execution_mode = envHeader;

    let source: RunExecutionSource;
    if (body.source === "saved") {
      source = {
        kind: "saved",
        workflow_id: body.workflow_id,
        ...(body.version_id ? { version_id: body.version_id } : {}),
      };
    } else if (body.source === "draft") {
      source = {
        kind: "draft",
        definition: body.definition,
        ...(body.name ? { name: body.name } : {}),
      };
    } else {
      source = {
        kind: "step",
        step: body.step,
        ...(body.workflow_slug ? { workflow_slug: body.workflow_slug } : {}),
      };
    }

    if (body.source === "saved" && body.async) {
      const resolved = await resolveDefinition(db, principal.tenant_id, source);
      const execution_id = await createExecution(db, {
        tenant_id: principal.tenant_id,
        workflow_id: resolved.workflow_id,
        workflow_version_id: resolved.workflow_version_id,
        source_kind: "saved",
        source_ref: null,
        request_source: body.request_source ?? "api",
        parent_execution_id: null,
        execution_mode,
      });
      const trace_id = c.get("trace_id") ?? null;
      const job: ExecutionRunJob = {
        tenant_id: principal.tenant_id,
        workflow_id: resolved.workflow_id,
        execution_id,
        input: body.input ?? null,
        request_source: body.request_source ?? "api",
        trace_id,
        execution_mode,
      };
      await getBoss().send(EXECUTION_RUN_QUEUE, job);
      return c.json(
        {
          execution_id,
          status: "queued",
        },
        202,
      );
    }

    try {
      const result = await runExecution({
        db,
        tenant_id: principal.tenant_id,
        source,
        input: "input" in body ? (body.input ?? null) : null,
        options: {
          request_source: body.request_source ?? "api",
          principal,
          execution_mode,
        },
      });
      // Cast through `any` for the response body: step.request_meta
      // is a driver-discriminated union (see RequestMeta) and the
      // OpenAPI Zod schema declares the looser `unknown` shape, so
      // structural compatibility holds at runtime but the OpenAPI
      // type system requires the cast.
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
          // biome-ignore lint/suspicious/noExplicitAny: union vs unknown widening at the OpenAPI boundary
        } as any,
        200,
      );
    } catch (err) {
      const code = (err as { code?: string }).code;
      const details = (err as { details?: unknown }).details;
      if (
        code === "input_schema_violation" ||
        code === "draft_invalid" ||
        code === "step_invalid"
      ) {
        throw new BadRequestError((err as Error).message, {
          code,
          ...(details ? { details } : {}),
        });
      }
      if ((err as Error).message?.startsWith("workflow not found")) {
        throw new NotFoundError("workflow");
      }
      throw err;
    }
  });

  app.openapi(listExecutionsRoute, async (c) => {
    const principal = requireAuth(c);
    const db = c.get("db");
    const q = c.req.valid("query");
    const conds = [eq(executions.tenant_id, principal.tenant_id)];
    if (q.workflow_id) conds.push(eq(executions.workflow_id, q.workflow_id));
    if (q.status)
      conds.push(eq(executions.status, q.status as typeof executions.$inferSelect.status));
    if (q.request_source) conds.push(eq(executions.request_source, q.request_source));
    const rows = await db
      .select()
      .from(executions)
      .where(and(...conds))
      .orderBy(desc(executions.created_at))
      .limit(q.limit ?? 50);
    return c.json({ items: rows.map(serializeExec) }, 200);
  });

  app.openapi(getExecutionRoute, async (c) => {
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
    return c.json(serializeExec(row), 200);
  });

  app.openapi(getStepsRoute, async (c) => {
    const principal = requireAuth(c);
    const db = c.get("db");
    const { id } = c.req.valid("param");
    const rows = await db
      .select()
      .from(executionSteps)
      .where(
        and(eq(executionSteps.tenant_id, principal.tenant_id), eq(executionSteps.execution_id, id)),
      )
      .orderBy(asc(executionSteps.started_at));
    return c.json({ items: rows.map(serializeStep) }, 200);
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
        const { getBoss } = await import("../../queue/boss.ts");
        const boss = getBoss();
        // We don't track the job id per execution — cancel by data match
        // using findJobs + cancel. If pg-boss isn't started yet (e.g.
        // tests), the dynamic import still returns; getBoss() throws,
        // which we swallow.
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

async function enforceWorkflowAllowlist(
  principal: ResolvedPrincipal,
  body: z.infer<typeof RuntimeRunBodySchema>,
  db: AppEnv["Variables"]["db"],
): Promise<void> {
  if (body.source !== "saved") return;
  if (!principal.roles?.includes("enduser")) return;

  const allow = principal.allowed_workflows;
  const permitted = allow === "all" || (Array.isArray(allow) && allow.includes(body.workflow_id));
  if (permitted) return;

  try {
    await auditAwait(
      {
        tenant_id: principal.tenant_id,
        actor_type: principal.kind,
        actor_id: principal.id,
        action: AuditAction.POLICY_DENIED,
        resource_type: "workflow",
        resource_id: body.workflow_id,
        result: "denied",
        reason: "workflow_not_in_allowlist",
        metadata: {
          route_action: "workflow.run",
          allowed_workflows: Array.isArray(allow) ? allow : (allow ?? null),
        },
      },
      db,
    );
  } catch {
    // Preserve the deny even if audit persistence fails.
  }

  throw new ForbiddenError("workflow_not_in_allowlist");
}
