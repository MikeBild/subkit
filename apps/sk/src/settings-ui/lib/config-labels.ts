// Human-readable labels for engine config leaves.
//
// The engine's Zod schema is the source of truth for shape + types +
// long-form descriptions (`.describe(...)` strings), but it does NOT
// carry a short display label per leaf. This module ships those
// labels for the sk-cli UI so the operator sees "Primary AI provider"
// instead of "llm.provider".
//
// Why a CLI-side table and not a schema annotation:
//   1. Labels are presentation, not contract. The engine's OpenAPI
//      surface should keep using dotted paths so machine consumers
//      (cURL, SDKs, scripts) see a stable, namespaced identifier.
//   2. Labels are localization candidates. Pushing them into the
//      schema would couple the engine to a presentation locale.
//   3. The schema's `.describe(...)` strings are the long-form
//      "explain this setting" copy (rendered in the Config tab's
//      description footer); the short labels here render in the row.
//
// Coverage rule: every leaf that ships from the engine schema MUST
// appear in LABEL_BY_PATH. The walk test in
// `apps/sk/src/settings-ui/__tests__/config-labels.test.ts` enforces
// that — adding a new leaf without a label fails the suite.

/** Human label for the row body. Falls back to `formatLabel(path)`
 *  when a leaf is not in this table. */
export const LABEL_BY_PATH: Readonly<Record<string, string>> = {
  // ── Logging ────────────────────────────────────────────────────
  "log.level": "Log level",
  "log.format": "Log format",

  // ── HTTP server ────────────────────────────────────────────────
  "server.port": "HTTP port",
  "server.public_base_url": "Public base URL",

  // ── Database ───────────────────────────────────────────────────
  "database.url": "Postgres connection string",

  // ── LLM (top-level) ────────────────────────────────────────────
  "llm.provider": "Primary AI provider",
  "llm.model": "Primary AI model",
  "llm.api_key": "Primary API key",
  "llm.fallback_provider": "Fallback provider",
  "llm.fallback_model": "Fallback model",
  "llm.summarize_provider": "Summarization provider",
  "llm.summarize_model": "Summarization model",
  "llm.context_1m": "Enable 1M context",
  "llm.output_guard": "Output safety mode",

  // ── LLM providers ──────────────────────────────────────────────
  "llm.providers.anthropic.api_key": "Anthropic API key",
  "llm.providers.anthropic.model": "Anthropic default model",
  "llm.providers.anthropic.base_url": "Anthropic base URL",
  "llm.providers.openai.api_key": "OpenAI API key",
  "llm.providers.openai.model": "OpenAI default model",
  "llm.providers.openai.base_url": "OpenAI base URL",
  "llm.providers.gemini.api_key": "Gemini API key",
  "llm.providers.gemini.model": "Gemini default model",
  "llm.providers.gemini.base_url": "Gemini base URL",
  "llm.providers.azure.api_key": "Azure OpenAI API key",
  "llm.providers.azure.model": "Azure default model",
  "llm.providers.azure.base_url": "Azure base URL",
  "llm.providers.azure.resource_name": "Azure resource name",
  "llm.providers.azure.api_version": "Azure API version",
  "llm.providers.azure.use_deployment_based_urls": "Use deployment-based URLs",
  "llm.providers.bedrock.model": "Bedrock default model",
  "llm.providers.bedrock.region": "Bedrock AWS region",
  "llm.providers.bedrock.base_url": "Bedrock base URL",
  "llm.providers.bedrock.access_key_id": "Bedrock access key ID",
  "llm.providers.bedrock.secret_access_key": "Bedrock secret access key",
  "llm.providers.bedrock.session_token": "Bedrock session token",
  "llm.providers.vertex.api_key": "Vertex API key",
  "llm.providers.vertex.model": "Vertex default model",
  "llm.providers.vertex.project": "Vertex GCP project",
  "llm.providers.vertex.location": "Vertex GCP location",
  "llm.providers.vertex.client_email": "Vertex service-account email",
  "llm.providers.vertex.private_key": "Vertex service-account private key",
  "llm.providers.vertex.google_application_credentials": "Vertex credentials file",
  "llm.providers.ai_gateway.api_key": "AI Gateway API key",
  "llm.providers.ai_gateway.model": "AI Gateway default model",

  // ── LLM authoring critic ───────────────────────────────────────
  "llm.critic.enabled": "Enable authoring critic",
  "llm.critic.min_steps": "Critic minimum steps",
  "llm.critic.max_consecutive_rejections": "Critic max consecutive rejections",

  // ── Authentication ─────────────────────────────────────────────
  "auth.oidc.issuer_url": "OIDC issuer URL",
  "auth.oidc.client_id": "OIDC client ID",
  "auth.oidc.client_secret": "OIDC client secret",
  "auth.oidc.redirect_uri": "OIDC redirect URI",
  "auth.session.secret": "Session signing secret",
  "auth.firebase.project_id": "Firebase project ID",
  "auth.firebase.login_url": "Firebase login URL",

  // ── Chat platform integrations ─────────────────────────────────
  "platform.slack.signing_secret": "Slack signing secret",
  "platform.slack.client_id": "Slack client ID",
  "platform.slack.client_secret": "Slack client secret",
  "platform.teams.app_id": "Teams app ID",
  "platform.teams.app_password": "Teams app password",
  "platform.googlechat.project_id": "Google Chat project ID",

  // ── Storage ────────────────────────────────────────────────────
  "storage.s3.endpoint": "S3 endpoint",
  "storage.s3.access_key": "S3 access key",
  "storage.s3.secret_key": "S3 secret key",
  "storage.knowledge.backend": "Knowledge storage backend",
  "storage.knowledge.dir": "Knowledge local directory",
  "storage.offload.bucket": "Offload bucket",
  "storage.offload.region": "Offload region",
  "storage.offload.access_key": "Offload access key",
  "storage.offload.secret_key": "Offload secret key",
  "storage.offload.endpoint": "Offload endpoint",
  "storage.offload.key_prefix": "Offload key prefix",

  // ── Observability ──────────────────────────────────────────────
  "observability.langfuse.host": "Langfuse host",
  "observability.langfuse.public_key": "Langfuse public key",
  "observability.langfuse.secret_key": "Langfuse secret key",
  "observability.otlp.endpoint": "OTLP endpoint",
  "observability.otlp.service_name": "OTLP service name",

  // ── Network egress ─────────────────────────────────────────────
  "egress.mode": "Egress mode",
  "egress.provider_hosts_extra": "Allowed provider hosts",

  // ── MCP transport ──────────────────────────────────────────────
  "mcp.api_key": "MCP API key",
  "mcp.read_only": "Read-only MCP",

  // ── Errors / spec / queue / tokens ─────────────────────────────
  "errors.ring_size": "Error buffer size",
  "spec.allow_private_fetch": "Allow private spec fetches",
  "queue.concurrency": "Worker concurrency",
  "tokens.monthly_budget": "Monthly token budget",

  // ── REPL session preferences ───────────────────────────────────
  "repl.permissionMode": "Permission mode",
  "repl.portalTokenTtlMin": "Portal token TTL (minutes)",

  // ── REPL chrome ────────────────────────────────────────────────
  "ui.theme": "Theme",
  "ui.personality": "Assistant personality",
  "ui.title.format": "Window title format",
  "ui.statusline.format": "Status-line layout",

  // ── Notifications ──────────────────────────────────────────────
  "notifications.push.enabled": "Push notifications",
  "notifications.push.thresholdSec": "Push threshold (seconds)",
  "notifications.push.quietHoursStart": "Quiet hours start (HH:MM)",
  "notifications.push.quietHoursEnd": "Quiet hours end (HH:MM)",
};

