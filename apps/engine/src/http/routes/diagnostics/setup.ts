// Operator-facing setup validation:
//   GET /v1/diagnostics/setup
//
// Surfaces the live engine configuration grouped by section (auth,
// llm, datastore, storage, crypto, public_urls). Each section returns
// a status (ok / warn / blocked), the full set of relevant env values
// (secrets masked), and a structured issue list with remediation
// recommendations. Exists so operators / portal UI / `/setup` slash
// commands can answer "is the engine production-ready?" without
// ssh-ing in.

import { createRoute, type OpenAPIHono } from "@hono/zod-openapi";
import { ErrorSchema } from "../../../api/common-schemas.ts";
import { getConfig } from "../../../config/loader.ts";
import { globalLlmStatus } from "../../../llm/core/invoke.ts";
import { requireAuth } from "../../middleware/auth.ts";
import type { AppEnv } from "../../openapi.ts";
import {
  type SetupIssue,
  type SetupResponse,
  SetupResponseSchema,
  type SetupSection,
  type SetupStatus,
  type SetupValue,
} from "./schemas.ts";

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

// Whether the named provider has the credentials it needs to actually
// answer requests. Built from globalLlmStatus() (which is itself
// derived from getConfig()) so this stays in sync with the schema and
// never reads process.env directly.
function providerHasCredentials(
  provider: string,
  status: ReturnType<typeof globalLlmStatus>,
): boolean {
  switch (provider) {
    case "mock":
      return true;
    case "anthropic":
      return status.anthropic_key_set;
    case "openai":
      return status.openai_key_set;
    case "gemini":
      return status.gemini_key_set;
    case "azure":
      return status.azure_key_set;
    case "bedrock":
      return status.bedrock_key_set;
    case "vertex":
      return status.vertex_api_key_set || status.vertex_service_account_set;
    case "ai_gateway":
      return status.gateway_key_set && status.gateway_model_set;
    default:
      return false;
  }
}

function buildLlmSection(): SetupSection {
  const llmStatus = globalLlmStatus();
  const issues: SetupIssue[] = [];
  const recommendations: string[] = [];

  // Validation now lives in ConfigSchema + model-init's validateProviderSetup
  // — boot fails on bad config so this section reports the live status from
  // globalLlmStatus(). The blocker surface comes from `inferred_provider ===
  // "unconfigured"` which globalLlmStatus already encodes.
  const cfg = getConfig().llm;
  if (llmStatus.inferred_provider === "unconfigured") {
    issues.push(
      buildIssue(
        "llm-primary",
        "blocker",
        "Primary LLM route",
        "no provider configured (set llm.provider via `sk settings configure`)",
      ),
    );
    recommendations.push(
      "Run `sk settings configure --tab llm` to set llm.provider and the matching api_key.",
    );
  }

  // Summarize-route blocker fires when the override picks a provider
  // but its credentials are absent. v3.4's `listLlmEnvironmentIssues`
  // bundled this check; v3.5 derives it from the same globalLlmStatus
  // flags that drive the credential badges below.
  if (
    cfg.summarize_provider &&
    cfg.summarize_provider !== "mock" &&
    !providerHasCredentials(cfg.summarize_provider, llmStatus)
  ) {
    issues.push(
      buildIssue(
        "llm-summarize",
        "blocker",
        "Summarize LLM route",
        `summarize provider is set to "${cfg.summarize_provider}" but its credentials are missing`,
      ),
    );
    recommendations.push(
      "Fix llm.summarize_provider credentials or unset llm.summarize_provider to fall back to the primary route.",
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
      { key: "PRIMARY_ROUTE", value: primaryRoute, status_hint: null },
      { key: "FALLBACK_ROUTE", value: fallbackRoute, status_hint: null },
      { key: "SUMMARIZE_ROUTE", value: summarizeRoute, status_hint: null },
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

function buildSetupValidation(): SetupResponse {
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

export function registerSetupRoutes(app: OpenAPIHono<AppEnv>): void {
  app.openapi(setupRoute, async (c) => {
    requireAuth(c);
    return c.json(buildSetupValidation(), 200);
  });
}
