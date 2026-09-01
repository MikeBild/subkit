// Operator-facing setup validation:
//   GET /v1/diagnostics/setup
//
// Surfaces the live engine configuration grouped by section (auth,
// llm, datastore, storage, crypto, public_urls). Each section returns
// a status (ok / warn / blocked), the relevant settings (secrets
// masked), and a structured issue list with remediation hints. Exists
// so operators / portal UI / `sk settings configure` can answer
// "is the engine production-ready?" without ssh-ing in.
//
// 4.2.0: this file used to read 33 env vars directly via envString().
// That made settings writes silently invisible. Everything now reads the
// active PostgreSQL-backed snapshot through `getConfig()`. `MASTER_KEY` stays
// in env because it is a process bootstrap value consumed before the runtime
// revision can be decrypted.

import { createRoute, type OpenAPIHono } from "@hono/zod-openapi";
import { ErrorSchema } from "../../../api/common-schemas.ts";
import { getConfig } from "../../../config/loader.ts";
import { BOOTSTRAP_ONLY_ENV_KEYS } from "../../../crypto/aes-gcm.ts";
import { globalLlmStatus } from "../../../llm/index.ts";
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

/** Narrows a config string to undefined when it is the schema default
 *  (empty string), so the "Missing"/"Not configured" hint logic stays
 *  centralized at the call site. Trims surrounding whitespace before
 *  the presence check AND on the way out — otherwise a leading-space
 *  `OPENAI_API_KEY=" sk-..."` would surface with the leading space
 *  intact, which is harmless but inconsistent with the trimmed
 *  predicate. */
function present(value: string | undefined | null): string | undefined {
  if (typeof value !== "string") return undefined;
  const trimmed = value.trim();
  return trimmed.length > 0 ? trimmed : undefined;
}

// 4.2.0: every secret-shape value in this file uses `setPresence`
// (returns "configured" / null) instead of `maskSecret` (which leaked
// 6 hex chars to any identity:read principal). The diagnostic
// surface is reachable to non-admin roles; a strict presence-only
// view is the only safe shape.
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

