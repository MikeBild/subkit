// Engine self-diagnostics surface.
//
//   GET  /v1/diagnostics/errors  — tail the in-memory error ring
//
// The ring is populated by `errorMiddleware` on every 5xx (unhandled
// `internal_error` + LLM-mapped 502/504 + typed 5xx HttpErrors). The
// CLI's `/logs` slash command reads this so operators can correlate a
// `trace_id` from the user-facing banner to the actual server-side
// cause without SSH-ing into the engine container.
//
// Tenant scoping: a request without a tenant context (e.g. an early
// auth failure) gets `tenant_id: null` in the ring. We only expose
// rows belonging to the calling tenant + tenant-less rows that share
// the trace_id with one of those rows; otherwise a noisy neighbour
// could leak details across tenants. Kept simple: filter strictly to
// the caller's tenant; the rare auth-time failure stays invisible by
// design.

import { createRoute, type OpenAPIHono, z } from "@hono/zod-openapi";
import { ErrorSchema } from "../../api/common-schemas.ts";
import { listLlmEnvironmentIssues } from "../../env.ts";
import { globalLlmStatus } from "../../llm/core/invoke.ts";
import { errorRing } from "../../observability/error-ring.ts";
import { requireAuth } from "../middleware/auth.ts";
import { requirePermission } from "../middleware/require-permission.ts";
import type { AppEnv } from "../openapi.ts";

const ErrorRingEntrySchema = z
  .object({
    trace_id: z.string().nullable(),
    ts: z.string(),
    tenant_id: z.string().nullable(),
    method: z.string(),
    path: z.string(),
    status: z.number().int(),
    code: z.string(),
    message: z.string(),
    stack: z.string().nullable(),
    bucket: z.enum([
      "unhandled",
      "llm_provider",
      "llm_no_object",
      "llm_timeout",
      "llm_quota",
      "http",
    ]),
  })
  .openapi("ErrorRingEntry");

const ListResponse = z
  .object({
    items: z.array(ErrorRingEntrySchema),
    total_buffered: z.number().int(),
  })
  .openapi("DiagnosticsErrorListResponse");

const ListQuery = z
  .object({
    limit: z.coerce.number().int().positive().max(200).optional(),
    since: z.string().datetime().optional(),
    trace_id: z.string().optional(),
  })
  .openapi("DiagnosticsErrorListQuery");

const listRoute = createRoute({
  method: "get",
  path: "/v1/diagnostics/errors",
  tags: ["diagnostics"],
  summary: "Tail the engine error ring (last N captured 5xx)",
  security: [{ bearerAuth: [] }],
  request: { query: ListQuery },
  responses: {
    200: { description: "OK", content: { "application/json": { schema: ListResponse } } },
    401: { description: "Unauthorized", content: { "application/json": { schema: ErrorSchema } } },
    403: { description: "Forbidden", content: { "application/json": { schema: ErrorSchema } } },
  },
});

// LLM routing snapshot (audit-gated). Lets operators + smoke probes
// confirm the resolved provider path without exposing any secret
// material. We surface booleans only.

const LlmStatusSchema = z
  .object({
    provider_env: z.string().nullable(),
    inferred_provider: z.string(),
    fallback_provider_env: z.string().nullable(),
    fallback_inferred_provider: z.string(),
    summarize_provider_env: z.string().nullable(),
    summarize_inferred_provider: z.string(),
    summarize_model: z.string().nullable(),
    summarize_configuration_error: z.string().nullable(),
    configuration_error: z.string().nullable(),
    anthropic_key_set: z.boolean(),
    gateway_key_set: z.boolean(),
    gateway_model_set: z.boolean(),
    openai_key_set: z.boolean(),
    gemini_key_set: z.boolean(),
    azure_key_set: z.boolean(),
    bedrock_key_set: z.boolean(),
    vertex_api_key_set: z.boolean(),
    vertex_service_account_set: z.boolean(),
    default_primary: z.string(),
    default_fallback: z.string(),
  })
  .openapi("DiagnosticsLlmStatus");

const llmRoute = createRoute({
  method: "get",
  path: "/v1/diagnostics/llm",
  tags: ["diagnostics"],
  summary: "Resolved LLM provider + model snapshot (smoke / triage)",
  security: [{ bearerAuth: [] }],
  responses: {
    200: { description: "OK", content: { "application/json": { schema: LlmStatusSchema } } },
    401: { description: "Unauthorized", content: { "application/json": { schema: ErrorSchema } } },
    403: { description: "Forbidden", content: { "application/json": { schema: ErrorSchema } } },
  },
});

