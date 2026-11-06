import { createRoute, type OpenAPIHono, z } from "@hono/zod-openapi";
import { and, eq } from "drizzle-orm";
import { ErrorSchema, IdParam } from "../../../api/common-schemas.ts";
import { actorType } from "../../../audit/index.ts";
import { executions } from "../../../db/schema/index.ts";
import type { ExecutionMode } from "../../../execution/index.ts";
import {
  auditAdmissionRefusal,
  authorizeSensitiveResume,
  executionVisibilityFilter,
  isSensitivePayload,
  loadRerunSafety,
  recoverExecutionPayload,
  runWorkflow,
} from "../../../execution/index.ts";
import { getBoss } from "../../../queue/index.ts";
import { HttpError, NotFoundError } from "../../errors.ts";
import { requireAuth } from "../../middleware/auth.ts";
import { requirePermission } from "../../middleware/require-permission.ts";
import type { AppEnv } from "../../openapi.ts";
import { admissionRefusal } from "./admission-errors.ts";
import {
  enforceAsyncAuthentication,
  enforceSavedWorkflowAllowlist,
  refusalResponse,
  runRequestSource,
} from "./run.ts";
import {
  CallerBudgetRefusalSchema,
  ClientDeclaredRunSourceSchema,
  RunResponseSchema,
} from "./schemas.ts";

const RerunBody = z
  .object({
    input: z.unknown().optional(),
    async: z.boolean().optional(),
    hold_writes: z.boolean().optional(),
    execution_authority_id: z.string().uuid().optional(),
    idempotency_key: z.string().min(1).max(200).optional(),
    request_source: ClientDeclaredRunSourceSchema,
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
    400: {
      description:
        'Bad request or unsupported asynchronous authentication source. A workflow input part above its declared byte limit or an invalid caller budget unit answers `{error:"invalid", code:"invalid"}`.',
      content: { "application/json": { schema: ErrorSchema.or(CallerBudgetRefusalSchema) } },
    },
    403: {
      description: "The caller is not authorized to rerun this execution",
      content: { "application/json": { schema: ErrorSchema } },
    },
    404: { description: "Not found", content: { "application/json": { schema: ErrorSchema } } },
    409: {
      description:
        'Original execution is not rerunnable, or the rerun was refused before it started. `prepared_credential_unavailable` carries `details` naming `step_id`, `connector_id` (as resolved in the environment), `connector_slug`, `connector_name`, `environment`, `reason` (missing | disabled | needs_reauth | credential_unavailable | too_many_references) and, when a row was created, `execution_id`. Another call of the same caller budget unit is still queued or running without a cancel request: `{error:"turn-busy", code:"turn_busy"}` without `execution_id`; that call keeps running. Nothing was reserved.',
      content: { "application/json": { schema: ErrorSchema.or(CallerBudgetRefusalSchema) } },
    },
    429: {
      description:
        'The workflow\'s caller daily limit is reached (`{error:"rate-limited", code:"rate_limited", usage}`) or the turn has used all of its metered calls (`{error:"turn-limit", code:"turn_limit"}`). Nothing was reserved.',
      content: { "application/json": { schema: CallerBudgetRefusalSchema } },
    },
  },
});

export function registerRerunRoute(app: OpenAPIHono<AppEnv>): void {
  app.use("/v1/executions/:id/rerun", async (c, next) => {
    const id = c.req.param("id");
    const principal = c.get("principal");
    const db = c.get("db");
    if (principal && db) {
      const rows = await db
        .select({ workflow_id: executions.workflow_id })
        .from(executions)
        .where(
          and(
            eq(executions.tenant_id, principal.tenant_id),
            eq(executions.id, id),
            executionVisibilityFilter(principal),
          ),
        )
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
    if (body.async) enforceAsyncAuthentication(principal);

    const rows = await db
      .select()
      .from(executions)
      .where(
        and(
          eq(executions.tenant_id, principal.tenant_id),
          eq(executions.id, id),
          executionVisibilityFilter(principal),
        ),
      )
      .limit(1);
    const original = rows[0];
    if (!original) throw new NotFoundError("execution");
    if (original.source_kind !== "saved" || !original.workflow_id) {
      throw new HttpError(
        409,
        "conflict",
        `execution has source_kind='${original.source_kind}' — only saved-workflow executions can be rerun`,
        {
          hint: "draft and step runs carry their definition in the original request — re-POST it to POST /v1/executions (sk workflows run --draft/--step)",
        },
      );
    }

    const safety = await loadRerunSafety(db, principal.tenant_id, original);
    const forcedHoldWrites = safety.mode !== "repeat_safe";

    await enforceSavedWorkflowAllowlist(principal, original.workflow_id, db);

    const request_source = runRequestSource(c, body.request_source);
    if (isSensitivePayload(original.input)) {
      try {
        await authorizeSensitiveResume(db, original, principal);
      } catch (error) {
        return admissionRefusal(error, {
          db,
          principal,
          workflow_id: original.workflow_id,
          request_source,
          execution_id: original.id,
        });
      }
    }
    const input =
      body.input !== undefined
        ? body.input
        : recoverExecutionPayload(original.input, principal.tenant_id, original.id);
    const execution_mode: ExecutionMode = original.execution_mode ?? "dev";

    if (!original.workflow_version_id) {
      const message = "the original version is unavailable";
      await auditAdmissionRefusal(
        {
          tenant_id: principal.tenant_id,
          reason: "workflow_version_unavailable",
          message,
          workflow_id: original.workflow_id,
          request_source,
          actor_id: principal.id ?? null,
          actor_type: actorType(principal),
          extra: { rerun_of: original.id },
        },
        db,
      );
      throw new HttpError(409, "workflow_version_unavailable", message);
    }
    const outcome = await runWorkflow(
      {
        principal,
        workflow_id: original.workflow_id,
        workflow_version_id: original.workflow_version_id,
        execution_authority_id: body.execution_authority_id,
        hold_writes: forcedHoldWrites ? true : body.hold_writes,
        idempotency_key: body.idempotency_key,
        request_source,
        parent_execution_id: original.id,
        execution_environment: execution_mode,
        input,
        authorization: {
          kind: "granted",
          workflow_permission: c.get("workflow_permission") ?? null,
        },
        audit_extra: { rerun_of: original.id },
        dispatch: body.async
          ? {
              mode: "enqueue",
              boss: c.get("boss") ?? getBoss(),
              trace_id: c.get("trace_id") ?? null,
            }
          : { mode: "inline", refusal_answered_to_caller: true },
      },
      { db },
    );
    if (outcome.kind === "rejected") return refusalResponse(c, outcome, principal) as never;
    if (outcome.kind === "enqueue_failed") throw outcome.error;
    const admitted = outcome.admitted;
    const execution_id = admitted.execution_id;
    if (outcome.kind === "replayed") {
      return c.json(
        { execution_id, status: admitted.status, idempotent_replay: true },
        admitted.status === "running" ? 202 : 200,
      );
    }
    if (outcome.kind !== "completed") {
      return c.json({ execution_id, status: "queued", hold_writes: admitted.hold_writes }, 202);
    }
    const result = outcome.result;
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
