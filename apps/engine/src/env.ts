import { z } from "zod";

const LlmProviderSchema = z.enum([
  "mock",
  "anthropic",
  "openai",
  "gemini",
  "azure",
  "bedrock",
  "vertex",
]);

const EnvSchema = z.object({
  NODE_ENV: z.enum(["development", "test", "production"]).default("development"),
  LOG_LEVEL: z.enum(["trace", "debug", "info", "warn", "error", "fatal"]).default("info"),
  LOG_FORMAT: z.enum(["dev", "pretty", "prod", "ndjson", "json"]).optional(),

  // 3000 matches `.env.example` and the operator quickstart docs. An
  // operator who runs `bun start` without an env file lands on the same
  // port the docs and curl examples assume.
  PORT: z.coerce.number().int().positive().default(3000),
  TUNNEL_PORT: z.coerce.number().int().positive().optional(),
  PUBLIC_BASE_URL: z.string().url().optional(),

  DATABASE_URL: z.string().min(1, "DATABASE_URL is required"),
  MASTER_KEY: z.string().regex(/^[0-9a-fA-F]{64}$/, "MASTER_KEY must be 64 hex chars (32 bytes)"),

  LLM_PROVIDER: LlmProviderSchema.optional(),
  LLM_FALLBACK_PROVIDER: LlmProviderSchema.optional(),
  SUMMARIZE_LLM_PROVIDER: LlmProviderSchema.optional(),
  AI_GATEWAY_API_KEY: z.string().optional(),
  AI_GATEWAY_MODEL: z.string().optional(),
  LLM_PRIMARY: z.string().optional(),
  LLM_FALLBACK: z.string().optional(),
  SUMMARIZE_MODEL: z.string().optional(),
  ANTHROPIC_API_KEY: z.string().optional(),
  ANTHROPIC_MODEL: z.string().optional(),
  ANTHROPIC_BASE_URL: z.string().optional(),
  OPENAI_API_KEY: z.string().optional(),
  OPENAI_MODEL: z.string().optional(),
  OPENAI_BASE_URL: z.string().optional(),
  GEMINI_API_KEY: z.string().optional(),
  GEMINI_MODEL: z.string().optional(),
  GEMINI_BASE_URL: z.string().optional(),
  AZURE_API_KEY: z.string().optional(),
  AZURE_MODEL: z.string().optional(),
  AZURE_BASE_URL: z.string().optional(),
  AZURE_RESOURCE_NAME: z.string().optional(),
  AZURE_API_VERSION: z.string().optional(),
  AZURE_USE_DEPLOYMENT_BASED_URLS: z.string().optional(),
  BEDROCK_MODEL: z.string().optional(),
  AWS_REGION: z.string().optional(),
  AWS_ACCESS_KEY_ID: z.string().optional(),
  AWS_SECRET_ACCESS_KEY: z.string().optional(),
  AWS_SESSION_TOKEN: z.string().optional(),
  AWS_BASE_URL: z.string().optional(),
  VERTEX_MODEL: z.string().optional(),
  VERTEX_API_KEY: z.string().optional(),
  VERTEX_PROJECT: z.string().optional(),
  VERTEX_LOCATION: z.string().optional(),
  VERTEX_CLIENT_EMAIL: z.string().optional(),
  VERTEX_PRIVATE_KEY: z.string().optional(),
  GOOGLE_APPLICATION_CREDENTIALS: z.string().optional(),

  S3_ENDPOINT: z.string().optional(),
  S3_ACCESS_KEY: z.string().optional(),
  S3_SECRET_KEY: z.string().optional(),

  DOCKER_HOST: z.string().optional(),

  SLACK_SIGNING_SECRET: z.string().optional(),
  SLACK_CLIENT_ID: z.string().optional(),
  SLACK_CLIENT_SECRET: z.string().optional(),

  TEAMS_APP_ID: z.string().optional(),
  TEAMS_APP_PASSWORD: z.string().optional(),

  GOOGLE_CHAT_PROJECT_ID: z.string().optional(),

  OIDC_ISSUER_URL: z.string().optional(),
  FIREBASE_PROJECT_ID: z.string().optional(),
  FIREBASE_LOGIN_URL: z.string().optional(),

  /**
   * llmOutputGuard mode.
   * - `soft` (default): scan, log, rewrite the offending fragment; turn continues.
   * - `hard` (CI / scenarios): scan; on violation throw `LlmOutputViolation` so tests fail.
   * - `off`: bypass entirely (emergency escape only — never use in production).
   */
  LLM_OUTPUT_GUARD: z.enum(["soft", "hard", "off"]).default("soft"),
});

export type Env = z.infer<typeof EnvSchema>;

export interface LlmEnvValidationOptions {
  providerEnvVar?: string;
  fallbackProviderEnvVar?: string | null;
  requireConfigured?: boolean;
}

function envString(env: Record<string, unknown>, key: string): string | undefined {
  const value = env[key];
  return typeof value === "string" ? value : undefined;
}

