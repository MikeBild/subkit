import { z } from "zod";

const text = z.string().optional();

const EnvSchema = z.object({
  NODE_ENV: text,
  MASTER_KEY: text,
  DATABASE_URL: text,
  ENGINE_LISTEN_HOST: text,
  PORT: text,
  PATH: text,
  SYSTEMROOT: text,
  ENGINE_VERSION: text,
  SUBKIT_BOOTSTRAP_KEY: text,
  SUBKIT_CONFIG: text,
  CONFIGURATION_DIRECTORY: text,
  STATE_DIRECTORY: text,
  JOURNAL_STREAM: text,
  SUBKIT_DEPLOYMENT_MODE: text,
  SUBKIT_LOCAL_PORT: text,
  SUBKIT_REPLICA_ID: text,
  SUBKIT_BINARIES_DIR: text,
  OBJECT_STORAGE_ENDPOINT: text,
  OBJECT_STORAGE_REGION: text,
  OBJECT_STORAGE_BUCKET: text,
  OBJECT_STORAGE_ACCESS_KEY_ID: text,
  OBJECT_STORAGE_SECRET_ACCESS_KEY: text,
  OBJECT_STORAGE_SESSION_TOKEN: text,
  OBJECT_STORAGE_PATH_STYLE: text,
  OBJECT_STORAGE_FORCE_PATH_STYLE: text,
  OBJECT_STORAGE_BACKEND: text,
  OBJECT_STORAGE_ROOT: text,
  SPEECH_MODEL_DIR: text,
  HTTP_PROXY: text,
  HTTPS_PROXY: text,
  ALL_PROXY: text,
  http_proxy: text,
  https_proxy: text,
  all_proxy: text,
  SUBKIT_MCP_MODE: text,
  SUBKIT_PLAYWRIGHT_ENTRY: text,
  SUBKIT_LOG_SD_DAEMON: text,
  SUBKIT_LOG_RING_SIZE: text,
  SUBKIT_HEAP_DIAG: text,
  SUBKIT_DIAGNOSTICS: text,
  SUBKIT_DIAGNOSTICS_EMBEDDING_INLINE: text,
  SUBKIT_DIAGNOSTICS_INTERVAL_MS: text,
  SUBKIT_DIAGNOSTICS_MAX_SAMPLES: text,
  SUBKIT_DIAGNOSTICS_MAX_QUERY_EVENTS: text,
  SUBKIT_DIAGNOSTICS_GC: text,
  SUBKIT_DIAGNOSTICS_LOCK_SNAPSHOT: text,
  PAGINATION_CHECKPOINT_INTERVAL: text,
  WAIT_FOR_EVENT_HMAC_SECRET: text,
  WAIT_FOR_EVENT_HMAC_SECRET_PREVIOUS: text,
  DOCS_CRAWL_POSITIVE_HIGH: text,
  DOCS_CRAWL_POSITIVE_LOW: text,
  DOCS_CRAWL_NEGATIVE: text,
  DOCS_INGESTION_MAX_BYTES_PER_CONNECTOR: text,
  DOCS_INGESTION_MAX_BYTES_PER_DOC: text,
  DOCS_INGESTION_MAX_LINKS: text,
  DOCS_INGESTION_MAX_SPECS: text,
  KNOWLEDGE_SOURCE_MAX_BYTES: text,
  KNOWLEDGE_TENANT_MAX_BYTES: text,
  LLM_PROVIDER: text,
  LLM_FALLBACK_PROVIDER: text,
  SUMMARIZE_LLM_PROVIDER: text,
  SUMMARIZE_MODEL: text,
  ANTHROPIC_API_KEY: text,
  ANTHROPIC_MODEL: text,
  ANTHROPIC_BASE_URL: text,
  OPENAI_API_KEY: text,
  OPENAI_MODEL: text,
  OPENAI_BASE_URL: text,
  GEMINI_API_KEY: text,
  GEMINI_MODEL: text,
  GEMINI_BASE_URL: text,
  AZURE_API_KEY: text,
  AZURE_MODEL: text,
  AZURE_BASE_URL: text,
  AZURE_RESOURCE_NAME: text,
  AZURE_API_VERSION: text,
  AZURE_USE_DEPLOYMENT_BASED_URLS: text,
  BEDROCK_MODEL: text,
  AWS_REGION: text,
  AWS_ACCESS_KEY_ID: text,
  AWS_SECRET_ACCESS_KEY: text,
  AWS_SESSION_TOKEN: text,
  AWS_BASE_URL: text,
  VERTEX_API_KEY: text,
  VERTEX_MODEL: text,
  VERTEX_PROJECT: text,
  VERTEX_LOCATION: text,
  VERTEX_CLIENT_EMAIL: text,
  VERTEX_PRIVATE_KEY: text,
  GOOGLE_APPLICATION_CREDENTIALS: text,
  GOOGLE_VERTEX_PROJECT: text,
  GOOGLE_VERTEX_LOCATION: text,
  AI_GATEWAY_API_KEY: text,
  AI_GATEWAY_MODEL: text,
  GENERATE_LLM_PROVIDER: text,
  GENERATE_MODEL: text,
  EXTRACT_LLM_PROVIDER: text,
  EXTRACT_MODEL: text,
  CATALOG_DESCRIBE_LLM_PROVIDER: text,
  CATALOG_DESCRIBE_MODEL: text,
  REPAIR_LLM_PROVIDER: text,
  REPAIR_MODEL: text,
  TOOL_REPAIR_LLM_PROVIDER: text,
  TOOL_REPAIR_MODEL: text,
  CONVERSE_LLM_PROVIDER: text,
  CONVERSE_MODEL: text,
  DISCOVER_LLM_PROVIDER: text,
  DISCOVER_MODEL: text,
  SUGGEST_NEXT_LLM_PROVIDER: text,
  SUGGEST_NEXT_MODEL: text,
  CRITIC_AUTHORING_LLM_PROVIDER: text,
  CRITIC_AUTHORING_MODEL: text,
  JUDGE_LLM_PROVIDER: text,
  JUDGE_MODEL: text,
  WORKFLOW_STEP_LLM_PROVIDER: text,
  WORKFLOW_STEP_MODEL: text,
});