function buildAuthSection(snapshot: ReturnType<typeof getConfig>): SetupSection {
  const cfg = snapshot.auth;
  return buildSection(
    "Auth",
    [
      {
        key: "auth_modes",
        value: "api_key, portal_token, bearer",
        status_hint: null,
      },
      {
        key: "auth.providers",
        value: cfg.providers.map((provider) => `${provider.id}:${provider.protocol}`).join(", "),
        status_hint: null,
      },
    ],
    [],
    [],
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

function buildLlmSection(snapshot: ReturnType<typeof getConfig>): SetupSection {
  const llmStatus = globalLlmStatus();
  const cfg = snapshot.llm;
  const issues: SetupIssue[] = [];
  const recommendations: string[] = [];

  // Validation lives in ConfigSchema + model-init's validateProviderSetup
  // — boot fails on bad config so this section reports the live status from
  // globalLlmStatus(). The blocker surface comes from `inferred_provider ===
  // "unconfigured"` which globalLlmStatus already encodes.
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
  // but its credentials are absent. Same shape as the primary check —
  // both derive from the globalLlmStatus flags below.
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

  const ai = cfg.providers.ai_gateway;
  const anthropic = cfg.providers.anthropic;
  const openai = cfg.providers.openai;
  const gemini = cfg.providers.gemini;
  const azure = cfg.providers.azure;
  const bedrock = cfg.providers.bedrock;
  const vertex = cfg.providers.vertex;

  const gatewayReady = llmStatus.gateway_key_set && llmStatus.gateway_model_set;
  const primaryRoute = gatewayReady
    ? `gateway · ${present(ai.model) ?? "(model missing)"}`
    : `${cfg.provider} · ${present(cfg.model) ?? llmStatus.default_primary}`;
  const fallbackRoute = cfg.fallback_provider
    ? `${cfg.fallback_provider} · ${present(cfg.fallback_model) ?? llmStatus.default_fallback}`
    : gatewayReady
      ? "same as primary gateway route"
      : "same as primary provider";
  const summarizeRoute =
    cfg.summarize_provider || present(cfg.summarize_model)
      ? `${cfg.summarize_provider ?? cfg.provider} · ${present(cfg.summarize_model) ?? present(cfg.model) ?? llmStatus.default_primary}`
      : "inherits the primary route";

  return buildSection(
    "LLM",
    [
      { key: "llm.primary_route", value: primaryRoute, status_hint: null },
      { key: "llm.fallback_route", value: fallbackRoute, status_hint: null },
      { key: "llm.summarize_route", value: summarizeRoute, status_hint: null },
      {
        key: "llm.providers.ai_gateway.model",
        value: present(ai.model) ?? null,
        status_hint: present(ai.model) ? null : "Not configured",
      },
      {
        key: "llm.providers.ai_gateway.api_key",
        value: setPresence(present(ai.api_key)),
        status_hint: present(ai.api_key) ? null : "Missing",
      },
      {
        key: "llm.providers.anthropic.api_key",
        value: setPresence(present(anthropic.api_key)),
        status_hint: present(anthropic.api_key) ? null : "Missing",
      },
      {
        key: "llm.providers.openai.api_key",
        value: setPresence(present(openai.api_key)),
        status_hint: present(openai.api_key) ? null : "Missing",
      },
      {
        key: "llm.providers.gemini.api_key",
        value: setPresence(present(gemini.api_key)),
        status_hint: present(gemini.api_key) ? null : "Missing",
      },
      {
        key: "llm.providers.azure.api_key",
        value: setPresence(present(azure.api_key)),
        status_hint: present(azure.api_key) ? null : "Missing",
      },
      {
        key: "llm.providers.bedrock.access_key_id",
        // setPresence (not maskSecret) — the diagnostic surface is
        // reachable to anyone with audit:read OR identity:read; even
        // 6 hex chars of an AWS access key are too much exposure for
        // a non-admin role.
        value: setPresence(present(bedrock.access_key_id)),
        status_hint: present(bedrock.access_key_id) ? null : "Missing",
      },
      {
        key: "llm.providers.bedrock.secret_access_key",
        // Both halves of the AWS credential pair are surfaced so an
        // operator who only set one sees the gap immediately, instead
        // of debugging a 4xx from the bedrock SDK.
        value: setPresence(present(bedrock.secret_access_key)),
        status_hint: present(bedrock.secret_access_key) ? null : "Missing",
      },
      {
        key: "llm.providers.vertex.api_key",
        value: setPresence(present(vertex.api_key)),
        status_hint: present(vertex.api_key) ? null : "Missing",
      },
      {
        key: "llm.providers.vertex.service_account",
        value: present(vertex.client_email) && present(vertex.private_key) ? "configured" : null,
        status_hint:
          present(vertex.client_email) && present(vertex.private_key) ? null : "Not configured",
      },
    ],
    issues,
    recommendations,
  );
}

function buildDatastoreSection(snapshot: ReturnType<typeof getConfig>): SetupSection {
  const dsn = present(snapshot.database.url);
  const issues: SetupIssue[] = [];
  const recommendations: string[] = [];
  if (!dsn) {
    issues.push(
      buildIssue("database-url", "blocker", "Database connection", "database.url is not set."),
    );
    recommendations.push(
      "Set database.url to the tenant-scoped Postgres connection string (or the DATABASE_URL bootstrap env).",
    );
  } else if (formatDatabaseUrl(dsn) === "invalid DATABASE_URL") {
    issues.push(
      buildIssue(
        "database-url-invalid",
        "blocker",
        "Database connection",
        "database.url is present but cannot be parsed as a URL.",
      ),
    );
    recommendations.push("Fix database.url so the engine points at a valid Postgres DSN.");
  }
  // database.url carries `secret: true` in ConfigSchema (the password
  // is sensitive, and the username + host identify which prod cluster
  // the engine points at — operational metadata that non-admin
  // identity:read principals shouldn't see). Surface presence only.
  // formatDatabaseUrl is still consulted internally for the
  // invalid-format check above; the operator-facing string lands in
  // the issue detail, not in the public value.
  return buildSection(
    "Datastore",
    [
      {
        key: "database.url",
        value: setPresence(dsn),
        status_hint: dsn ? null : "Missing",
      },
    ],
    issues,
    recommendations,
  );
}

function buildStorageSection(snapshot: ReturnType<typeof getConfig>): SetupSection {
  const s3 = snapshot.storage.object_store;
  const issues: SetupIssue[] = [];
  const recommendations: string[] = [];
  const endpoint = present(s3.endpoint);
  const bucket = present(s3.bucket);
  const accessKey = present(s3.access_key_id);
  const secretKey = present(s3.secret_access_key);
  const sessionToken = present(s3.session_token);
  const partial =
    [endpoint, bucket, accessKey, secretKey].some(Boolean) &&
    ![endpoint, bucket, accessKey, secretKey].every(Boolean);
  if (partial) {
    issues.push(
      buildIssue(
        "s3-partial",
        "warning",
        "Object storage",
        "S3 configuration is partial. Set storage.object_store endpoint, bucket, access_key_id and secret_access_key together.",
      ),
    );
    recommendations.push("Complete the provider-neutral storage.object_store settings.");
  }
  return buildSection(
    "Object storage",
    [
      {
        key: "storage.object_store.endpoint",
        value: endpoint ?? null,
        status_hint: endpoint ? null : "Not configured",
      },
      {
        key: "storage.object_store.bucket",
        value: bucket ?? null,
        status_hint: bucket ? null : "Missing",
      },
      {
        key: "storage.object_store.access_key_id",
        // Standardize on setPresence across the section (matches
        // storage.object_store.secret_access_key below). The access-key half of the
        // pair is also a credential — the previous masked-prefix
        // exposure leaked the AWS account-recognizable prefix to any
        // identity:read principal.
        value: setPresence(accessKey),
        status_hint: accessKey ? null : "Missing",
      },
      {
        key: "storage.object_store.secret_access_key",
        value: setPresence(secretKey),
        status_hint: secretKey ? null : "Missing",
      },
      {
        key: "storage.object_store.session_token",
        value: setPresence(sessionToken),
        status_hint: sessionToken ? null : "Optional",
      },
    ],
    issues,
    recommendations,
  );
}

function buildCryptoSection(): SetupSection {
  // BOOTSTRAP_ONLY_ENV_KEYS in apps/engine/src/crypto/aes-gcm.ts is
  // the canonical list of env vars consumed BEFORE the config loader.
  // Today it's exactly ["MASTER_KEY"] and the diagnostic only knows
  // how to render that one key (length validation, status hint).
  // If a second var is ever added, this section needs to grow a row
  // per entry — the assertion below makes that visible at boot
  // instead of silently surfacing only the first.
  if (BOOTSTRAP_ONLY_ENV_KEYS.length !== 1 || BOOTSTRAP_ONLY_ENV_KEYS[0] !== "MASTER_KEY") {
    throw new Error(
      `BOOTSTRAP_ONLY_ENV_KEYS shape changed (${JSON.stringify(BOOTSTRAP_ONLY_ENV_KEYS)}); update buildCryptoSection to render every entry.`,
    );
  }
  const masterKey = present(process.env.MASTER_KEY);
  const issues: SetupIssue[] = [];
  const recommendations: string[] = [];
  // Detect deployment shape: production paths set STATE_DIRECTORY +
  // CONFIGURATION_DIRECTORY via the systemd unit; local dev does not.
  const envFilePath =
    typeof process.env.CONFIGURATION_DIRECTORY === "string" &&
    process.env.CONFIGURATION_DIRECTORY.length > 0
      ? `${process.env.CONFIGURATION_DIRECTORY.split(":")[0]}/.env`
      : ".env (repo root for local dev) or /etc/subkit/.env (systemd)";
  if (!masterKey) {
    issues.push(buildIssue("master-key", "blocker", "Master key", "MASTER_KEY is not set."));
    recommendations.push(
      `Set MASTER_KEY in ${envFilePath} to a 64-hex-character AES-256-GCM key (\`openssl rand -hex 32\`).`,
    );
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
        // setPresence — even 6 hex chars of MASTER_KEY in the
        // diagnostic surface is too much exposure for a non-admin
        // identity:read principal.
        value: setPresence(masterKey),
        status_hint: masterKey ? null : "Missing",
      },
    ],
    issues,
    recommendations,
  );
}

