import { z } from "zod";

export type FieldScope = "global" | "tenant";

export interface FieldMeta {
  secret?: boolean;
  scope?: FieldScope;
  requiresRestart?: boolean;
  [extra: string]: unknown;
}

const LLM_PROVIDERS = [
  "mock",
  "anthropic",
  "openai",
  "gemini",
  "azure",
  "bedrock",
  "vertex",
  "ai_gateway",
] as const;

const LlmProvider = z.enum(LLM_PROVIDERS);

const tenant = (m: Omit<FieldMeta, "scope"> = {}): FieldMeta => ({ ...m, scope: "tenant" });
const global = (m: Omit<FieldMeta, "scope"> = {}): FieldMeta => ({ ...m, scope: "global" });

const HttpProvider = z
  .object({
    api_key: z
      .string()
      .default("")
      .describe("API key for this provider")
      .meta(tenant({ secret: true })),
    model: z.string().default("").describe("Default model identifier").meta(tenant()),
    base_url: z.string().default("").describe("Optional base URL override").meta(global()),
  })
  .prefault({})
  .describe("HTTP provider connection details");

const AzureProvider = z
  .object({
    api_key: z
      .string()
      .default("")
      .meta(tenant({ secret: true })),
    model: z.string().default("").meta(tenant()),
    base_url: z.string().default("").meta(global()),
    resource_name: z.string().default("").meta(global()),
    api_version: z.string().default("").meta(global()),
    use_deployment_based_urls: z.boolean().default(false).meta(global()),
  })
  .prefault({})
  .describe("Azure OpenAI provider details");

const BedrockProvider = z
  .object({
    model: z.string().default("").meta(tenant()),
    region: z.string().default("").meta(global()),
    access_key_id: z
      .string()
      .default("")
      .meta(global({ secret: true })),
    secret_access_key: z
      .string()
      .default("")
      .meta(global({ secret: true })),
    session_token: z
      .string()
      .default("")
      .meta(global({ secret: true })),
    base_url: z.string().default("").meta(global()),
  })
  .prefault({})
  .describe("AWS Bedrock provider details");

const VertexProvider = z
  .object({
    api_key: z
      .string()
      .default("")
      .meta(tenant({ secret: true })),
    model: z.string().default("").meta(tenant()),
    project: z.string().default("").meta(global()),
    location: z.string().default("").meta(global()),
    client_email: z.string().default("").meta(global()),
    private_key: z
      .string()
      .default("")
      .meta(global({ secret: true })),
    google_application_credentials: z.string().default("").meta(global()),
  })
  .prefault({})
  .describe("Google Vertex AI provider details");

const AiGatewayProvider = z
  .object({
    api_key: z
      .string()
      .default("")
      .meta(global({ secret: true })),
    model: z.string().default("").meta(global()),
  })
  .prefault({})
  .describe("Vercel AI Gateway provider details");

const LogSection = z
  .object({
    level: z
      .enum(["trace", "debug", "info", "warn", "error", "fatal"])
      .default("info")
      .describe("Log verbosity")
      .meta(global()),
    format: z
      .enum(["dev", "pretty", "prod", "ndjson", "json"])
      .default("ndjson")
      .describe("Log output format")
      .meta(global()),
  })
  .prefault({})
  .describe("Logging");

const ServerSection = z
  .object({
    port: z
      .number()
      .int()
      .positive()
      .default(3000)
      .describe("HTTP port to bind")
      .meta(global({ requiresRestart: true })),
    tunnel_port: z
      .number()
      .int()
      .positive()
      .nullable()
      .default(null)
      .describe("Tunnel WebSocket port; null disables tunnels")
      .meta(global({ requiresRestart: true })),
    public_base_url: z
      .string()
      .default("")
      .describe("External-facing URL the engine resolves at (used by /install + chat link replies)")
      .meta(global()),
  })
  .prefault({})
  .describe("HTTP server");

const DatabaseSection = z
  .object({
    url: z
      .string()
      .min(1, "database.url is required")
      .describe("Postgres connection string")
      .meta(global({ requiresRestart: true, secret: true })),
  })
  .prefault({ url: "" })
  .describe("Database connection");