function collectProviderIssues(env: Record<string, unknown>, providerEnvVar: string): string[] {
  const issues: string[] = [];
  const provider = envString(env, providerEnvVar);
  if (!provider || provider === "mock") return issues;
  switch (provider) {
    case "anthropic":
      if (!envString(env, "ANTHROPIC_API_KEY")) {
        issues.push("ANTHROPIC_API_KEY is required for anthropic mode");
      }
      break;
    case "openai":
      if (!envString(env, "OPENAI_API_KEY"))
        issues.push("OPENAI_API_KEY is required for openai mode");
      break;
    case "gemini":
      if (!envString(env, "GEMINI_API_KEY"))
        issues.push("GEMINI_API_KEY is required for gemini mode");
      break;
    case "azure":
      if (!envString(env, "AZURE_API_KEY")) issues.push("AZURE_API_KEY is required for azure mode");
      if (!envString(env, "AZURE_RESOURCE_NAME") && !envString(env, "AZURE_BASE_URL")) {
        issues.push("Either AZURE_RESOURCE_NAME or AZURE_BASE_URL is required for azure mode");
      }
      break;
    case "bedrock":
      if (!envString(env, "AWS_REGION")) issues.push("AWS_REGION is required for bedrock mode");
      if (!envString(env, "AWS_ACCESS_KEY_ID")) {
        issues.push("AWS_ACCESS_KEY_ID is required for bedrock mode");
      }
      if (!envString(env, "AWS_SECRET_ACCESS_KEY")) {
        issues.push("AWS_SECRET_ACCESS_KEY is required for bedrock mode");
      }
      break;
    case "vertex":
      if (
        !envString(env, "VERTEX_API_KEY") &&
        !(envString(env, "VERTEX_CLIENT_EMAIL") && envString(env, "VERTEX_PRIVATE_KEY")) &&
        !envString(env, "GOOGLE_APPLICATION_CREDENTIALS")
      ) {
        issues.push(
          "VERTEX_API_KEY, VERTEX_CLIENT_EMAIL + VERTEX_PRIVATE_KEY, or GOOGLE_APPLICATION_CREDENTIALS is required for vertex mode",
        );
      }
      break;
  }
  return issues.map((issue) => `${providerEnvVar}: ${issue}`);
}

export function listLlmEnvironmentIssues(
  env: Record<string, unknown>,
  options: LlmEnvValidationOptions = {},
): string[] {
  const providerEnvVar = options.providerEnvVar ?? "LLM_PROVIDER";
  const fallbackProviderEnvVar =
    options.fallbackProviderEnvVar === undefined
      ? "LLM_FALLBACK_PROVIDER"
      : options.fallbackProviderEnvVar;
  const issues: string[] = [];
  const gatewayKeySet = Boolean(envString(env, "AI_GATEWAY_API_KEY"));
  const gatewayModelSet = Boolean(envString(env, "AI_GATEWAY_MODEL"));
  if (gatewayKeySet !== gatewayModelSet) {
    issues.push("AI_GATEWAY_API_KEY and AI_GATEWAY_MODEL must be set together");
  }
  issues.push(...collectProviderIssues(env, providerEnvVar));
  if (fallbackProviderEnvVar && fallbackProviderEnvVar !== providerEnvVar) {
    issues.push(...collectProviderIssues(env, fallbackProviderEnvVar));
  }
  if (
    fallbackProviderEnvVar &&
    envString(env, fallbackProviderEnvVar) &&
    !envString(env, providerEnvVar) &&
    !(gatewayKeySet && gatewayModelSet)
  ) {
    issues.push(
      `${fallbackProviderEnvVar} requires a primary route via AI_GATEWAY_API_KEY + AI_GATEWAY_MODEL or ${providerEnvVar}`,
    );
  }
  if (
    options.requireConfigured &&
    !((gatewayKeySet && gatewayModelSet) || Boolean(envString(env, providerEnvVar)))
  ) {
    issues.push(
      `No LLM provider configured. Set AI_GATEWAY_API_KEY + AI_GATEWAY_MODEL or ${providerEnvVar}.`,
    );
  }
  return issues;
}

export function validateLlmEnvironment(
  env: Record<string, unknown>,
  options: LlmEnvValidationOptions = {},
): void {
  const issues = listLlmEnvironmentIssues(env, options);
  if (issues.length > 0) {
    throw new Error(
      `Invalid LLM environment:\n${issues.map((issue) => `  - ${issue}`).join("\n")}`,
    );
  }
}

function parseEnv(): Env {
  const parsed = EnvSchema.safeParse(process.env);
  if (!parsed.success) {
    const issues = parsed.error.issues
      .map((i) => `  - ${i.path.join(".") || "(root)"}: ${i.message}`)
      .join("\n");
    throw new Error(`Invalid environment:\n${issues}`);
  }
  validateLlmEnvironment(parsed.data);
  return parsed.data;
}

// Lazy facade. parseEnv() runs on the first property read, not at
// module load. That keeps `engine --smoke`, `engine --version`,
// `engine --check-update`, and `engine --self-update` runnable without
// a configured DATABASE_URL/MASTER_KEY: the binary loads modules but
// never touches `env.X`, so the strict schema never fires. Pre-fix the
// eager `parseEnv()` at the bottom of this file made arg-only flags
// fail before main() ever ran — the matrix smoke step in release.yml
// could only succeed against a fully-configured runner.
//
// Once any caller reads a field, the result is memoised, so the cost
// is one parse + validation per process — same as before.
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

// Test-only — let suites reset the cache between cases that mutate
// process.env. Production code never calls this.
export function _resetEnvCacheForTests(): void {
  _resolved = null;
}
