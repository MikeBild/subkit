import { createRoute, type OpenAPIHono, z } from "@hono/zod-openapi";
import type { Context } from "hono";
import { ErrorSchema } from "../../../api/common-schemas.ts";
import { AuditAction, auditAwait, readRequestSource } from "../../../audit/index.ts";
import type { ResolvedPrincipal } from "../../../auth/index.ts";
import {
  assertCallerExecutionSource,
  authorizationContextFromPrincipal,
  callerFromPrincipal,
  isBearerProductPrincipal,
  principalExecutionEnvironment,
  type RunExecutionSource,
  type RunRefusal,
  runExecution,
  runWorkflow,
} from "../../../execution/index.ts";
import { logger } from "../../../logging/index.ts";
import type { RequestSource } from "../../../observability/index.ts";
import { getBoss } from "../../../queue/index.ts";
import { normalizeWorkflowRunInput } from "../../../workflows/index.ts";
import { BadRequestError, HttpError, NotFoundError } from "../../errors.ts";
import { requireAuth } from "../../middleware/auth.ts";
import { requirePermission } from "../../middleware/require-permission.ts";
import type { AppEnv } from "../../openapi.ts";
import { admissionRefusal } from "./admission-errors.ts";
import {
  CallerBudgetRefusalSchema,
  type ClientDeclaredRunSource,
  RunBodySchema,
  RunResponseSchema,
  RuntimeRunBodySchema,
} from "./schemas.ts";

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
      description:
        'Run queued or started. A single step (`source: "step"`) always answers 202 with `execution_id` as soon as the run has started; read the result from `GET /v1/executions/{id}` and stop it with `POST /v1/executions/{id}/cancel`.',
      content: { "application/json": { schema: RunResponseSchema } },
    },
    400: {
      description:
        'Bad request. A workflow input part above its declared byte limit answers `{error:"invalid", code:"invalid"}`.',
      content: { "application/json": { schema: ErrorSchema.or(CallerBudgetRefusalSchema) } },
    },
    403: {
      description:
        "Caller identity or workflow permission does not allow this run. A product principal verified by an oidc_bearer provider also gets 403 when the workflow has no live execution authority, no active version or no usable prepared credential, and when it asks for a held preparation; its runs are never downgraded to a preparation.",
      content: { "application/json": { schema: ErrorSchema } },
    },
    404: {
      description: "Workflow not found",
      content: { "application/json": { schema: ErrorSchema } },
    },
    409: {
      description:
        'Refused before the run started: the workflow version, execution authority, replay boundary, or sensitive execution mode is unavailable. For `prepared_credential_unavailable`, `details` names the connector and reason; when a row was created, it includes `execution_id`. Another call of the same caller budget unit is still queued or running without a cancel request: `{error:"turn-busy", code:"turn_busy"}` without `execution_id`; that call keeps running, and repeating the request with the same `idempotency_key` replays it. Nothing was reserved.',
      content: { "application/json": { schema: ErrorSchema.or(CallerBudgetRefusalSchema) } },
    },
    429: {
      description:
        'The workflow\'s caller daily limit is reached (`{error:"rate-limited", code:"rate_limited", usage}`) or the turn has used all of its metered calls (`{error:"turn-limit", code:"turn_limit"}`). Nothing was reserved.',
      content: { "application/json": { schema: CallerBudgetRefusalSchema } },
    },
  },
});

function startInBackground(run: Parameters<typeof runExecution>[0]): Promise<string> {
  return new Promise<string>((resolve, reject) => {
    runExecution({ ...run, on_started: resolve }).then(
      (result) => resolve(result.execution_id),
      (error: unknown) => {
        reject(error);
        logger.warn({
          module: "execution",
          action: "execution.step_run_failed",
          msg: "a single-step run ended with an error",
          error: error instanceof Error ? error.message : String(error),
        });
      },
    );
  });
}

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
    hint: "your account's allowed_workflows grant does not include this workflow — ask an operator to add it (subkit rbac / api-key allowed_workflows) or run a workflow you are granted",
  });
}