export type EnvKey = keyof z.infer<typeof EnvSchema>;
export type EnvRecord = Readonly<Partial<Record<EnvKey, string>>>;

const ENV_KEYS = Object.keys(EnvSchema.shape) as EnvKey[];

const BootEnvSchema = z.object({
  NODE_ENV: z.enum(["development", "test", "production"]).optional(),
  MASTER_KEY: z.string().regex(/^[0-9a-fA-F]{64}$/, "MASTER_KEY must be 64 hex chars (32 bytes)"),
  PORT: z.coerce.number().int().min(1).max(65_535).optional(),
  SUBKIT_BOOTSTRAP_KEY: z.string().min(64).max(128).optional(),
  OBJECT_STORAGE_ENDPOINT: z.string().url().optional(),
  OBJECT_STORAGE_PATH_STYLE: z.enum(["true", "false", "1", "0"]).optional(),
  OBJECT_STORAGE_FORCE_PATH_STYLE: z.enum(["true", "false", "1", "0"]).optional(),
  OBJECT_STORAGE_BACKEND: z.enum(["s3", "filesystem"]).optional(),
  SUBKIT_DEPLOYMENT_MODE: z.enum(["server", "local_workspace"]).optional(),
});

const RETIRED_ENV_KEYS = new Set([
  "LOG_LEVEL",
  "LOG_FORMAT",
  "PUBLIC_BASE_URL",
  "LLM_PROVIDER",
  "LLM_FALLBACK_PROVIDER",
  "SUMMARIZE_LLM_PROVIDER",
  "AI_GATEWAY_API_KEY",
  "AI_GATEWAY_MODEL",
  "LLM_PRIMARY",
  "LLM_FALLBACK",
  "SUMMARIZE_MODEL",
  "ANTHROPIC_API_KEY",
  "ANTHROPIC_MODEL",
  "ANTHROPIC_BASE_URL",
  "OPENAI_API_KEY",
  "OPENAI_MODEL",
  "OPENAI_BASE_URL",
  "GEMINI_API_KEY",
  "GEMINI_MODEL",
  "GEMINI_BASE_URL",
  "AZURE_API_KEY",
  "AZURE_MODEL",
  "AZURE_BASE_URL",
  "AZURE_RESOURCE_NAME",
  "AZURE_API_VERSION",
  "AZURE_USE_DEPLOYMENT_BASED_URLS",
  "BEDROCK_MODEL",
  "AWS_REGION",
  "AWS_ACCESS_KEY_ID",
  "AWS_SECRET_ACCESS_KEY",
  "AWS_SESSION_TOKEN",
  "AWS_BASE_URL",
  "VERTEX_MODEL",
  "VERTEX_API_KEY",
  "VERTEX_PROJECT",
  "VERTEX_LOCATION",
  "VERTEX_CLIENT_EMAIL",
  "VERTEX_PRIVATE_KEY",
  "GOOGLE_APPLICATION_CREDENTIALS",
  "LLM_OUTPUT_GUARD",
  "S3_ENDPOINT",
  "S3_ACCESS_KEY",
  "S3_SECRET_KEY",
  "S3_OFFLOAD_BUCKET",
  "S3_OFFLOAD_REGION",
  "S3_OFFLOAD_ACCESS_KEY",
  "S3_OFFLOAD_SECRET_KEY",
  "S3_OFFLOAD_ENDPOINT",
  "S3_OFFLOAD_KEY_PREFIX",
  "SLACK_SIGNING_SECRET",
  "SLACK_CLIENT_ID",
  "SLACK_CLIENT_SECRET",
  "TEAMS_APP_ID",
  "TEAMS_APP_PASSWORD",
  "GOOGLE_CHAT_PROJECT_ID",
  "SESSION_SECRET",
  "LANGFUSE_SECRET_KEY",
  "LANGFUSE_PUBLIC_KEY",
  "LANGFUSE_BASE_URL",
  "OTEL_EXPORTER_OTLP_ENDPOINT",
  "OTEL_SERVICE_NAME",
  "SUBKIT_MCP_READ_ONLY",
  "EGRESS_GUARD",
  "SUBKIT_LLM_PROVIDER_HOSTS_EXTRA",
  "SUBKIT_ALLOW_PRIVATE_SPEC_FETCH",
  "SUBKIT_PUBLIC_BASE_URL",
  "LLM_CONTEXT_1M",
  "SUBKIT_ERROR_RING_SIZE",
  "SKIP_DOCKER",
]);

