import { z } from "zod";

// Bootstrap-only env vars. Everything else lives in subkit.config.json
// (see apps/engine/src/config/schema.ts) and is read via getConfig()
// after loadConfig() resolves at boot.
//
// MASTER_KEY stays in env so it can be injected from a secret manager
// into the container without ever touching a plaintext file.
//
// NODE_ENV is read before any module code (Bun + several libraries
// branch on it), and SUBKIT_CONFIG steers the loader to a non-default
// config path.
const EnvSchema = z.object({
  NODE_ENV: z.enum(["development", "test", "production"]).default("development"),
  MASTER_KEY: z.string().regex(/^[0-9a-fA-F]{64}$/, "MASTER_KEY must be 64 hex chars (32 bytes)"),
  SUBKIT_CONFIG: z.string().optional(),
});

export type Env = z.infer<typeof EnvSchema>;

// Stale-env-var detection. v3.4.x operators may still have a populated
// .env from before the v3.5 config-file migration. Surface the keys
// that have moved so the operator can copy them into subkit.config.json
// instead of silently relying on env.
const RETIRED_ENV_KEYS = new Set([
  // Server / logging — moved to log.* and server.*
  "LOG_LEVEL",
  "LOG_FORMAT",
  "PORT",
  "TUNNEL_PORT",
  "PUBLIC_BASE_URL",
  "DATABASE_URL", // bridge: still consulted as a fallback when database.url is absent
  // LLM — moved to llm.* and llm.providers.*
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
  // Storage — moved to storage.s3.* / storage.knowledge.* / storage.offload.*
  "S3_ENDPOINT",
  "S3_ACCESS_KEY",
  "S3_SECRET_KEY",
  "S3_OFFLOAD_BUCKET",
  "S3_OFFLOAD_REGION",
  "S3_OFFLOAD_ACCESS_KEY",
  "S3_OFFLOAD_SECRET_KEY",
  "S3_OFFLOAD_ENDPOINT",
  "S3_OFFLOAD_KEY_PREFIX",
  // Chat platforms — moved to platform.*
  "SLACK_SIGNING_SECRET",
  "SLACK_CLIENT_ID",
  "SLACK_CLIENT_SECRET",
  "TEAMS_APP_ID",
  "TEAMS_APP_PASSWORD",
  "GOOGLE_CHAT_PROJECT_ID",
  // Auth — moved to auth.*
  "OIDC_ISSUER_URL",
  "OIDC_CLIENT_ID",
  "OIDC_CLIENT_SECRET",
  "OIDC_REDIRECT_URI",
  "SESSION_SECRET",
  "FIREBASE_PROJECT_ID",
  "FIREBASE_LOGIN_URL",
  // Observability — moved to observability.*
  "LANGFUSE_SECRET_KEY",
  "LANGFUSE_PUBLIC_KEY",
  "LANGFUSE_BASE_URL",
  "OTEL_EXPORTER_OTLP_ENDPOINT",
  "OTEL_SERVICE_NAME",
  // MCP — moved to mcp.*
  "SK_MCP_READ_ONLY",
  // Egress / connectors — moved to egress.* and spec.*
  "EGRESS_GUARD",
  "SUBKIT_LLM_PROVIDER_HOSTS_EXTRA",
  "SUBKIT_ALLOW_PRIVATE_SPEC_FETCH",
  "SUBKIT_PUBLIC_BASE_URL",
  // Tunnel
  "SUBKIT_TUNNEL_REGISTRY_MAX",
  // Feature flags
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

  // Warn on retired env vars that operators may still be setting.
  // Output via stderr (bypassing the structured logger) because env
  // resolution can run before the logger is wired in some test paths.
  const retired = Object.keys(process.env).filter((k) => RETIRED_ENV_KEYS.has(k));
  if (retired.length > 0 && process.env.NODE_ENV !== "test") {
    process.stderr.write(
      `[env] retired env vars detected: ${retired.join(", ")}. ` +
        `Move these into subkit.config.json (\`sk settings configure\`) — ` +
        `they are ignored by v3.5+ except DATABASE_URL which is still ` +
        `consulted as a fallback when database.url is unset.\n`,
    );
  }

  return parsed.data;
}

let _resolved: Env | null = null;
function resolveEnv(): Env {
  if (_resolved === null) _resolved = parseEnv();
  return _resolved;
}

// Lazy facade — same shape as v3.4 so existing call sites keep
// working. Only MASTER_KEY / NODE_ENV / SUBKIT_CONFIG are exposed.
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

export function _resetEnvCacheForTests(): void {
  _resolved = null;
}
