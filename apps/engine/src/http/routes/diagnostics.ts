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
import { requireAnyPermission, requirePermission } from "../middleware/require-permission.ts";
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

const SetupStatusSchema = z.enum(["ok", "warn", "blocked"]).openapi("DiagnosticsSetupStatus");

const SetupValueSchema = z
  .object({
    key: z.string(),
    value: z.string().nullable(),
    status_hint: z.string().nullable(),
  })
  .openapi("DiagnosticsSetupValue");

const SetupSectionSchema = z
  .object({
    title: z.string(),
    status: SetupStatusSchema,
    issues: z.array(SetupIssueSchema),
    recommendations: z.array(z.string()),
    values: z.array(SetupValueSchema),
  })
  .openapi("DiagnosticsSetupSection");

const SetupSummaryCountsSchema = z
  .object({
    blockers: z.number().int(),
    warnings: z.number().int(),
    sections_blocked: z.number().int(),
    sections_warn: z.number().int(),
  })
  .openapi("DiagnosticsSetupSummaryCounts");

const SetupSectionsSchema = z
  .object({
    auth: SetupSectionSchema,
    llm: SetupSectionSchema,
    datastore: SetupSectionSchema,
    storage: SetupSectionSchema,
    crypto: SetupSectionSchema,
    public_urls: SetupSectionSchema,
  })
  .openapi("DiagnosticsSetupSections");

