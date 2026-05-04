// Stateless transform pipeline — POST /v1/executions/transform.
//
// Same `workflow:run` permission as a full execution because a malicious
// transform can leak data via `response_filters` decisions or transform
// output. Does NOT create an `executions` row but DOES audit-log under
// EXECUTION_COMPLETED so the trail is consistent with full runs.
//
// Phase 4 of the 2026-05 architecture audit (issue #92).

import { createRoute, type OpenAPIHono } from "@hono/zod-openapi";
import { ErrorSchema } from "../../../api/common-schemas.ts";
import { auditAwait } from "../../../audit/audit.ts";
import { AuditAction } from "../../../audit/types.ts";
import { evaluate as evaluateJsonata } from "../../../execution/jsonata-engine.ts";
import {
  applyResponseFilters,
  ResponseFilterFailError,
} from "../../../execution/response-filter.ts";
import { logger } from "../../../logging/logger.ts";
import { runJs } from "../../../sandboxes/quickjs/runtime.ts";
import { BadRequestError, UnprocessableEntityError } from "../../errors.ts";
import { requireAuth } from "../../middleware/auth.ts";
import { requirePermission } from "../../middleware/require-permission.ts";
import type { AppEnv } from "../../openapi.ts";
import { RunTransformBodySchema, RunTransformResponseSchema } from "./schemas.ts";

const runTransformRoute = createRoute({
  method: "post",
  path: "/v1/executions/transform",
  tags: ["executions"],
  summary: "Execute a transform / filter pipeline against a payload (no run row)",
  description:
    "Stateless transform pipeline: apply `output_transform` (JSONata) or `output_transform_function` (JS) to `payload`, then run `response_filters`. Mirrors the reference impl's `POST /tools/transform/run`. Does not create an execution row — useful for CI smoke tests, transform debugging, and external probes.",
  security: [{ bearerAuth: [] }],
  request: {
    body: { content: { "application/json": { schema: RunTransformBodySchema } } },
  },
  responses: {
    200: {
      description: "Transform completed",
      content: { "application/json": { schema: RunTransformResponseSchema } },
    },
    400: { description: "Bad request", content: { "application/json": { schema: ErrorSchema } } },
    422: {
      description: "Transform / filter raised",
      content: { "application/json": { schema: ErrorSchema } },
    },
  },
});

export function registerTransformRoute(app: OpenAPIHono<AppEnv>): void {
  app.use("/v1/executions/transform", async (c, next) => {
    if (c.req.method === "POST") {
      return requirePermission("workflow:run")(c, next);
    }
    return next();
  });

  app.openapi(runTransformRoute, async (c) => {
    const principal = requireAuth(c);
    const db = c.get("db");
    const body = c.req.valid("json");
    const startedAt = Date.now();
    const timeoutMs = body.timeout_ms ?? 30_000;

    // Optional pre-validation against `input_schema`. Mirrors the
    // workflow pipeline's pre-step input check.
    if (body.input_schema) {
      const required = (body.input_schema as { required?: unknown }).required;
      if (Array.isArray(required) && body.payload && typeof body.payload === "object") {
        const missing = required.filter(
          (k) => typeof k === "string" && !(k in (body.payload as Record<string, unknown>)),
        );
        if (missing.length > 0) {
          throw new BadRequestError(`payload missing required fields: ${missing.join(", ")}`, {
            code: "input_schema_violation",
            details: { missing },
          });
        }
      }
    }

    let output: unknown = body.payload;
    let error: { code: string; message: string } | null = null;

    // Apply transform — either JSONata or QuickJS-sandboxed JS.
    try {
      if (body.output_transform) {
        output = await evaluateJsonata(body.output_transform, output);
      } else if (body.output_transform_function) {
        const result = await runJs<unknown>({
          code: body.output_transform_function,
          input: output,
        });
        if (result.output !== undefined) output = result.output;
      }
    } catch (err) {
      error = {
        code: "output_transform_failed",
        message: err instanceof Error ? err.message : String(err),
      };
    }

    // Apply workflow-level response filters AFTER the transform —
    // matches the order in `engine.ts` for full-workflow runs.
    if (!error && body.response_filters && body.response_filters.length > 0) {
      try {
        output = applyResponseFilters(body.response_filters, output);
      } catch (err) {
        error = {
          code: err instanceof ResponseFilterFailError ? "response_filter_failed" : "filter_error",
          message: err instanceof Error ? err.message : String(err),
        };
      }
    }

    // Optional output-schema gate after transform + filters.
    if (!error && body.output_schema) {
      const required = (body.output_schema as { required?: unknown }).required;
      if (Array.isArray(required) && output && typeof output === "object") {
        const missing = required.filter(
          (k) => typeof k === "string" && !(k in (output as Record<string, unknown>)),
        );
        if (missing.length > 0) {
          error = {
            code: "output_schema_violation",
            message: `output missing required fields: ${missing.join(", ")}`,
          };
        }
      }
    }

    const duration_ms = Date.now() - startedAt;

    // Audit trail — same EXECUTION_COMPLETED action the full pipeline
    // emits so operators can correlate transform-only runs in the
    // audit table without a special action.
    await auditAwait(
      {
        tenant_id: principal.tenant_id,
        actor_type: principal.kind,
        actor_id: principal.id,
        action: AuditAction.EXECUTION_COMPLETED,
        resource_type: "execution",
        resource_id: null,
        result: error ? "error" : "success",
        ...(error ? { reason: error.code } : {}),
        metadata: {
          source_kind: "transform",
          duration_ms,
          has_transform: Boolean(body.output_transform) || Boolean(body.output_transform_function),
          filter_count: body.response_filters?.length ?? 0,
        },
      },
      db,
    );

    if (timeoutMs && duration_ms > timeoutMs) {
      logger.warn({
        module: "executions.transform",
        action: "execution.transform.timeout_exceeded",
        msg: "transform exceeded the requested timeout but already completed",
        timeout_ms: timeoutMs,
        duration_ms,
      });
    }

    if (error) {
      throw new UnprocessableEntityError(error.message, { code: error.code });
    }

    return c.json({ output, duration_ms }, 200);
  });
}