function issueLines(error: z.ZodError): string {
  return error.issues.map((i) => `  - ${i.path.join(".") || "(root)"}: ${i.message}`).join("\n");
}

function rawEnv(key: EnvKey): string | undefined {
  const value = process.env[key];
  return value === undefined || value.length === 0 ? undefined : value;
}

export function isEnvKey(name: string): name is EnvKey {
  return Object.hasOwn(EnvSchema.shape, name);
}

export function readEnv(key: EnvKey): string | undefined {
  return rawEnv(key);
}

export function envSnapshot(): EnvRecord {
  const out: Partial<Record<EnvKey, string>> = {};
  for (const key of ENV_KEYS) {
    const value = rawEnv(key);
    if (value !== undefined) out[key] = value;
  }
  return out;
}

export function envFlag(key: EnvKey): boolean {
  return rawEnv(key) === "1";
}

export function envInt(key: EnvKey, fallback: number): number {
  const raw = rawEnv(key);
  if (raw === undefined) return fallback;
  const n = Number(raw);
  if (!Number.isFinite(n) || n <= 0) return fallback;
  return Math.floor(n);
}

export function envList(key: EnvKey, fallback: readonly string[]): readonly string[] {
  const raw = rawEnv(key);
  if (raw === undefined) return fallback;
  const parts = raw
    .split(",")
    .map((s) => s.trim())
    .filter((s) => s.length > 0);
  return parts.length === 0 ? fallback : parts;
}

export function validateEnv(): void {
  const parsed = BootEnvSchema.safeParse(envSnapshot());
  if (!parsed.success) throw new Error(`Invalid environment:\n${issueLines(parsed.error)}`);
  const retired = Object.keys(process.env).filter((k) => RETIRED_ENV_KEYS.has(k));
  if (retired.length > 0 && rawEnv("NODE_ENV") !== "test") {
    process.stderr.write(
      `[env] retired env vars detected: ${retired.join(", ")}. ` +
        `Move these into the PostgreSQL-backed settings API (Cockpit, HTTP, MCP, or \`subkit settings configure\`) — ` +
        `they are ignored after the initial runtime revision.\n`,
    );
  }
}