const SetupResponseSchema = z
  .object({
    overall_status: SetupStatusSchema,
    summary_counts: SetupSummaryCountsSchema,
    sections: SetupSectionsSchema,
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

type SetupIssue = z.infer<typeof SetupIssueSchema>;
type SetupStatus = z.infer<typeof SetupStatusSchema>;
type SetupValue = z.infer<typeof SetupValueSchema>;
type SetupSection = z.infer<typeof SetupSectionSchema>;

function envString(key: string): string | undefined {
  const value = process.env[key];
  return typeof value === "string" && value.trim().length > 0 ? value : undefined;
}

function maskSecret(value: string | undefined): string | null {
  if (!value) return null;
  if (value.length <= 6) return "*".repeat(value.length);
  return `${value.slice(0, 4)}…${value.slice(-2)}`;
}

function setPresence(value: string | undefined): string | null {
  return value ? "configured" : null;
}

function buildIssue(
  id: string,
  severity: SetupIssue["severity"],
  title: string,
  detail: string,
): SetupIssue {
  return { id, severity, title, detail };
}

function statusFromIssues(issues: readonly SetupIssue[]): SetupStatus {
  if (issues.some((issue) => issue.severity === "blocker")) return "blocked";
  if (issues.length > 0) return "warn";
  return "ok";
}

function buildSection(
  title: string,
  values: SetupValue[],
  issues: SetupIssue[] = [],
  recommendations: string[] = [],
): SetupSection {
  return {
    title,
    status: statusFromIssues(issues),
    issues,
    recommendations,
    values,
  };
}

function compactJoin(items: readonly string[]): string {
  return items.join(" ");
}

function formatDatabaseUrl(dsn: string | undefined): string | null {
  if (!dsn) return null;
  try {
    const url = new URL(dsn);
    const auth = url.username ? `${decodeURIComponent(url.username)}@` : "";
    const host = url.hostname || "localhost";
    const port = url.port ? `:${url.port}` : "";
    const db = url.pathname.replace(/^\//, "") || "(default)";
    return `${url.protocol}//${auth}${host}${port}/${db}`;
  } catch {
    return "invalid DATABASE_URL";
  }
}

function buildAuthSection(): SetupSection {
  const issues: SetupIssue[] = [];
  const recommendations: string[] = [];
  const firebaseProject = envString("FIREBASE_PROJECT_ID");
  const firebaseLoginUrl = envString("FIREBASE_LOGIN_URL");
  if (Boolean(firebaseProject) !== Boolean(firebaseLoginUrl)) {
    issues.push(
      buildIssue(
        "auth-firebase-partial",
        "warning",
        "Firebase login",
        "FIREBASE_PROJECT_ID and FIREBASE_LOGIN_URL should be set together or both unset.",
      ),
    );
    recommendations.push(
      "Complete the Firebase login pair or unset the partial value before the next deploy.",
    );
  }
  return buildSection(
    "Auth",
    [
      {
        key: "AUTH_MODES",
        value: "api_key, portal_token, bearer",
        status_hint: null,
      },
      {
        key: "OIDC_ISSUER_URL",
        value: envString("OIDC_ISSUER_URL") ?? null,
        status_hint: envString("OIDC_ISSUER_URL") ? null : "Not configured",
      },
      {
        key: "FIREBASE_PROJECT_ID",
        value: firebaseProject ?? null,
        status_hint: firebaseProject ? null : "Not configured",
      },
      {
        key: "FIREBASE_LOGIN_URL",
        value: firebaseLoginUrl ?? null,
        status_hint: firebaseLoginUrl ? null : "Not configured",
      },
    ],
    issues,
    recommendations,
  );
}

function buildLlmSection(): SetupSection {
  const llmStatus = globalLlmStatus();
  const issues: SetupIssue[] = [];
  const recommendations: string[] = [];

  const primaryIssues = listLlmEnvironmentIssues(process.env, { requireConfigured: true });
  if (primaryIssues.length > 0) {
    issues.push(
      buildIssue("llm-primary", "blocker", "Primary LLM route", compactJoin(primaryIssues)),
    );
  }

  const summarizeIssues = process.env.SUMMARIZE_LLM_PROVIDER
    ? listLlmEnvironmentIssues(process.env, {
        providerEnvVar: "SUMMARIZE_LLM_PROVIDER",
        fallbackProviderEnvVar: null,
        requireConfigured: true,
      })
    : [];
  if (summarizeIssues.length > 0) {
    issues.push(
      buildIssue("llm-summarize", "blocker", "Summarize LLM route", compactJoin(summarizeIssues)),
    );
    recommendations.push(
      "Fix SUMMARIZE_LLM_PROVIDER credentials or unset the override to fall back to the primary LLM route.",
    );
  }

  if (issues.some((issue) => issue.id === "llm-primary")) {
    recommendations.push(
      "Set AI_GATEWAY_API_KEY + AI_GATEWAY_MODEL together, or configure a complete direct-provider route.",
    );
  }

  const gatewayReady = llmStatus.gateway_key_set && llmStatus.gateway_model_set;
  const primaryRoute = gatewayReady
    ? `gateway · ${envString("AI_GATEWAY_MODEL") ?? "(model missing)"}`
    : `${llmStatus.provider_env ?? llmStatus.inferred_provider} · ${envString("LLM_PRIMARY") ?? llmStatus.default_primary}`;
  const fallbackRoute = llmStatus.fallback_provider_env
    ? `${llmStatus.fallback_provider_env} · ${envString("LLM_FALLBACK") ?? llmStatus.default_fallback}`
    : gatewayReady
      ? "same as primary gateway route"
      : "same as primary provider";
  const summarizeRoute =
    llmStatus.summarize_provider_env || llmStatus.summarize_model
      ? `${llmStatus.summarize_provider_env ?? llmStatus.summarize_inferred_provider} · ${llmStatus.summarize_model ?? envString("SUMMARIZE_MODEL") ?? envString("LLM_PRIMARY") ?? llmStatus.default_primary}`
      : "inherits the primary route";

  return buildSection(
    "LLM",
    [
      {
        key: "PRIMARY_ROUTE",
        value: primaryRoute,
        status_hint: null,
      },
      {
        key: "FALLBACK_ROUTE",
        value: fallbackRoute,
        status_hint: null,
      },
      {
        key: "SUMMARIZE_ROUTE",
        value: summarizeRoute,
        status_hint: null,
      },
      {
        key: "AI_GATEWAY_MODEL",
        value: envString("AI_GATEWAY_MODEL") ?? null,
        status_hint: envString("AI_GATEWAY_MODEL") ? null : "Not configured",
      },
      {
        key: "AI_GATEWAY_API_KEY",
        value: setPresence(envString("AI_GATEWAY_API_KEY")),
        status_hint: envString("AI_GATEWAY_API_KEY") ? null : "Missing",
      },
      {
        key: "ANTHROPIC_API_KEY",
        value: setPresence(envString("ANTHROPIC_API_KEY")),
        status_hint: envString("ANTHROPIC_API_KEY") ? null : "Missing",
      },
      {
        key: "OPENAI_API_KEY",
        value: setPresence(envString("OPENAI_API_KEY")),
        status_hint: envString("OPENAI_API_KEY") ? null : "Missing",
      },
      {
        key: "GEMINI_API_KEY",
        value: setPresence(envString("GEMINI_API_KEY")),
        status_hint: envString("GEMINI_API_KEY") ? null : "Missing",
      },
      {
        key: "AZURE_API_KEY",
        value: setPresence(envString("AZURE_API_KEY")),
        status_hint: envString("AZURE_API_KEY") ? null : "Missing",
      },
      {
        key: "AWS_ACCESS_KEY_ID",
        value: maskSecret(envString("AWS_ACCESS_KEY_ID")),
        status_hint: envString("AWS_ACCESS_KEY_ID") ? null : "Missing",
      },
      {
        key: "VERTEX_API_KEY",
        value: setPresence(envString("VERTEX_API_KEY")),
        status_hint: envString("VERTEX_API_KEY") ? null : "Missing",
      },
      {
        key: "VERTEX_SERVICE_ACCOUNT",
        value:
          envString("VERTEX_CLIENT_EMAIL") && envString("VERTEX_PRIVATE_KEY") ? "configured" : null,
        status_hint:
          envString("VERTEX_CLIENT_EMAIL") && envString("VERTEX_PRIVATE_KEY")
            ? null
            : "Not configured",
      },
    ],
    issues,
    recommendations,
  );
}

function buildDatastoreSection(): SetupSection {
  const issues: SetupIssue[] = [];
  const recommendations: string[] = [];
  const dsn = envString("DATABASE_URL");
  if (!dsn) {
    issues.push(
      buildIssue("database-url", "blocker", "Database connection", "DATABASE_URL is not set."),
    );
    recommendations.push("Set DATABASE_URL to the tenant-scoped Postgres connection string.");
  } else if (formatDatabaseUrl(dsn) === "invalid DATABASE_URL") {
    issues.push(
      buildIssue(
        "database-url-invalid",
        "blocker",
        "Database connection",
        "DATABASE_URL is present but cannot be parsed as a URL.",
      ),
    );
    recommendations.push("Fix DATABASE_URL so the engine points at a valid Postgres DSN.");
  }
  return buildSection(
    "Datastore",
    [
      {
        key: "DATABASE_URL",
        value: formatDatabaseUrl(dsn),
        status_hint: dsn ? null : "Missing",
      },
    ],
    issues,
    recommendations,
  );
}

function buildStorageSection(): SetupSection {
  const issues: SetupIssue[] = [];
  const recommendations: string[] = [];
  const endpoint = envString("S3_ENDPOINT");
  const accessKey = envString("S3_ACCESS_KEY");
  const secretKey = envString("S3_SECRET_KEY");
  const partial =
    [endpoint, accessKey, secretKey].some(Boolean) &&
    ![endpoint, accessKey, secretKey].every(Boolean);
  if (partial) {
    issues.push(
      buildIssue(
        "s3-partial",
        "warning",
        "Object storage",
        "S3 configuration is partial. Set S3_ENDPOINT, S3_ACCESS_KEY, and S3_SECRET_KEY together or remove the partial values.",
      ),
    );
    recommendations.push("Complete the S3 triplet or unset it before the next deploy.");
  }
  return buildSection(
    "Object storage",
    [
      {
        key: "S3_ENDPOINT",
        value: endpoint ?? null,
        status_hint: endpoint ? null : "Not configured",
      },
      {
        key: "S3_ACCESS_KEY",
        value: maskSecret(accessKey),
        status_hint: accessKey ? null : "Missing",
      },
      {
        key: "S3_SECRET_KEY",
        value: setPresence(secretKey),
        status_hint: secretKey ? null : "Missing",
      },
    ],
    issues,
    recommendations,
  );
}

function buildCryptoSection(): SetupSection {
  const issues: SetupIssue[] = [];
  const recommendations: string[] = [];
  const masterKey = envString("MASTER_KEY");
  if (!masterKey) {
    issues.push(buildIssue("master-key", "blocker", "Master key", "MASTER_KEY is not set."));
    recommendations.push("Set MASTER_KEY to a 64-hex-character AES-256-GCM key.");
  } else if (!/^[0-9a-fA-F]{64}$/.test(masterKey)) {
    issues.push(
      buildIssue(
        "master-key-format",
        "blocker",
        "Master key",
        "MASTER_KEY must be 64 hex characters (32 bytes).",
      ),
    );
    recommendations.push("Rotate MASTER_KEY to a 64-hex-character value.");
  }
  return buildSection(
    "Crypto",
    [
      {
        key: "MASTER_KEY",
        value: maskSecret(masterKey),
        status_hint: masterKey ? null : "Missing",
      },
    ],
    issues,
    recommendations,
  );
}

function buildPublicUrlsSection(): SetupSection {
  const issues: SetupIssue[] = [];
  const recommendations: string[] = [];
  const baseUrl = envString("PUBLIC_BASE_URL");
  if (!baseUrl) {
    issues.push(
      buildIssue(
        "public-base-url",
        "warning",
        "Public base URL",
        "PUBLIC_BASE_URL is not set. External webhook links, chat deeplinks, and operator copy-paste URLs may be wrong.",
      ),
    );
    recommendations.push("Set PUBLIC_BASE_URL to the externally reachable engine URL.");
  }
  return buildSection(
    "Public URLs",
    [
      {
        key: "PUBLIC_BASE_URL",
        value: baseUrl ?? null,
        status_hint: baseUrl ? null : "Missing",
      },
    ],
    issues,
    recommendations,
  );
}

function buildSetupValidation(): z.infer<typeof SetupResponseSchema> {
  const sections = {
    auth: buildAuthSection(),
    llm: buildLlmSection(),
    datastore: buildDatastoreSection(),
    storage: buildStorageSection(),
    crypto: buildCryptoSection(),
    public_urls: buildPublicUrlsSection(),
  };

  const allSections = Object.values(sections);
  const issues = allSections.flatMap((section) => section.issues);
  const recommendations = Array.from(
    new Set(allSections.flatMap((section) => section.recommendations)),
  );
  const summary_counts = {
    blockers: issues.filter((issue) => issue.severity === "blocker").length,
    warnings: issues.filter((issue) => issue.severity === "warning").length,
    sections_blocked: allSections.filter((section) => section.status === "blocked").length,
    sections_warn: allSections.filter((section) => section.status === "warn").length,
  };
  const overall_status = allSections.some((section) => section.status === "blocked")
    ? "blocked"
    : allSections.some((section) => section.status === "warn")
      ? "warn"
      : "ok";
  return { overall_status, summary_counts, sections, issues, recommendations };
}

export function registerDiagnosticsRoutes(app: OpenAPIHono<AppEnv>): void {
  app.use("/v1/diagnostics/errors", requirePermission("audit:read"));
  app.use("/v1/diagnostics/llm", requirePermission("audit:read"));
  app.use("/v1/diagnostics/setup", requireAnyPermission(["audit:read", "identity:read"]));

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
