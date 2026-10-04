import { z } from "zod";

const EnvSchema = z.object({
  NODE_ENV: z.enum(["development", "test", "production"]).default("development"),
  MASTER_KEY: z.string().regex(/^[0-9a-fA-F]{64}$/, "MASTER_KEY must be 64 hex chars (32 bytes)"),
  DATABASE_URL: z.string().min(1).optional(),
  ENGINE_LISTEN_HOST: z.string().min(1).optional(),
  PORT: z.coerce.number().int().min(1).max(65_535).optional(),
  SUBKIT_BOOTSTRAP_KEY: z.string().min(64).max(128).optional(),
  OBJECT_STORAGE_ENDPOINT: z.string().url().optional(),
  OBJECT_STORAGE_REGION: z.string().min(1).optional(),
  OBJECT_STORAGE_BUCKET: z.string().min(1).optional(),
  OBJECT_STORAGE_ACCESS_KEY_ID: z.string().min(1).optional(),
  OBJECT_STORAGE_SECRET_ACCESS_KEY: z.string().min(1).optional(),
  OBJECT_STORAGE_SESSION_TOKEN: z.string().min(1).optional(),
  OBJECT_STORAGE_PATH_STYLE: z.enum(["true", "false", "1", "0"]).optional(),
  OBJECT_STORAGE_FORCE_PATH_STYLE: z.enum(["true", "false", "1", "0"]).optional(),
});

export type Env = z.infer<typeof EnvSchema>;

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
  "SK_MCP_READ_ONLY",
  "EGRESS_GUARD",
  "SUBKIT_LLM_PROVIDER_HOSTS_EXTRA",
  "SUBKIT_ALLOW_PRIVATE_SPEC_FETCH",
  "SUBKIT_PUBLIC_BASE_URL",
  "LLM_CONTEXT_1M",
  "SK_ERROR_RING_SIZE",
  "SKIP_DOCKER",
]);

function parseEnv(): Env {
  const parsed = EnvSchema.safeParse(process.env);
  if (!parsed.success) {
    const issues = parsed.error.issues
      .map((i) => `  - ${i.path.join(".") || "(root)"}: ${i.message}`)
      .join("\n");
    throw new Error(`Invalid environment:\n${issues}`);
  }

  const retired = Object.keys(process.env).filter((k) => RETIRED_ENV_KEYS.has(k));
  if (retired.length > 0 && process.env.NODE_ENV !== "test") {
    process.stderr.write(
      `[env] retired env vars detected: ${retired.join(", ")}. ` +
        `Move these into the PostgreSQL-backed settings API (Cockpit, HTTP, MCP, or \`sk settings configure\`) — ` +
        `they are ignored after the initial runtime revision.\n`,
    );
  }

  return parsed.data;
}

let _resolved: Env | null = null;
function resolveEnv(): Env {
  if (_resolved === null) _resolved = parseEnv();
  return _resolved;
}

export const env: Env = new Proxy({} as Env, {
  get(_target, prop) {
    return resolveEnv()[prop as keyof Env];
  },
  has(_target, prop) {
    return prop in resolveEnv();
  },
  ownKeys() {
    return Reflect.ownKeys(resolveEnv());
  },
  getOwnPropertyDescriptor(_target, prop) {
    return Object.getOwnPropertyDescriptor(resolveEnv(), prop);
  },
});