const LlmSection = z
  .object({
    provider: LlmProvider.default("mock").describe("Primary LLM provider").meta(tenant()),
    model: z.string().default("").describe("Primary model identifier").meta(tenant()),
    api_key: z
      .string()
      .default("")
      .describe("Primary LLM API key")
      .meta(tenant({ secret: true })),
    fallback_provider: LlmProvider.nullable()
      .default(null)
      .describe("Fallback provider on primary failure")
      .meta(tenant()),
    fallback_model: z.string().default("").describe("Fallback model identifier").meta(tenant()),
    summarize_provider: LlmProvider.nullable()
      .default(null)
      .describe("Provider used for summarization passes")
      .meta(tenant()),
    summarize_model: z
      .string()
      .default("")
      .describe("Model used for summarization passes")
      .meta(tenant()),
    context_1m: z
      .boolean()
      .default(false)
      .describe("Enable 1M context window where supported")
      .meta(tenant()),
    output_guard: z
      .enum(["soft", "hard", "off"])
      .default("soft")
      .describe(
        "LLM output safety mode (soft: rewrite + log, hard: throw, off: bypass — never use in production)",
      )
      .meta(global()),
    providers: z
      .object({
        anthropic: HttpProvider,
        openai: HttpProvider,
        gemini: HttpProvider,
        azure: AzureProvider,
        bedrock: BedrockProvider,
        vertex: VertexProvider,
        ai_gateway: AiGatewayProvider,
      })
      .prefault({})
      .describe("Per-provider connection details"),
  })
  .prefault({})
  .describe("LLM configuration");

const AuthSection = z
  .object({
    oidc: z
      .object({
        issuer_url: z
          .string()
          .default("")
          .meta(global({ requiresRestart: true })),
        client_id: z
          .string()
          .default("")
          .meta(global({ requiresRestart: true })),
        client_secret: z
          .string()
          .default("")
          .meta(global({ requiresRestart: true, secret: true })),
        redirect_uri: z
          .string()
          .default("")
          .meta(global({ requiresRestart: true })),
      })
      .prefault({})
      .describe("Generic OIDC provider"),
    session: z
      .object({
        secret: z
          .string()
          .default("")
          .describe(
            "Session signing secret (auto-generated to a 32-byte hex value on first boot if empty)",
          )
          .meta(global({ requiresRestart: true, secret: true })),
      })
      .prefault({})
      .describe("Session signing"),
    firebase: z
      .object({
        project_id: z
          .string()
          .default("")
          .meta(global({ requiresRestart: true })),
        login_url: z
          .string()
          .default("")
          .meta(global({ requiresRestart: true })),
      })
      .prefault({})
      .describe("Firebase authentication"),
  })
  .prefault({})
  .describe("Authentication");

const PlatformSection = z
  .object({
    slack: z
      .object({
        signing_secret: z
          .string()
          .default("")
          .meta(global({ secret: true })),
        client_id: z.string().default("").meta(global()),
        client_secret: z
          .string()
          .default("")
          .meta(global({ secret: true })),
      })
      .prefault({})
      .describe("Slack app"),
    teams: z
      .object({
        app_id: z.string().default("").meta(global()),
        app_password: z
          .string()
          .default("")
          .meta(global({ secret: true })),
      })
      .prefault({})
      .describe("Microsoft Teams"),
    googlechat: z
      .object({
        project_id: z.string().default("").meta(global()),
      })
      .prefault({})
      .describe("Google Chat"),
  })
  .prefault({})
  .describe("Chat platform integrations");

const StorageSection = z
  .object({
    s3: z
      .object({
        endpoint: z.string().default("").meta(global()),
        access_key: z
          .string()
          .default("")
          .meta(global({ secret: true })),
        secret_key: z
          .string()
          .default("")
          .meta(global({ secret: true })),
      })
      .prefault({})
      .describe("S3-compatible object store"),
    knowledge: z
      .object({
        backend: z.enum(["local", "s3"]).default("local").meta(global()),
        dir: z.string().default("").meta(global()),
      })
      .prefault({})
      .describe("Knowledge source storage"),
    offload: z
      .object({
        bucket: z
          .string()
          .default("")
          .describe("S3 bucket for execution-payload offload; empty disables offload")
          .meta(global()),
        region: z.string().default("").meta(global()),
        access_key: z
          .string()
          .default("")
          .meta(global({ secret: true })),
        secret_key: z
          .string()
          .default("")
          .meta(global({ secret: true })),
        endpoint: z
          .string()
          .default("")
          .describe("Optional S3 endpoint override (MinIO, R2, etc.)")
          .meta(global()),
        key_prefix: z.string().default("offload").meta(global()),
      })
      .prefault({})
      .describe("Execution-payload offload to S3"),
  })
  .prefault({})
  .describe("Storage backends");

const ObservabilitySection = z
  .object({
    langfuse: z
      .object({
        host: z
          .string()
          .default("")
          .meta(global({ requiresRestart: true })),
        public_key: z
          .string()
          .default("")
          .meta(global({ requiresRestart: true })),
        secret_key: z
          .string()
          .default("")
          .meta(global({ requiresRestart: true, secret: true })),
      })
      .prefault({})
      .describe("Langfuse trace ingestion"),
    otlp: z
      .object({
        endpoint: z
          .string()
          .default("")
          .meta(global({ requiresRestart: true })),
        service_name: z
          .string()
          .default("subkit")
          .meta(global({ requiresRestart: true })),
      })
      .prefault({})
      .describe("OpenTelemetry OTLP exporter"),
  })
  .prefault({})
  .describe("Observability");