const SetupIssueSchema = z
  .object({
    id: z.string(),
    severity: z.enum(["blocker", "warning"]),
    title: z.string(),
    detail: z.string(),
  })
  .openapi("DiagnosticsSetupIssue");

const SetupResponseSchema = z
  .object({
    overall_status: z.enum(["ok", "warn", "blocked"]),
    issues: z.array(SetupIssueSchema),
    recommendations: z.array(z.string()),
  })
  .openapi("DiagnosticsSetupResponse");

const setupRoute = createRoute({
  method: "get",
  path: "/v1/diagnostics/setup",
  tags: ["diagnostics"],
  summary: "Operator-facing setup validation for live engine configuration",
  security: [{ bearerAuth: [] }],
  responses: {
    200: { description: "OK", content: { "application/json": { schema: SetupResponseSchema } } },
    401: { description: "Unauthorized", content: { "application/json": { schema: ErrorSchema } } },
    403: { description: "Forbidden", content: { "application/json": { schema: ErrorSchema } } },
  },
});

function buildSetupValidation(): z.infer<typeof SetupResponseSchema> {
  const issues: Array<z.infer<typeof SetupIssueSchema>> = [];

  const primaryIssues = listLlmEnvironmentIssues(process.env, { requireConfigured: true });
  if (primaryIssues.length > 0) {
    issues.push({
      id: "llm-primary",
      severity: "blocker",
      title: "Primary LLM route",
      detail: primaryIssues.join(" "),
    });
  }

  if (process.env.SUMMARIZE_LLM_PROVIDER) {
    const summarizeIssues = listLlmEnvironmentIssues(process.env, {
      providerEnvVar: "SUMMARIZE_LLM_PROVIDER",
      fallbackProviderEnvVar: null,
      requireConfigured: true,
    });
    if (summarizeIssues.length > 0) {
      issues.push({
        id: "llm-summarize",
        severity: "blocker",
        title: "Summarize LLM route",
        detail: summarizeIssues.join(" "),
      });
    }
  }

  if (!process.env.PUBLIC_BASE_URL) {
    issues.push({
      id: "public-base-url",
      severity: "warning",
      title: "Public base URL",
      detail:
        "PUBLIC_BASE_URL is not set. External webhook links, chat deeplinks, and operator copy-paste URLs may be wrong.",
    });
  }

  const s3Fields = [
    Boolean(process.env.S3_ENDPOINT),
    Boolean(process.env.S3_ACCESS_KEY),
    Boolean(process.env.S3_SECRET_KEY),
  ];
  if (s3Fields.some(Boolean) && !s3Fields.every(Boolean)) {
    issues.push({
      id: "s3-partial",
      severity: "warning",
      title: "Object storage",
      detail:
        "S3 configuration is partial. Set S3_ENDPOINT, S3_ACCESS_KEY, and S3_SECRET_KEY together or remove the partial values.",
    });
  }

  const recommendations: string[] = [];
  if (issues.some((issue) => issue.id === "public-base-url")) {
    recommendations.push("Set PUBLIC_BASE_URL to the externally reachable engine URL.");
  }
  if (issues.some((issue) => issue.id === "s3-partial")) {
    recommendations.push("Complete the S3 triplet or unset it before the next deploy.");
  }
  if (issues.some((issue) => issue.id === "llm-summarize")) {
    recommendations.push(
      "Fix SUMMARIZE_LLM_PROVIDER credentials or unset the override to fall back to the primary LLM route.",
    );
  }

  const overall_status = issues.some((issue) => issue.severity === "blocker")
    ? "blocked"
    : issues.length > 0
      ? "warn"
      : "ok";
  return { overall_status, issues, recommendations };
}

export function registerDiagnosticsRoutes(app: OpenAPIHono<AppEnv>): void {
  app.use("/v1/diagnostics/*", requirePermission("audit:read"));

  app.openapi(listRoute, async (c) => {
    const principal = requireAuth(c);
    const q = c.req.valid("query");
    const opts: { limit?: number; since?: Date; trace_id?: string; tenant_id: string } = {
      tenant_id: principal.tenant_id,
    };
    if (q.limit !== undefined) opts.limit = q.limit;
    if (q.trace_id !== undefined) opts.trace_id = q.trace_id;
    if (q.since !== undefined) opts.since = new Date(q.since);
    const items = errorRing.tail(opts);
    return c.json({ items, total_buffered: errorRing.size() }, 200);
  });

  app.openapi(llmRoute, async (c) => {
    requireAuth(c);
    return c.json(globalLlmStatus(), 200);
  });

  app.openapi(setupRoute, async (c) => {
    requireAuth(c);
    return c.json(buildSetupValidation(), 200);
  });
}
