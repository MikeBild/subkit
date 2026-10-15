import { createRoute, type OpenAPIHono, z } from "@hono/zod-openapi";
import type { Context } from "hono";
import { ErrorSchema } from "../../../api/common-schemas.ts";
import { AuditAction, actorType, auditAwait, readRequestSource } from "../../../audit/index.ts";
import type { ResolvedPrincipal } from "../../../auth/index.ts";
import { getConfig, isConfigLoaded } from "../../../config/loader.ts";
import type { ExecutionMode } from "../../../execution/index.ts";
import {
  admitWorkflowRun,
  assertCallerExecutionSource,
  assertExecutionAuthorityCurrent,
  auditAdmissionRefusal,
  authorizationContextFromPrincipal,
  finalizeExecution,
  type RunExecutionSource,
  runExecution,
} from "../../../execution/index.ts";
import type { RequestSource } from "../../../observability/index.ts";
import type { ExecutionRunJob } from "../../../queue/index.ts";
import { EXECUTION_RUN_QUEUE, getBoss } from "../../../queue/index.ts";
import { normalizeWorkflowRunInput } from "../../../workflows/index.ts";
import { BadRequestError, HttpError, NotFoundError } from "../../errors.ts";
import { requireAuth } from "../../middleware/auth.ts";
import { requirePermission } from "../../middleware/require-permission.ts";
import type { AppEnv } from "../../openapi.ts";
import { admissionRefusal, callerBudgetRefusal } from "./admission-errors.ts";
import {
  type ClientDeclaredRunSource,
  RunBodySchema,
  RunResponseSchema,
  RuntimeRunBodySchema,
} from "./schemas.ts";

const CallerBudgetRefusalSchema = z
  .object({
    error: z.enum(["rate-limited", "busy", "turn-limit", "invalid"]),
    code: z.enum(["rate_limited", "turn_busy", "turn_limit", "invalid"]),
    message: z.string(),
    usage: z.object({ usedToday: z.number().int(), dailyLimit: z.number().int() }).optional(),
  })
  .openapi("CallerBudgetRefusal");

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
    400: {
      description:
        'Bad request. A workflow input part above its declared byte limit answers `{error:"invalid", code:"invalid"}`.',
      content: { "application/json": { schema: ErrorSchema.or(CallerBudgetRefusalSchema) } },
    },
    403: {
      description:
        "Caller identity or workflow permission does not allow this run. A product principal also gets 403 when the workflow has no live execution authority, no active version or no usable prepared credential, and when it asks for a held preparation; its runs are never downgraded to a preparation.",
      content: { "application/json": { schema: ErrorSchema } },
    },
    404: {
      description: "Workflow not found",
      content: { "application/json": { schema: ErrorSchema } },
    },
    409: {
      description:
        "Refused before the run started: the workflow version, execution authority, replay boundary, or sensitive execution mode is unavailable. For `prepared_credential_unavailable`, `details` names the connector and reason; when a row was created, it includes `execution_id`.",
      content: { "application/json": { schema: ErrorSchema } },
    },
    429: {
      description:
        'The workflow\'s caller daily limit is reached (`{error:"rate-limited", code:"rate_limited", usage}`), the turn has used all of its metered calls (`{error:"turn-limit", code:"turn_limit"}`) or another call of the same turn is still queued or running without a cancel request (`{error:"busy", code:"turn_busy"}`). Nothing was reserved.',
      content: { "application/json": { schema: CallerBudgetRefusalSchema } },
    },
  },
});

export async function enforceSavedWorkflowAllowlist(
  principal: ResolvedPrincipal,
  workflow_id: string,
  db: AppEnv["Variables"]["db"],
): Promise<void> {
  if (!principal.roles?.includes("enduser")) return;

  const allow = principal.allowed_workflows;
  const permitted = allow === "all" || (Array.isArray(allow) && allow.includes(workflow_id));
  if (permitted) return;

  try {
    await auditAwait(
      {
        tenant_id: principal.tenant_id,
        actor_type: principal.kind,
        actor_id: principal.id,
        action: AuditAction.POLICY_DENIED,
        resource_type: "workflow",
        resource_id: workflow_id,
        result: "denied",
        reason: "workflow_not_in_allowlist",
        metadata: {
          route_action: "workflow.run",
          allowed_workflows: Array.isArray(allow) ? allow : (allow ?? null),
        },
      },
      db,
    );
  } catch {}

  throw new HttpError(403, "forbidden", "workflow_not_in_allowlist", {
    hint: "your account's allowed_workflows grant does not include this workflow — ask an operator to add it (sk rbac / api-key allowed_workflows) or run a workflow you are granted",
  });
}