const EgressSection = z
  .object({
    mode: z
      .enum(["strict", "permissive"])
      .nullable()
      .default(null)
      .describe(
        "Egress mode: strict blocks private/loopback hosts, permissive allows them. Null falls back to NODE_ENV default.",
      )
      .meta(global()),
    provider_hosts_extra: z
      .array(z.string())
      .default([])
      .describe("Extra hostnames the egress filter allows for LLM provider calls")
      .meta(global()),
  })
  .prefault({})
  .describe("Egress filter");

const McpSection = z
  .object({
    api_key: z
      .string()
      .default("")
      .meta(global({ secret: true })),
    read_only: z.boolean().default(false).meta(global()),
  })
  .prefault({})
  .describe("MCP transport");

const TunnelSection = z
  .object({
    registry_max: z.number().int().positive().default(100).meta(global()),
  })
  .prefault({})
  .describe("Tunnel registry");

const ErrorsSection = z
  .object({
    ring_size: z.number().int().positive().default(100).meta(global()),
  })
  .prefault({})
  .describe("Error ring buffer");

const DockerSection = z
  .object({
    host: z.string().default("").meta(global()),
    skip: z
      .boolean()
      .default(false)
      .describe("Skip Docker probes; useful for environments without Docker")
      .meta(global()),
  })
  .prefault({})
  .describe("Docker daemon");

const SpecSection = z
  .object({
    allow_private_fetch: z
      .boolean()
      .default(false)
      .describe("Allow OpenAPI spec fetches from private/loopback hosts (test-only)")
      .meta(global()),
  })
  .prefault({})
  .describe("Spec fetcher");

const QueueSection = z
  .object({
    concurrency: z.number().int().positive().max(64).default(8).meta(tenant()),
  })
  .prefault({})
  .describe("Queue worker");

const TokensSection = z
  .object({
    monthly_budget: z
      .number()
      .int()
      .nonnegative()
      .default(0)
      .describe("Hard cap on tokens consumed per calendar month. 0 = unlimited.")
      .meta(tenant()),
  })
  .prefault({})
  .describe("Token budget");

const TenantOverlaySchema = z
  .object({
    llm: z
      .object({
        provider: LlmProvider.optional(),
        model: z.string().optional(),
        api_key: z.string().optional(),
        fallback_provider: LlmProvider.nullable().optional(),
        fallback_model: z.string().optional(),
        summarize_provider: LlmProvider.nullable().optional(),
        summarize_model: z.string().optional(),
        context_1m: z.boolean().optional(),
        providers: z
          .object({
            anthropic: z
              .object({ api_key: z.string().optional(), model: z.string().optional() })
              .optional(),
            openai: z
              .object({ api_key: z.string().optional(), model: z.string().optional() })
              .optional(),
            gemini: z
              .object({ api_key: z.string().optional(), model: z.string().optional() })
              .optional(),
            azure: z
              .object({ api_key: z.string().optional(), model: z.string().optional() })
              .optional(),
            bedrock: z.object({ model: z.string().optional() }).optional(),
            vertex: z
              .object({ api_key: z.string().optional(), model: z.string().optional() })
              .optional(),
            ai_gateway: z.object({}).optional(),
          })
          .optional(),
      })
      .optional(),
    queue: z.object({ concurrency: z.number().int().positive().max(64).optional() }).optional(),
    tokens: z.object({ monthly_budget: z.number().int().nonnegative().optional() }).optional(),
  })
  .describe("Per-tenant overrides — only scope:tenant leaves may appear");

export const ConfigSchema = z
  .object({
    log: LogSection,
    server: ServerSection,
    database: DatabaseSection,
    llm: LlmSection,
    auth: AuthSection,
    platform: PlatformSection,
    storage: StorageSection,
    observability: ObservabilitySection,
    egress: EgressSection,
    mcp: McpSection,
    tunnel: TunnelSection,
    errors: ErrorsSection,
    docker: DockerSection,
    spec: SpecSection,
    queue: QueueSection,
    tokens: TokensSection,
    tenants: z
      .record(z.string(), TenantOverlaySchema)
      .prefault({})
      .describe("Per-tenant override map keyed by tenant_id"),
  })
  .describe("subkit runtime configuration");

export type Config = z.infer<typeof ConfigSchema>;
export type TenantOverlay = z.infer<typeof TenantOverlaySchema>;

const TENANT_OVERLAY_KEYS = ["llm", "queue", "tokens"] as const;
export type TenantOverlayKey = (typeof TENANT_OVERLAY_KEYS)[number];
export const TENANT_OVERLAY_SECTION_KEYS: ReadonlyArray<TenantOverlayKey> = TENANT_OVERLAY_KEYS;

export const SECTION_ORDER = [
  "log",
  "server",
  "database",
  "llm",
  "auth",
  "platform",
  "storage",
  "observability",
  "egress",
  "mcp",
  "tunnel",
  "errors",
  "docker",
  "spec",
  "queue",
  "tokens",
] as const;
export type SectionKey = (typeof SECTION_ORDER)[number];