const callerBudgetStatuses = {
  rate_limited: { status: 429, error: "rate-limited" },
  turn_busy: { status: 409, error: "turn-busy" },
  turn_limit: { status: 429, error: "turn-limit" },
  invalid: { status: 400, error: "invalid" },
} as const;

function refusalDetails(refusal: RunRefusal): Record<string, unknown> | undefined {
  const raw = refusal.details;
  const execution = refusal.execution_id ? { execution_id: refusal.execution_id } : undefined;
  return raw && typeof raw === "object" && !Array.isArray(raw)
    ? { ...(raw as Record<string, unknown>), ...execution }
    : execution;
}

export function refusalResponse(
  c: Context,
  refusal: RunRefusal,
  principal: ResolvedPrincipal,
): Response {
  switch (refusal.refusal) {
    case "not_found":
      throw new NotFoundError("workflow");
    case "input":
      throw new HttpError(400, refusal.code, refusal.message);
    case "bad_request":
      throw new BadRequestError(refusal.message, { code: "bad_request" });
    case "preparation_forbidden":
    case "permission_denied":
      throw new HttpError(403, refusal.code, refusal.message);
    case "budget": {
      const status =
        callerBudgetStatuses[refusal.code as keyof typeof callerBudgetStatuses] ??
        callerBudgetStatuses.invalid;
      const usage = (refusal.details as { usage?: Record<string, unknown> } | undefined)?.usage;
      return c.json(
        {
          error: status.error,
          code: refusal.code,
          message: refusal.message,
          ...(usage ? { usage: { usedToday: usage.usedToday, dailyLimit: usage.dailyLimit } } : {}),
        },
        status.status,
      );
    }
    default: {
      const details = refusalDetails(refusal);
      const forbidden =
        refusal.refusal === "caller_forbidden" ||
        (refusal.refusal === "authority_unready" && isBearerProductPrincipal(principal));
      throw new HttpError(
        forbidden ? 403 : 409,
        refusal.code,
        refusal.message,
        details ? { details } : {},
      );
    }
  }
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
      if (body.source === "draft") {
        callerFromPrincipal(
          principal,
          principal.tenant_id,
          body.definition.product_id,
          body.definition.required_caller_kind,
        );
      }
    } catch (error) {
      return admissionRefusal(error, { db, principal, request_source });
    }
    if (body.source === "saved" && body.async) enforceAsyncAuthentication(principal);
    await enforceWorkflowAllowlist(principal, body, db);

    const requestedEnvironment = c.req.header("x-subkit-environment");
    const execution_mode = principalExecutionEnvironment(
      principal,
      requestedEnvironment === "dev" || requestedEnvironment === "prod"
        ? requestedEnvironment
        : null,
    );

    if (body.source === "saved") {
      const outcome = await runWorkflow(
        {
          principal,
          workflow_id: body.workflow_id,
          workflow_version_id: body.version_id,
          execution_authority_id: body.execution_authority_id,
          execution_environment: execution_mode,
          request_source,
          input: body.input,
          idempotency_key: body.idempotency_key ?? c.req.header("idempotency-key")?.trim() ?? null,
          hold_writes: body.hold_writes,
          authorization: {
            kind: "granted",
            workflow_permission: c.get("workflow_permission") ?? null,
          },
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
      if (outcome.kind === "replayed") {
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
      if (outcome.kind === "completed") {
        return c.json(
          {
            ...outcome.result,
            hold_writes: admitted.hold_writes,
            ...(admitted.replayed ? { idempotent_replay: true } : {}),
          },
          200,
        );
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
        ...(body.timeout_ms !== undefined ? { timeout_ms: body.timeout_ms } : {}),
      };
    }

    try {
      const run = {
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
          idempotency_key: null,
          hold_writes: true,
          self_healing: { enabled: false },
          ...(body.source === "step" && body.scope ? { initial_scope: body.scope } : {}),
        },
      };
      if (body.source === "step") {
        const execution_id = await startInBackground(run);
        return c.json({ execution_id, hold_writes: true, status: "running" }, 202);
      }
      const result = await runExecution(run);
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
