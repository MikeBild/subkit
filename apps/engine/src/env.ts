import { z } from "zod";

const EnvSchema = z.object({
  NODE_ENV: z.enum(["development", "test", "production"]).default("development"),
  LOG_LEVEL: z.enum(["trace", "debug", "info", "warn", "error", "fatal"]).default("info"),
  LOG_FORMAT: z.enum(["dev", "pretty", "prod", "ndjson", "json"]).optional(),

  PORT: z.coerce.number().int().positive().default(4000),
  TUNNEL_PORT: z.coerce.number().int().positive().optional(),
  PUBLIC_BASE_URL: z.string().url().optional(),

  DATABASE_URL: z.string().min(1, "DATABASE_URL is required"),
  MASTER_KEY: z.string().regex(/^[0-9a-fA-F]{64}$/, "MASTER_KEY must be 64 hex chars (32 bytes)"),

  LLM_PRIMARY: z.string().optional(),
  LLM_FALLBACK: z.string().optional(),
  ANTHROPIC_API_KEY: z.string().optional(),

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
});

export type Env = z.infer<typeof EnvSchema>;

function parseEnv(): Env {
  const parsed = EnvSchema.safeParse(process.env);
  if (!parsed.success) {
    const issues = parsed.error.issues
      .map((i) => `  - ${i.path.join(".") || "(root)"}: ${i.message}`)
      .join("\n");
    throw new Error(`Invalid environment:\n${issues}`);
  }
  return parsed.data;
}

export const env: Env = parseEnv();