/** Humanized section header used by the Config tab divider. Falls
 *  back to the raw section key (capitalized) when not in this table. */
export const SECTION_LABEL: Readonly<Record<string, string>> = {
  log: "Logging",
  server: "HTTP server",
  database: "Database",
  llm: "AI / LLM",
  auth: "Authentication",
  platform: "Chat platforms",
  storage: "Storage",
  observability: "Observability",
  egress: "Network egress",
  mcp: "MCP transport",
  errors: "Errors",
  spec: "API specs",
  queue: "Queue worker",
  tokens: "Token budgets",
  repl: "REPL session",
  ui: "REPL chrome",
  notifications: "Notifications",
};

/** Last-resort label derivation when a leaf isn't in the table.
 *  Takes the rightmost path segment, replaces `_` with spaces, and
 *  capitalizes the first letter. `llm.foo_bar` → "Foo bar". */
export function formatLabel(path: string): string {
  const last = path.split(".").pop() ?? path;
  return last
    .replace(/[_-]+/g, " ")
    .replace(/^./, (c) => c.toUpperCase())
    .trim();
}

/** Returns the curated label for a path, or a derived fallback. */
export function labelForPath(path: string): string {
  return LABEL_BY_PATH[path] ?? formatLabel(path);
}

/** Returns the curated section header, or a capitalized fallback. */
export function sectionLabel(section: string): string {
  return (
    SECTION_LABEL[section] ?? section.replace(/^./, (c) => c.toUpperCase()).replace(/[_-]+/g, " ")
  );
}