function buildPublicUrlsSection(snapshot: ReturnType<typeof getConfig>): SetupSection {
  const baseUrl = present(snapshot.server.public_base_url);
  const issues: SetupIssue[] = [];
  const recommendations: string[] = [];
  if (!baseUrl) {
    // Advisory only — NOT a warning. A correct local/trial install routinely
    // runs without a public base URL, and the code paths that genuinely need
    // it (OAuth callbacks, MCP resource origin, webhook links) already fail
    // with their own clear errors when it's missing. Surfacing it as a setup
    // `warning` was the lone reason a healthy fresh install showed ⚠, so it
    // lives in recommendations instead.
    recommendations.push(
      "For external webhooks, chat deeplinks, and OAuth callbacks, set a public base URL: `sk settings set server.public_base_url '\"https://...\"'` with the externally reachable engine URL.",
    );
  }
  return buildSection(
    "Public URLs",
    [
      {
        key: "server.public_base_url",
        value: baseUrl ?? null,
        status_hint: baseUrl ? null : "Missing",
      },
    ],
    issues,
    recommendations,
  );
}

function buildSetupValidation(): SetupResponse {
  // Read getConfig() once per request and thread the snapshot down so
  // every section sees a coherent point-in-time view of the config.
  // structuredClone is required: setConfigKey() mutates the live
  // config tree in place by replacing branches; sub-objects share
  // refs across reads. Without the deep clone a concurrent
  // setConfigKey mid-build could still flip a leaf the next builder
  // reads. The clone is one-shot per request, so the cost amortises
  // against the 6-section traversal that follows.
  const snapshot = structuredClone(getConfig());
  const sections = {
    auth: buildAuthSection(snapshot),
    llm: buildLlmSection(snapshot),
    datastore: buildDatastoreSection(snapshot),
    storage: buildStorageSection(snapshot),
    crypto: buildCryptoSection(),
    public_urls: buildPublicUrlsSection(snapshot),
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
  description:
    "Returns the GLOBAL config snapshot only — tenant overlays are not represented here. " +
    "Operators reading this expecting tenant-scoped settings should hit " +
    "`GET /v1/settings?tenant=<id>` instead. This route is intentionally global so admins " +
    "can validate the engine's bootstrap configuration without a tenant context.",
  security: [{ bearerAuth: [] }],
  responses: {
    200: {
      description: "OK",
      content: { "application/json": { schema: SetupResponseSchema } },
    },
    401: {
      description: "Unauthorized",
      content: { "application/json": { schema: ErrorSchema } },
    },
    403: {
      description: "Forbidden",
      content: { "application/json": { schema: ErrorSchema } },
    },
  },
});

export function registerSetupRoutes(app: OpenAPIHono<AppEnv>): void {
  app.openapi(setupRoute, async (c) => {
    requireAuth(c);
    return c.json(buildSetupValidation(), 200);
  });
}
