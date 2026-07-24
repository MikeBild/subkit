// Run-side execution surface — POST /v1/executions.
//
// The single runtime entry point. Discriminated union over `source`:
//   • saved  → references a persisted workflow by id
//   • draft  → inline WorkflowDef, no commit required
//   • step   → single StepDef, one-step synthetic workflow

import { createRoute, type OpenAPIHono, z } from "@hono/zod-openapi";
import { ErrorSchema } from "../../../api/common-schemas.ts";
import { AuditAction, auditAwait } from "../../../audit/index.ts";
import type { ResolvedPrincipal } from "../../../auth/index.ts";
import type { ExecutionMode } from "../../../execution/index.ts";
import {
  createExecution,
  finalizeExecution,
  type RunExecutionSource,
  resolveDefinition,
  runExecution,
} from "../../../execution/index.ts";
import type { ExecutionRunJob } from "../../../queue/index.ts";
import { EXECUTION_RUN_QUEUE, getBoss } from "../../../queue/index.ts";
import { BadRequestError, HttpError, NotFoundError } from "../../errors.ts";
import { requireAuth } from "../../middleware/auth.ts";
import { requirePermission } from "../../middleware/require-permission.ts";
import type { AppEnv } from "../../openapi.ts";
import { RunBodySchema, RunResponseSchema, RuntimeRunBodySchema } from "./schemas.ts";

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

  throw HttpError.withEnvelope(403, "forbidden", "workflow_not_in_allowlist", {
    hint: "your account's allowed_workflows grant does not include this workflow — ask an operator to add it (sk rbac / api-key allowed_workflows) or run a workflow you are granted",
  });
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
        input: body.input ?? null,
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
      // The execution row and the pg-boss job are two separate writes. If
      // the enqueue fails the row would strand as `queued` with no worker
      // ever picking it up. Compensate by finalizing it to `failed` so the
      // caller's 202 contract isn't violated by a silently-stuck run.
      try {
        await (c.get("boss") ?? getBoss()).send(EXECUTION_RUN_QUEUE, job);
      } catch (err) {
        await finalizeExecution(db, principal.tenant_id, execution_id, "failed", null, {
          step_id: null,
          error_code: "enqueue_failed",
          error_message: err instanceof Error ? err.message : String(err),
        });
        throw err;
      }
      return c.json({ execution_id, status: "queued" }, 202);
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
    } catch (err) {
      const code = (err as { code?: string }).code;
      const details = (err as { details?: unknown }).details;
      if (
        code === "input_schema_violation" ||
        code === "draft_invalid" ||
        code === "step_invalid"
      ) {
        // Remediation hint: a schema violation on a saved run is almost
        // always "the caller didn't know the expected input shape" —
        // point at the endpoint that prints it.
        const hint =
          code === "input_schema_violation" && body.source === "saved"
            ? `the workflow declares an input schema — inspect it with GET /v1/workflows/${body.workflow_id}/input-schema (or sk workflows get ${body.workflow_id})`
            : undefined;
        throw HttpError.withEnvelope(400, "bad_request", (err as Error).message, {
          ...(hint ? { hint } : {}),
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