function productEnvironment(principal: ResolvedPrincipal): ExecutionMode | null {
  if (!principal.product_id || !isConfigLoaded()) return null;
  return getConfig().products[principal.product_id]?.execution_environment ?? null;
}

export function runRequestSource(c: Context, declared?: ClientDeclaredRunSource): RequestSource {
  const verified = readRequestSource(c) ?? "api";
  if (verified !== "api") return verified;
  const heldByKey = Boolean(c.get("principal")?.api_key_id);
  return heldByKey ? (declared ?? "api") : "api";
}

export function enforceAsyncAuthentication(principal: ResolvedPrincipal): void {
  if (authorizationContextFromPrincipal(principal)) return;
  throw new HttpError(
    400,
    "execution_authentication_unsupported",
    "This authentication source does not support asynchronous execution.",
  );
}

async function enforceWorkflowAllowlist(
  principal: ResolvedPrincipal,
  body: z.infer<typeof RuntimeRunBodySchema>,
  db: AppEnv["Variables"]["db"],
): Promise<void> {
  if (body.source !== "saved") return;
  return enforceSavedWorkflowAllowlist(principal, body.workflow_id, db);
}

export function registerRunRoute(app: OpenAPIHono<AppEnv>): void {
  app.use("/v1/executions", async (c, next) => {
    if (c.req.method === "GET") return requirePermission("execution:read")(c, next);
    if (c.req.method === "POST") {
      let workflowId: string | undefined;
      try {
        const savedTarget = z
          .object({ source: z.literal("saved").optional(), workflow_id: z.string().uuid() })
          .safeParse(await c.req.json().catch(() => null));
        workflowId = savedTarget.success ? savedTarget.data.workflow_id : undefined;
      } catch {}
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
    const request_source = runRequestSource(c, body.request_source);
    try {
      assertCallerExecutionSource(principal, body.source);
    } catch (error) {
      return admissionRefusal(error, { db, principal, request_source });
    }
    if (body.source === "saved" && body.async) enforceAsyncAuthentication(principal);
    await enforceWorkflowAllowlist(principal, body, db);

    const idempotencyKey =
      body.source === "saved"
        ? (body.idempotency_key ?? c.req.header("idempotency-key")?.trim() ?? null)
        : null;
    if (idempotencyKey !== null && (idempotencyKey.length < 1 || idempotencyKey.length > 200)) {
      throw new BadRequestError("idempotency_key must be 1..200 characters", {
        code: "bad_request",
      });
    }

    const envHeader = c.req.header("x-subkit-environment");
    let execution_mode: ExecutionMode = productEnvironment(principal) ?? "dev";
    if (!principal.product_id && (envHeader === "dev" || envHeader === "prod"))
      execution_mode = envHeader;

    if (body.source === "saved") {
      if (principal.product_id && body.hold_writes === true)
        throw new HttpError(
          403,
          "product_preparation_forbidden",
          "A product caller runs only under a live execution authority; held preparations are for operators.",
        );
      const holdWrites = principal.product_id ? false : body.hold_writes;
      if (body.async && body.execution_authority_id && !idempotencyKey) {
        throw new BadRequestError(
          "An authorized async run requires an idempotency_key so queue retries reuse its reservation",
          {
            code: "bad_request",
          },
        );
      }
      let admitted: Awaited<ReturnType<typeof admitWorkflowRun>>;
      try {
        admitted = await admitWorkflowRun(
          {
            tenant_id: principal.tenant_id,
            workflow_id: body.workflow_id,
            workflow_version_id: body.version_id,
            execution_authority_id: body.execution_authority_id,
            execution_environment: execution_mode,
            request_source,
            input: body.input,
            idempotency_key: idempotencyKey ?? undefined,
            hold_writes: holdWrites,
          },
          db,
          principal,
          c.get("workflow_permission"),
        );
        if (body.async && admitted.status === "queued" && admitted.execution_authority_id) {
          await assertExecutionAuthorityCurrent(db, principal.tenant_id, admitted.execution_id);
        }
      } catch (error) {
        const budgetRefusal = await callerBudgetRefusal(c, error, {
          db,
          principal,
          workflow_id: body.workflow_id,
          request_source,
        });
        if (budgetRefusal) return budgetRefusal as never;
        return admissionRefusal(error, {
          db,
          principal,
          workflow_id: body.workflow_id,
          request_source,
        });
      }
      if ("downgraded_from" in admitted && admitted.downgraded_from) {
        await auditAdmissionRefusal(
          {
            tenant_id: principal.tenant_id,
            reason: admitted.downgraded_from.code,
            message: admitted.downgraded_from.message,
            workflow_id: body.workflow_id,
            execution_id: admitted.execution_id,
            request_source,
            actor_id: principal.id,
            actor_type: actorType(principal),
            extra: { downgraded_to_preparation: true },
          },
          db,
        );
      }
      if (admitted.replayed && admitted.status !== "queued") {
        return c.json(
          {
            execution_id: admitted.execution_id,
            status: admitted.status,
            idempotent_replay: true,
            hold_writes: admitted.hold_writes,
          },
          admitted.status === "running" ? 202 : 200,
        );
      }
      if (body.async) {
        try {
          await (c.get("boss") ?? getBoss()).send(
            EXECUTION_RUN_QUEUE,
            {
              tenant_id: principal.tenant_id,
              workflow_id: body.workflow_id,
              execution_id: admitted.execution_id,
              request_source,
              trace_id: c.get("trace_id") ?? null,
              execution_mode,
            } satisfies ExecutionRunJob,
            { id: admitted.execution_id },
          );
        } catch (error) {
          if (!idempotencyKey)
            await finalizeExecution(
              db,
              principal.tenant_id,
              admitted.execution_id,
              "failed",
              null,
              {
                step_id: null,
                error_code: "enqueue_failed",
                error_message: "The execution could not be enqueued.",
              },
            );
          throw error;
        }
        return c.json(
          {
            execution_id: admitted.execution_id,
            status: "queued",
            hold_writes: admitted.hold_writes,
            ...(admitted.replayed ? { idempotent_replay: true } : {}),
          },
          202,
        );
      }
      let result: Awaited<ReturnType<typeof runExecution>>;
      try {
        result = await runExecution({
          db,
          tenant_id: principal.tenant_id,
          refusal_answered_to_caller: true,
          source: {
            kind: "saved",
            workflow_id: body.workflow_id,
            version_id: admitted.workflow_version_id,
          },
          input: admitted.input,
          options: {
            existing_execution_id: admitted.execution_id,
            principal,
            execution_mode,
            request_source,
          },
        });
      } catch (error) {
        return admissionRefusal(error, {
          db,
          principal,
          workflow_id: body.workflow_id,
          request_source,
          execution_id: admitted.execution_id,
        });
      }
      return c.json(
        {
          ...result,
          hold_writes: admitted.hold_writes,
          ...(admitted.replayed ? { idempotent_replay: true } : {}),
        },
        200,
      );
    }

    let source: RunExecutionSource;
    if (body.source === "draft") {
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

    try {
      const result = await runExecution({
        db,
        tenant_id: principal.tenant_id,
        source,
        input:
          normalizeWorkflowRunInput(
            body.input,
            body.source === "draft" ? body.definition.input_schema : undefined,
          ) ?? null,
        options: {
          request_source,
          principal,
          execution_mode,
          idempotency_key: idempotencyKey,
          hold_writes: true,
          self_healing: { enabled: false },
        },
      });
      return c.json(
        {
          execution_id: result.execution_id,
          hold_writes: true,
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
    } catch (err) {
      const code = (err as { code?: string }).code;
      const details = (err as { details?: unknown }).details;
      if (
        code === "input_schema_violation" ||
        code === "draft_invalid" ||
        code === "step_invalid"
      ) {
        throw new HttpError(400, "bad_request", (err as Error).message, {
          details: {
            code,
            ...(details ? { details } : {}),
          },
        });
      }
      if ((err as Error).message?.startsWith("workflow not found")) {
        throw new NotFoundError("workflow");
      }
      throw err;
    }
  });
}
