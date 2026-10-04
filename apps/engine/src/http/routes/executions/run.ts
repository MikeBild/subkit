// Run-side execution surface — POST /v1/executions.
//
// The single runtime entry point. Discriminated union over `source`:
//   • saved  → references a persisted workflow by id
//   • draft  → inline WorkflowDef, no commit required
//   • step   → single StepDef, one-step synthetic workflow

import { createRoute, type OpenAPIHono, z } from "@hono/zod-openapi";
import type { Context } from "hono";
import { ErrorSchema } from "../../../api/common-schemas.ts";
import { AuditAction, auditAwait, readRequestSource } from "../../../audit/index.ts";
import type { ResolvedPrincipal } from "../../../auth/index.ts";
import type { ExecutionMode } from "../../../execution/index.ts";
import {
  admitWorkflowRun,
  assertExecutionAuthorityCurrent,
  finalizeExecution,
  type RunExecutionSource,
  runExecution,
} from "../../../execution/index.ts";
import type { RequestSource } from "../../../observability/index.ts";
import type { ExecutionRunJob } from "../../../queue/index.ts";
import { EXECUTION_RUN_QUEUE, getBoss } from "../../../queue/index.ts";
import { BadRequestError, HttpError, NotFoundError } from "../../errors.ts";
import { requireAuth } from "../../middleware/auth.ts";
import { requirePermission } from "../../middleware/require-permission.ts";
import type { AppEnv } from "../../openapi.ts";
import { admissionRefusal } from "./admission-errors.ts";
import {
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
      description: "Run queued",
      content: { "application/json": { schema: RunResponseSchema } },
    },
    400: { description: "Bad request", content: { "application/json": { schema: ErrorSchema } } },
    404: {
      description: "Workflow not found",
      content: { "application/json": { schema: ErrorSchema } },
    },
    409: {
      description:
        "Refused before the run started: the execution authority or replay boundary no longer matches, or (`prepared_credential_unavailable`) a connector the run needs cannot serve it in this environment. `details` then names `step_id`, `connector_id` (as resolved in the environment), `connector_slug`, `connector_name`, `environment`, `reason` (missing | disabled | needs_reauth | credential_unavailable | too_many_references) and, when a row was created, `execution_id`.",
      content: { "application/json": { schema: ErrorSchema } },
    },
  },
});

/** Enduser allowlist gate for saved-workflow runs. Shared with the
 *  rerun route (rerun.ts), which targets the original execution's
 *  workflow. */
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
  } catch {
    // Preserve the deny even if audit persistence fails.
  }

  throw new HttpError(403, "forbidden", "workflow_not_in_allowlist", {
    hint: "your account's allowed_workflows grant does not include this workflow — ask an operator to add it (sk rbac / api-key allowed_workflows) or run a workflow you are granted",
  });
}

/** The origin a run started over HTTP is recorded under. It comes from who
 *  authenticated the request — a verified cockpit session is "ui" — never
 *  from what the body claims. Only when the context says no more than "a key
 *  called the API" may the caller name the program holding it ("cli") — and
 *  only when the credential really is an API key. An MCP OAuth token or a
 *  browser session without the cockpit header also reads as "api" here, and
 *  none of them is the CLI; letting them say so would put a label on a run
 *  that no credential behind it can back. Shared with the rerun route. */
export function runRequestSource(c: Context, declared?: ClientDeclaredRunSource): RequestSource {
  const verified = readRequestSource(c) ?? "api";
  if (verified !== "api") return verified;
  const heldByKey = Boolean(c.get("principal")?.api_key_id);
  return heldByKey ? (declared ?? "api") : "api";
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
  // Run-side RBAC: read for the index isn't relevant here, but POST
  // gates per-tenant `workflow:run`, with resource-scoped grant when
  // the body carries a workflow_id.
  app.use("/v1/executions", async (c, next) => {
    if (c.req.method === "GET") return requirePermission("execution:read")(c, next);
    if (c.req.method === "POST") {
      let workflowId: string | undefined;
      try {
        const savedTarget = z
          .object({ source: z.literal("saved"), workflow_id: z.string().uuid() })
          .safeParse(await c.req.json().catch(() => null));
        // A resource grant authorizes that saved workflow only. Inline bodies
        // must not borrow it through an otherwise ignored workflow_id field.
        workflowId = savedTarget.success ? savedTarget.data.workflow_id : undefined;
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
    const request_source = runRequestSource(c, body.request_source);

    // Both live reservations and preparation replays validate the full stored
    // boundary. A known key alone must not release a different workflow.
    const idempotencyKey =
      body.source === "saved"
        ? (body.idempotency_key ?? c.req.header("idempotency-key")?.trim() ?? null)
        : null;
    if (idempotencyKey !== null && (idempotencyKey.length < 1 || idempotencyKey.length > 200)) {
      throw new BadRequestError("idempotency_key must be 1..200 characters", {
        code: "bad_request",
      });
    }

    // Resolve execution_mode from the `x-subkit-environment` header.
    const envHeader = c.req.header("x-subkit-environment");
    let execution_mode: ExecutionMode = "dev";
    if (envHeader === "dev" || envHeader === "prod") execution_mode = envHeader;

    if (body.source === "saved") {
      if (body.async && body.execution_authority_id && !idempotencyKey) {
        throw new BadRequestError(
          "An authorized async run requires an idempotency_key so queue retries reuse its reservation",
          {
            code: "bad_request",
          },
        );
      }
      // Authorization is product-local: the id selects a stored human grant,
      // not a claim from the calling agent. Admission reserves atomically and
      // validates idempotent retries against the original complete boundary.
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
            input: body.input ?? null,
            idempotency_key: idempotencyKey ?? undefined,
            hold_writes: body.hold_writes,
          },
          db,
        );
        if (body.async && admitted.status === "queued" && admitted.execution_authority_id) {
          await assertExecutionAuthorityCurrent(db, principal.tenant_id, admitted.execution_id);
        }
      } catch (error) {
        return admissionRefusal(error, {
          db,
          principal,
          workflow_id: body.workflow_id,
          request_source,
        });
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
        // A queue outage leaves the SAME reserved run retryable. Re-enqueueing
        // never spends another allowance; worker startup claims queued rows.
        try {
          await (c.get("boss") ?? getBoss()).send(
            EXECUTION_RUN_QUEUE,
            {
              tenant_id: principal.tenant_id,
              workflow_id: body.workflow_id,
              execution_id: admitted.execution_id,
              input: admitted.input,
              request_source,
              trace_id: c.get("trace_id") ?? null,
              execution_mode,
            } satisfies ExecutionRunJob,
            { id: admitted.execution_id },
          );
        } catch (error) {
          // Without a caller key there is no safe retry handle. Do not strand
          // an undiscoverable queued row; a reservation is never refunded.
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
      // A refusal before the first step — a connector the prepared run cannot
      // use — is the same kind of answer as one at admission: a 409 that
      // names what to fix, never a 500. The engine has already failed the row.
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
        input: "input" in body ? (body.input ?? null) : null,
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
