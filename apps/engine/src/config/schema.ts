import { z } from "zod";
import { hostedRegistrationPolicyError } from "./hosted-registration-policy.ts";

export type FieldScope = "global" | "tenant";

export interface FieldMeta {
  secret?: boolean;
  scope?: FieldScope;
  requiresRestart?: boolean;
  structural?: boolean;
  runtimeEditable?: boolean;
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

const optionalUrl = z.union([z.literal(""), z.string().url()]);

const ServerSection = z
  .object({
    hosted_rate_limit: z
      .object({
        tenant_per_month: z
          .number()
          .int()
          .min(0)
          .max(1000000)
          .default(0)
          .describe(
            "Operator request allowance per hosted tenant and UTC calendar month; zero denies hosted requests",
          )
          .meta(global()),
        principal_per_minute: z
          .number()
          .int()
          .min(0)
          .max(1000000)
          .default(0)
          .describe(
            "Operator request ceiling per authenticated principal and tenant per minute; zero denies hosted requests",
          )
          .meta(global()),
        peer_per_minute: z
          .number()
          .int()
          .min(0)
          .max(1000000)
          .default(0)
          .describe(
            "Operator request ceiling per verified connection peer and minute; zero denies hosted ingress",
          )
          .meta(global()),
        tenant_per_minute: z
          .number()
          .int()
          .min(0)
          .max(1000000)
          .default(0)
          .describe(
            "Operator request ceiling per hosted tenant and minute; zero denies hosted requests",
          )
          .meta(global()),
        global_per_minute: z
          .number()
          .int()
          .min(0)
          .max(1000000)
          .default(0)
          .describe(
            "Operator request ceiling across hosted ingress per minute; zero denies hosted ingress",
          )
          .meta(global()),
      })
      .prefault({}),
    trusted_proxy_hops: z
      .number()
      .int()
      .min(0)
      .max(16)
      .default(0)
      .describe(
        "Trusted reverse-proxy hops counted from the right of X-Forwarded-For; zero ignores forwarding headers.",
      )
      .meta(global()),
    trusted_proxy_ips: z
      .array(z.union([z.ipv4(), z.ipv6()]))
      .max(128)
      .default([])
      .describe(
        "Exact trusted reverse-proxy socket peer IPs. Every configured forwarding hop must match; X-Real-IP is never trusted.",
      )
      .meta(global()),
    port: z
      .number()
      .int()
      .min(1)
      .max(65535)
      .default(3000)
      .describe("HTTP port to bind (1..65535)")
      .meta(global({ requiresRestart: true })),
    public_base_url: optionalUrl
      .default("")
      .describe(
        "External-facing URL the engine resolves at. Used by /install, chat link replies, and OAuth2 redirect-URI synthesis. Required for any OAuth2 connector.",
      )
      .meta(global()),
    root_redirect_to_cockpit: z
      .boolean()
      .default(false)
      .describe(
        "Redirect a browser's GET / (Accept: text/html) to /cockpit with a non-cacheable temporary redirect. Other clients keep the Markdown entry point. Disabled by default.",
      )
      .meta(global()),
    restart_supervised: z
      .boolean()
      .default(false)
      .describe(
        "A supervisor (systemd with Restart=on-failure, Docker with a restart policy) starts the engine again after it ends. Enables POST /v1/system/restart (exit code 75).",
      )
      .meta(global()),
  })
  .prefault({})
  .describe("HTTP server");

export const DatabaseConfigSchema = z
  .object({
    url: z
      .string()
      .min(1, "database.url is required")
      .describe(
        "Bootstrap-only Postgres connection string. Rotate DATABASE_URL and restart replicas; runtime revisions cannot change this binding.",
      )
      .meta(global({ requiresRestart: true, secret: true })),
    pool_max: z
      .number()
      .int()
      .min(1)
      .max(100)
      .default(10)
      .describe("Maximum application connections per pool and replica.")
      .meta(global({ requiresRestart: true })),
    connect_timeout_ms: z
      .number()
      .int()
      .min(100)
      .max(60_000)
      .default(10_000)
      .describe("Deadline for acquiring or establishing a PostgreSQL connection.")
      .meta(global({ requiresRestart: true })),
    query_timeout_ms: z
      .number()
      .int()
      .min(100)
      .max(900_000)
      .default(150_000)
      .describe("Client-side PostgreSQL query deadline in milliseconds.")
      .meta(global({ requiresRestart: true })),
    statement_timeout_ms: z
      .number()
      .int()
      .min(100)
      .max(900_000)
      .default(120_000)
      .describe("Server-side PostgreSQL statement deadline, initialized on each session.")
      .meta(global({ requiresRestart: true })),
    idle_timeout_ms: z
      .number()
      .int()
      .min(100)
      .max(300_000)
      .default(30_000)
      .describe("Time before an unused pooled connection is closed.")
      .meta(global({ requiresRestart: true })),
    keepalive_delay_ms: z
      .number()
      .int()
      .min(100)
      .max(60_000)
      .default(10_000)
      .describe("Initial TCP keepalive delay for PostgreSQL connections.")
      .meta(global({ requiresRestart: true })),
  })
  .prefault({ url: "" })
  .describe("Database connection");

const HostedMoney = z
  .string()
  .regex(/^(0|[1-9]\d*)$/)
  .max(18);
const HostedRate = z
  .string()
  .regex(/^(0|[1-9]\d*)(\.\d{1,6})?$/)
  .max(18);

export const HostedLlmModelSchema = z
  .object({
    model: z.string().regex(/^(anthropic|openai|gemini|azure|bedrock|vertex):[^\s]+$/),
    max_context_tokens: z.number().int().min(1).max(2_000_000),
    max_output_tokens: z.number().int().min(1).max(2_000_000),
    input_usd_per_million_tokens: HostedRate,
    output_usd_per_million_tokens: HostedRate,
    cache_read_usd_per_million_tokens: HostedRate,
    cache_write_5m_usd_per_million_tokens: HostedRate,
    cache_write_1h_usd_per_million_tokens: HostedRate,
    disabled: z
      .boolean()
      .optional()
      .describe(
        "Keep this entry with its limits and rates but stop allowing the model; missing means false.",
      ),
  })
  .strict()
  .refine((value) => value.max_output_tokens <= value.max_context_tokens, {
    message: "Hosted output limit must not exceed the verified provider context limit",
  });

const LlmSection = z
  .object({
    hosted: z
      .object({
        enabled: z
          .boolean()
          .default(false)
          .describe(
            "Hosted paid-model service mode; requires tenant context independently of signup policy.",
          )
          .meta(global()),
        tenant_monthly_microunits: HostedMoney.default("0")
          .describe(
            "Operator-owned monthly hosted budget per tenant in USD microunits; zero blocks paid calls.",
          )
          .meta(global()),
        global_monthly_microunits: HostedMoney.default("0")
          .describe(
            "Operator-owned global monthly hosted budget in USD microunits; zero blocks paid calls.",
          )
          .meta(global()),
        models: z
          .array(HostedLlmModelSchema)
          .default([])
          .describe(
            "Exact provider:model allowlist with verified provider-enforced context maxima, including extended context, and maximum USD rates for every context tier. No paid native tools or multimodal inputs.",
          )
          .meta(global({ structural: true, runtimeEditable: true })),
      })
      .prefault({}),
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
    suggestion_model: z
      .string()
      .default("")
      .describe(
        "Small model used to generate post-turn suggestions; empty uses the primary provider's default",
      )
      .meta(tenant()),
    context_1m: z
      .boolean()
      .default(false)
      .describe("Enable 1M context window where supported")
      .meta(tenant()),
    web_search: z
      .boolean()
      .default(true)
      .describe(
        "Allow the assistant to use Anthropic-native server-side web search (billed per search; Anthropic models only). Toggle off per tenant via /settings.",
      )
      .meta(tenant()),
    reasoning_effort: z
      .enum(["default", "none", "low", "medium", "high"])
      .default("default")
      .describe(
        "Reasoning effort in authoring turns. default: thinking only in late stages on supported Claude models. none, low, medium or high: every stage on OpenAI reasoning and supported Claude models.",
      )
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
    critic: z
      .object({
        enabled: z
          .boolean()
          .default(false)
          .describe(
            "Run the second-stage LLM critic on workflow drafts after every static gate passes",
          )
          .meta(tenant()),
        min_steps: z
          .number()
          .int()
          .min(1)
          .default(3)
          .describe(
            "Minimum step count for the critic to run on a draft (drift in recent drafts also triggers a run)",
          )
          .meta(tenant()),
        max_consecutive_rejections: z
          .number()
          .int()
          .min(1)
          .default(3)
          .describe(
            "After this many consecutive critic_rejected results in a conversation, skip the critic to avoid an infinite re-author loop",
          )
          .meta(tenant()),
      })
      .prefault({})
      .describe("Authoring-time LLM critic — second-stage verifier for workflow drafts"),
  })
  .prefault({})
  .describe("LLM configuration");

const AuthProviders = z
  .array(
    z.discriminatedUnion("protocol", [
      z
        .object({
          protocol: z.literal("api_key"),
          id: z.string().regex(/^[a-z0-9][a-z0-9-]{0,62}$/),
          label: z.string().min(1).max(120),
        })
        .strict(),
      z
        .object({
          protocol: z.literal("oidc"),
          id: z.string().regex(/^[a-z0-9][a-z0-9-]{0,62}$/),
          label: z.string().min(1).max(120),
          issuer_url: z.url().refine(
            (value) => {
              const url = new URL(value);
              return url.protocol === "https:" || ["127.0.0.1", "localhost"].includes(url.hostname);
            },
            {
              message: "OIDC issuer_url must use HTTPS outside localhost",
            },
          ),
          client_id: z.string().min(1),
          scopes: z.string().default("openid profile email"),
          tenant_slug: z.string().min(1).default("default"),
          signup_policy: z.enum(["existing_tenant", "invite_only", "self_service"]).optional(),
          link_by_email: z.boolean().optional(),
          product_id: z
            .string()
            .regex(/^[a-z0-9][a-z0-9-]{0,62}$/)
            .optional(),
        })
        .strict(),
      z
        .object({
          protocol: z.literal("oidc_bearer"),
          id: z.string().regex(/^[a-z0-9][a-z0-9-]{0,62}$/),
          label: z.string().min(1).max(120),
          issuer_url: z.url().refine(
            (value) => {
              const url = new URL(value);
              return url.protocol === "https:" || ["127.0.0.1", "localhost"].includes(url.hostname);
            },
            {
              message: "OIDC issuer_url must use HTTPS outside localhost",
            },
          ),
          jwks_uri: z
            .url()
            .refine(
              (value) => {
                const url = new URL(value);
                return (
                  url.protocol === "https:" || ["127.0.0.1", "localhost"].includes(url.hostname)
                );
              },
              { message: "jwks_uri must use HTTPS outside localhost" },
            )
            .optional(),
          audience: z
            .string()
            .min(1)
            .describe("Value the token's aud claim must contain; set by the issuer, no default"),
          algorithms: z
            .array(z.enum(["ES256", "ES384", "ES512", "RS256", "RS384", "RS512", "PS256", "EdDSA"]))
            .min(1)
            .default(["ES256"]),
          product_id: z.string().regex(/^[a-z][a-z0-9-]{0,62}$/),
          tenant_slug: z.string().min(1).default("default"),
          required_claims: z
            .array(
              z
                .object({
                  path: z
                    .string()
                    .regex(/^[A-Za-z0-9_:-]+(\.[A-Za-z0-9_:-]+)*$/)
                    .describe("Dot path into the verified token payload"),
                  equals: z.union([z.string(), z.boolean(), z.number()]),
                })
                .strict(),
            )
            .max(16)
            .describe(
              "Claims a verified token must carry, all of them; states who may sign in. Required; an empty list admits every token of the issuer with the audience",
            ),
          reject_anonymous: z
            .boolean()
            .default(true)
            .describe("Refuse tokens whose is_anonymous claim is true"),
          clock_tolerance_s: z.number().int().min(0).max(120).default(30),
        })
        .strict(),
    ]),
  )
  .superRefine((providers, ctx) => {
    const seen = new Set<string>();
    const bearerIssuers = new Set<string>();
    let apiKeyConfigured = false;
    providers.forEach((provider, index) => {
      if (seen.has(provider.id)) {
        ctx.addIssue({
          code: "custom",
          path: [index, "id"],
          message: "Auth provider ids must be unique",
        });
      }
      seen.add(provider.id);
      if (provider.protocol === "api_key") {
        if (apiKeyConfigured) {
          ctx.addIssue({
            code: "custom",
            path: [index, "protocol"],
            message: "Auth may contain only one api_key provider",
          });
        }
        apiKeyConfigured = true;
      }
      if (provider.protocol === "oidc_bearer") {
        if (bearerIssuers.has(provider.issuer_url)) {
          ctx.addIssue({
            code: "custom",
            path: [index, "issuer_url"],
            message: "Two oidc_bearer providers cannot share one issuer_url",
          });
        }
        bearerIssuers.add(provider.issuer_url);
      }
    });
  })
  .min(1)
  .default([{ protocol: "api_key", id: "api-key", label: "SubKit API key" }])
  .describe(
    "Authentication adapters: api_key, oidc (public browser client with PKCE, no secret) and oidc_bearer (an issuer's access token as bearer for one product, verified against its JWKS).",
  )
  .meta(global({ structural: true, runtimeEditable: true }));

const McpOAuthSection = z
  .object({
    enabled: z
      .boolean()
      .default(true)
      .describe("Enable the MCP OAuth 2.1 authorization server (ChatGPT / Claude.ai / Cursor).")
      .meta(global({ requiresRestart: true })),
    dynamic_registration_enabled: z
      .boolean()
      .default(true)
      .describe("Allow RFC 7591 dynamic client registration at POST /v1/oauth/register.")
      .meta(global()),
    access_token_ttl_seconds: z
      .int()
      .positive()
      .default(3600)
      .describe("Lifetime in seconds for MCP OAuth access tokens.")
      .meta(global()),
    refresh_token_ttl_seconds: z
      .int()
      .positive()
      .default(2592000)
      .describe("Lifetime in seconds for MCP OAuth refresh tokens (30 days).")
      .meta(global()),
    authorization_code_ttl_seconds: z
      .int()
      .positive()
      .default(60)
      .describe("Lifetime in seconds for MCP OAuth authorization codes.")
      .meta(global()),
    scopes_supported: z
      .array(z.string())
      .default(["mcp:read", "mcp:authoring", "mcp:admin", "metrics:read"])
      .describe(
        "OAuth scopes advertised in the authorization server metadata. Add, reorder and remove freely, except metrics:read: GET /metrics enforces it, so it is restored whenever a written value omits it.",
      )
      .meta(global()),
  })
  .strict()
  .prefault({})
  .describe("MCP OAuth 2.1 authorization + resource server");

const AuthSection = z
  .object({
    providers: AuthProviders,
    hosted: z
      .object({
        enabled: z
          .boolean()
          .default(false)
          .describe(
            "Enable identity-first hosted browser authentication for explicitly opted-in providers.",
          )
          .meta(global({ requiresRestart: true })),
        registration_enabled: z
          .boolean()
          .default(false)
          .describe(
            "Allow new hosted identities to provision their own workspace. Existing members and reviewed invitation handoffs remain available while registration is closed.",
          )
          .meta(global()),
        admission: z
          .object({
            tenant_creations_per_minute: z
              .number()
              .int()
              .min(0)
              .max(1000000)
              .default(0)
              .describe(
                "Operator global ceiling for newly created self-service tenants per minute; idempotent callbacks do not consume it.",
              )
              .meta(global()),
            retained_tenants: z
              .number()
              .int()
              .min(0)
              .max(1000000)
              .default(0)
              .describe(
                "Operator ceiling for retained self-service tenant records, including erased ownership tombstones; zero denies new tenants.",
              )
              .meta(global()),
            mcp_clients_per_peer_per_minute: z
              .number()
              .int()
              .min(0)
              .max(1000000)
              .default(0)
              .describe(
                "Operator hosted MCP dynamic-client registration ceiling per verified peer and minute.",
              )
              .meta(global()),
            mcp_clients_per_minute: z
              .number()
              .int()
              .min(0)
              .max(1000000)
              .default(0)
              .describe(
                "Operator global hosted MCP dynamic-client registration ceiling per minute.",
              )
              .meta(global()),
            retained_mcp_clients: z
              .number()
              .int()
              .min(0)
              .max(1000000)
              .default(0)
              .describe(
                "Operator ceiling for retained MCP client registrations, including retired and disabled clients; zero denies new clients.",
              )
              .meta(global()),
          })
          .prefault({}),
      })
      .prefault({}),
    enable_signup: z
      .boolean()
      .default(false)
      .describe(
        "Compatibility fallback for self-hosted OIDC providers without signup_policy: allow first-time SSO member accounts. Explicit provider policies override it; hosted signup never uses it.",
      )
      .meta(global()),
    session: z
      .object({
        secret: z
          .union([z.literal(""), z.string().min(32)])
          .default("")
          .describe(
            "Session signing secret (auto-generated to a 32-byte hex value on first boot if empty); operator-supplied values must be at least 32 chars",
          )
          .meta(global({ requiresRestart: true, secret: true })),
      })
      .prefault({})
      .describe("Session signing"),
    mcp_oauth: McpOAuthSection,
  })
  .strict()
  .prefault({})
  .describe("Authentication");

const PlatformSection = z
  .object({
    slack: z
      .object({
        signing_secret: z
          .string()
          .default("")
          .meta(global({ requiresRestart: true, secret: true })),
        client_id: z
          .string()
          .default("")
          .meta(global({ requiresRestart: true })),
        client_secret: z
          .string()
          .default("")
          .meta(global({ requiresRestart: true, secret: true })),
      })
      .prefault({})
      .describe("Slack app"),
    teams: z
      .object({
        app_id: z
          .string()
          .default("")
          .meta(global({ requiresRestart: true })),
        app_password: z
          .string()
          .default("")
          .meta(global({ requiresRestart: true, secret: true })),
      })
      .prefault({})
      .describe("Microsoft Teams"),
    googlechat: z
      .object({
        project_id: z
          .string()
          .default("")
          .meta(global({ requiresRestart: true })),
        client_email: z
          .string()
          .default("")
          .meta(global({ requiresRestart: true })),
        private_key: z
          .string()
          .default("")
          .meta(global({ requiresRestart: true, secret: true })),
        audience: z
          .string()
          .default("")
          .meta(global({ requiresRestart: true })),
        sync_turn_timeout_ms: z
          .number()
          .int()
          .min(1_000)
          .max(29_000)
          .default(25_000)
          .meta(global())
          .describe(
            "Bounded wait for the inline synchronous Google Chat turn before falling back to detached async delivery (must stay under Google's ~30s sync window)",
          ),
      })
      .prefault({})
      .describe("Google Chat"),
  })
  .prefault({})
  .describe("Chat platform integrations");

const StorageSection = z
  .object({
    hosted: z
      .object({
        tenant_bytes: HostedMoney.default("0")
          .describe(
            "Operator-owned shared logical byte quota for files, object reservations and all retained user content, including copies and revisions. Not a physical bucket or PostgreSQL disk quota.",
          )
          .meta(global()),
        retained_rows_per_resource: z
          .number()
          .int()
          .min(0)
          .max(1_000_000)
          .default(1000)
          .describe(
            "Operator-owned retained row ceiling, initially 1,000 for the Free offering, for each hosted resource table, including histories and soft-deleted rows; zero blocks resource creation.",
          )
          .meta(global()),
        max_file_bytes: HostedMoney.default("0")
          .describe(
            "Operator-owned maximum declared bytes of each new hosted file; zero blocks file admission.",
          )
          .meta(global()),
      })
      .prefault({}),
    object_store: z
      .object({
        endpoint: optionalUrl.default("").meta(global()),
        region: z.string().default("us-east-1").meta(global()),
        bucket: z.string().default("").meta(global()),
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
        force_path_style: z.boolean().default(true).meta(global()),
      })
      .prefault({})
      .describe(
        "Provider-neutral S3-compatible object store shared by files and reconstructable execution artifacts",
      ),
  })
  .prefault({})
  .describe("Object storage");

const AnalyticsSection = z
  .object({
    enabled: z
      .boolean()
      .default(false)
      .describe(
        "Enable product-analytics emission. Off by default — no external calls are made unless this is true and an endpoint is configured.",
      )
      .meta(global()),
    endpoint: optionalUrl
      .default("")
      .describe(
        "Self-hostable analytics ingest endpoint. Empty disables emission even when enabled=true.",
      )
      .meta(global()),
    api_key: z
      .string()
      .default("")
      .describe("API key for the analytics endpoint.")
      .meta(global({ secret: true })),
    project: z
      .string()
      .default("")
      .describe("Project or workspace identifier on the analytics platform.")
      .meta(global()),
  })
  .prefault({})
  .describe("Config-driven product analytics (disabled by default; zero external calls when off)");

const UsageSection = z
  .object({
    enabled: z
      .boolean()
      .default(false)
      .describe(
        "Persist privacy-safe, tenant-scoped product usage events locally. Disabled by default; requires hmac_secret when enabled.",
      )
      .meta(global()),
    hmac_secret: z
      .string()
      .default("")
      .describe(
        "Product-local HMAC secret for actor and session pseudonyms. Set at least 32 characters before enabling usage telemetry.",
      )
      .meta(global({ secret: true })),
    retention_days: z
      .number()
      .int()
      .min(31)
      .max(365)
      .default(90)
      .describe("Raw usage-event retention in days; aggregate reports may outlive raw rows.")
      .meta(global()),
  })
  .prefault({})
  .describe(
    "Privacy-safe, product-internal usage measurement (local Postgres only; no content fields)",
  );

const ObservabilitySection = z
  .object({
    langfuse: z
      .object({
        host: optionalUrl.default("").meta(global()),
        public_key: z.string().default("").meta(global()),
        secret_key: z
          .string()
          .default("")
          .meta(global({ secret: true })),
      })
      .prefault({})
      .describe("Langfuse trace ingestion"),
    otlp: z
      .object({
        endpoint: optionalUrl.default("").meta(global()),
        service_name: z.string().default("subkit").meta(global()),
      })
      .prefault({})
      .describe("OpenTelemetry OTLP exporter"),
    analytics: AnalyticsSection,
    usage: UsageSection,
    deployment_environment: z
      .string()
      .min(1)
      .max(64)
      .default("production")
      .describe(
        "Deployment identity used for the OpenTelemetry deployment.environment.name resource attribute.",
      )
      .meta(global()),
    field_truncation_chars: z
      .number()
      .int()
      .min(256)
      .max(65_536)
      .default(2048)
      .describe(
        "Per-field cap (in characters / UTF-16 code units, not bytes) applied to structured log fields after redaction.",
      )
      .meta(global()),
    predictive: z
      .object({
        pool_saturation_pct: z
          .number()
          .min(1)
          .max(100)
          .default(80)
          .describe(
            "Percent of the Postgres pool in use (or any waiting clients) above which saturation is flagged.",
          )
          .meta(global()),
        dlq_critical_depth: z
          .number()
          .int()
          .min(1)
          .default(5)
          .describe(
            "Standing dead-letter-queue depth at or above which DLQ accumulation is flagged critical (a worker-failure backlog, not a per-window delta).",
          )
          .meta(global()),
        transient_retry_rate: z
          .number()
          .min(0)
          .default(1)
          .describe("Transient-DB-retries-per-minute above which a flapping Postgres is flagged.")
          .meta(global()),
        memory_cap_fraction: z
          .number()
          .min(0.1)
          .max(1)
          .default(0.9)
          .describe(
            "Fraction of the host memory cap the RSS high-water may reach before an OOM-risk warning.",
          )
          .meta(global()),
        connector_unhealthy_pct: z
          .number()
          .min(1)
          .max(100)
          .default(80)
          .describe(
            "Percent of recent connector calls returning a non-ok health verdict above which connector drift is flagged.",
          )
          .meta(global()),
        llm_fallback_pct: z
          .number()
          .min(1)
          .max(100)
          .default(80)
          .describe(
            "Percent of LLM calls falling back to the secondary provider above which primary-provider degradation is flagged.",
          )
          .meta(global()),
      })
      .prefault({})
      .describe("Predictive-maintenance thresholds (advisory leading indicators)"),
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
      .describe(
        "Extra hostnames counted as LLM providers for token accounting and per-run budgets. Does NOT affect the egress filter — adding a host makes calls to it metered, not permitted.",
      )
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

const ErrorsSection = z
  .object({
    ring_size: z
      .number()
      .int()
      .positive()
      .default(100)
      .meta(global({ requiresRestart: true })),
  })
  .prefault({})
  .describe("Error ring buffer");

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
    hosted: z
      .object({
        execution_concurrency: z
          .number()
          .int()
          .min(0)
          .max(10000)
          .default(0)
          .describe(
            "Operator ceiling for simultaneous hosted root executions per tenant; zero denies work.",
          )
          .meta(global()),
        chat_concurrency: z
          .number()
          .int()
          .min(0)
          .max(10000)
          .default(0)
          .describe(
            "Operator ceiling for simultaneous hosted chat turns per tenant, including direct calls; zero denies work.",
          )
          .meta(global()),
        pending_jobs: z
          .number()
          .int()
          .min(0)
          .max(1000000)
          .default(0)
          .describe(
            "Operator ceiling for queued hosted execution and conversation jobs per tenant; zero denies queue admission.",
          )
          .meta(global()),
      })
      .prefault({}),
    concurrency: z
      .number()
      .int()
      .positive()
      .max(64)
      .default(1)
      .describe(
        "Executions this replica runs at once. Raising it trades isolation for throughput. Restart required.",
      )
      .meta(global({ requiresRestart: true })),
    abort_poll_interval_ms: z
      .number()
      .int()
      .min(100)
      .max(10_000)
      .default(500)
      .describe(
        "Hot-reloadable interval for workers to observe durable cross-replica execution cancellation requests.",
      )
      .meta(global()),
    crash_recovery_sweep_interval_ms: z
      .number()
      .int()
      .min(1_000)
      .max(300_000)
      .default(60_000)
      .describe(
        "Hot-reloadable interval for reconciling executions orphaned by a worker or engine restart.",
      )
      .meta(global()),
    crash_recovery_threshold_ms: z
      .number()
      .int()
      .nonnegative()
      .default(0)
      .describe(
        "Hard age threshold for crash recovery. 0 uses each workflow timeout multiplied by its grace factor.",
      )
      .meta(global()),
  })
  .prefault({})
  .describe("Queue worker");

export const ModelPriceSchema = z.object({
  model: z.string().min(1).describe("Model identifier as it appears in `llm_usage.model`."),
  input_per_mtok: z.number().nonnegative().describe("Price per 1M uncached input tokens."),
  output_per_mtok: z.number().nonnegative().describe("Price per 1M output tokens."),
  cache_read_per_mtok: z
    .number()
    .nonnegative()
    .default(0)
    .describe("Price per 1M tokens read from the prompt cache."),
  cache_write_per_mtok: z
    .number()
    .nonnegative()
    .default(0)
    .describe(
      "Price per 1M tokens written to the prompt cache, at the TTL SubKit writes: for Anthropic models the one-hour cache write rate.",
    ),
});

const TokensSection = z
  .object({
    currency: z
      .string()
      .default("USD")
      .describe(
        "ISO 4217 code for tokens.prices. The built-in catalog is in USD and applies only while this is USD; otherwise only tokens.prices entries price anything.",
      )
      .meta(tenant()),
    prices: z
      .array(ModelPriceSchema)
      .default([])
      .describe(
        "Per-model price overrides on top of the built-in catalog, per 1M tokens. An entry replaces its model's catalog price. A model with neither is reported as unpriced, not as zero.",
      )
      .meta(tenant({ structural: true, runtimeEditable: true })),
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

const OperationsSection = z
  .object({
    update_check_enabled: z
      .boolean()
      .default(true)
      .describe("Check for a newer engine release during startup")
      .meta(global({ requiresRestart: true })),
    seed_skills_at_boot: z
      .boolean()
      .default(true)
      .describe("Upsert embedded skill seeds for all tenants during startup")
      .meta(global({ requiresRestart: true })),
  })
  .prefault({})
  .describe("Startup operations");

const SandboxSection = z
  .object({
    memory_bytes: z
      .number()
      .int()
      .positive()
      .default(128 * 1024 * 1024)
      .describe("Hard WASM heap cap for a JS sandbox run, in bytes. Default 128 MB.")
      .meta(global()),
    tick_budget: z
      .number()
      .int()
      .positive()
      .default(10_000_000)
      .describe("Interrupt-tick budget (coarse runaway backstop, not an opcode count).")
      .meta(global()),
    wall_ms: z
      .number()
      .int()
      .positive()
      .default(30_000)
      .describe("Default wall-clock cap for a JS sandbox run, in ms. Default 30 s.")
      .meta(global()),
    stack_bytes: z
      .number()
      .int()
      .positive()
      .default(2 * 1024 * 1024)
      .describe("Max stack size for a JS sandbox run, in bytes. Default 2 MB.")
      .meta(global()),
    queue_limit: z
      .number()
      .int()
      .min(1)
      .max(256)
      .default(32)
      .describe("Maximum queued sandbox jobs across one worker lane. Default 32.")
      .meta(global()),
    tenant_queue_limit: z
      .number()
      .int()
      .min(1)
      .max(256)
      .default(8)
      .describe("Maximum queued sandbox jobs for one tenant in one worker lane. Default 8.")
      .meta(global()),
    ipc_max_bytes: z
      .number()
      .int()
      .min(64 * 1024)
      .max(32 * 1024 * 1024)
      .default(32 * 1024 * 1024)
      .describe("Maximum sandbox worker request or response size in bytes. Default 32 MB.")
      .meta(global()),
    worker_rss_bytes: z
      .number()
      .int()
      .min(32 * 1024 * 1024)
      .max(2 * 1024 * 1024 * 1024)
      .default(512 * 1024 * 1024)
      .describe(
        "RSS threshold that recycles a sandbox worker after a job, in bytes. Default 512 MB.",
      )
      .meta(global()),
    transform_wall_ms: z
      .number()
      .int()
      .positive()
      .default(60_000)
      .describe(
        "Wall-clock cap for transform steps, in ms (overridable per step via timeout_ms). " +
          "Long synchronous transforms block the worker — chunk via for_each instead of raising. Default 60 s.",
      )
      .meta(global()),
    max_transform_wall_ms: z
      .number()
      .int()
      .positive()
      .default(300_000)
      .describe(
        "Operator ceiling for a transform step's wall-clock, in ms. A step timeout_ms above it runs " +
          "with the ceiling and sandbox_limit_clamped_total counts the cut. Default 5 min.",
      )
      .meta(global()),
    prewarm: z
      .boolean()
      .default(false)
      .describe(
        "Start one default sandbox worker after boot, once the knowledge seed and its embeddings " +
          "are done, so the first transform or JSONata step does not pay the worker cold start. " +
          "Default off.",
      )
      .meta(global()),
  })
  .superRefine((value, ctx) => {
    if (value.tenant_queue_limit > value.queue_limit) {
      ctx.addIssue({
        code: z.ZodIssueCode.custom,
        path: ["tenant_queue_limit"],
        message: "tenant_queue_limit must not exceed queue_limit",
      });
    }
  })
  .prefault({})
  .describe("QuickJS JS sandbox limits");

const ReplSection = z
  .object({
    permissionMode: z
      .enum(["ask", "auto", "plan", "yolo"])
      .default("auto")
      .describe("Default REPL permission mode for the principal: ask, auto, plan, or yolo.")
      .meta(tenant()),
    portalTokenTtlMin: z
      .number()
      .int()
      .positive()
      .max(60 * 24)
      .default(15)
      .describe("TTL in minutes for portal tokens minted by the /session slash (1..1440).")
      .meta(tenant()),
  })
  .prefault({})
  .describe("sk REPL session preferences");

const QuietHoursStringSchema = z
  .string()
  .regex(/^$|^([01]\d|2[0-3]):[0-5]\d$/, "expected HH:MM (24h, leading-zero hour) or empty");

const NotificationsSection = z
  .object({
    push: z
      .object({
        enabled: z
          .boolean()
          .default(false)
          .describe("OS push notifications for long-running execution completion.")
          .meta(tenant()),
        thresholdSec: z
          .number()
          .int()
          .positive()
          .max(3600)
          .default(30)
          .describe("Minimum elapsed turn seconds before a notification fires.")
          .meta(tenant()),
        quietHoursStart: QuietHoursStringSchema.default("")
          .describe("Quiet-hours window start (HH:MM, local TZ). Empty disables the window.")
          .meta(tenant()),
        quietHoursEnd: QuietHoursStringSchema.default("")
          .describe("Quiet-hours window end (HH:MM, local TZ). Empty disables the window.")
          .meta(tenant()),
      })
      .prefault({}),
    inbox: z
      .object({
        retention_days: z
          .number()
          .int()
          .min(1)
          .max(365)
          .default(30)
          .describe(
            "Days a notification inbox task survives before the retention sweep deletes it.",
          )
          .meta(global()),
      })
      .prefault({}),
  })
  .prefault({})
  .describe("sk REPL notification preferences");

const UiSection = z
  .object({
    theme: z
      .enum(["auto", "light", "dark", "high-contrast"])
      .default("auto")
      .describe("REPL color theme: auto | light | dark | high-contrast.")
      .meta(tenant()),
    personality: z
      .enum(["concise", "balanced", "verbose"])
      .default("balanced")
      .describe("Assistant response style: concise | balanced | verbose.")
      .meta(tenant()),
    title: z
      .object({
        format: z
          .enum(["session-id", "tenant-session", "model-tenant-session"])
          .default("session-id")
          .describe("Window-title format used by the sk REPL.")
          .meta(tenant()),
      })
      .prefault({}),
    statusline: z
      .object({
        format: z
          .enum(["minimal", "compact", "detailed"])
          .default("compact")
          .describe("Status-line layout: minimal | compact | detailed.")
          .meta(tenant()),
      })
      .prefault({}),
  })
  .prefault({})
  .describe("REPL chrome preferences");

const WebScraperRuntime = z
  .object({
    respect_robots: z
      .boolean()
      .default(true)
      .describe("Skip URLs that robots.txt disallows for the configured User-Agent.")
      .meta(tenant()),
    user_agent: z
      .string()
      .default("")
      .describe(
        "User-Agent header on every fetch; passed to robots-parser matching. Empty means sk-web-scraper/<version> (+<server.public_base_url>/bot), or the project URL when no public base URL is set.",
      )
      .meta(tenant()),
    max_pages: z
      .number()
      .int()
      .min(1)
      .max(10_000)
      .default(1000)
      .describe("Per-run crawl cap. Hard ceiling 10 000 (crawl_max_pages_exceeded).")
      .meta(tenant()),
    max_chars_readability: z
      .number()
      .int()
      .min(1_000)
      .max(2_000_000)
      .default(100_000)
      .describe("Per-page input cap into Readability (extract_too_large).")
      .meta(tenant()),
    max_chars_markdown: z
      .number()
      .int()
      .min(1_000)
      .max(2_000_000)
      .default(100_000)
      .describe("Per-page markdown output cap (extract_too_large).")
      .meta(tenant()),
    default_wait_ms: z
      .number()
      .int()
      .min(0)
      .max(60_000)
      .default(0)
      .describe(
        "Floor for between-page wait inside the crawl loop. Raised if robots.txt declares a higher Crawl-delay.",
      )
      .meta(tenant()),
  })
  .prefault({});

const WebScraperRobotsCache = z
  .object({
    ttl_ms: z
      .number()
      .int()
      .min(60_000)
      .max(86_400_000)
      .default(3_600_000)
      .describe("TTL for the per-tenant robots.txt LRU.")
      .meta(global()),
    max_entries: z
      .number()
      .int()
      .min(100)
      .max(50_000)
      .default(2_000)
      .describe("LRU ceiling shared across tenants (keyed by tenant_id + origin).")
      .meta(global()),
  })
  .prefault({});

const WebScraperAuthoring = z
  .object({
    yellow_sitemap_threshold: z
      .number()
      .int()
      .min(100)
      .max(1_000_000)
      .default(10_000)
      .describe("Sitemap entry count above which analyze_scrape_target returns Yellow.")
      .meta(tenant()),
    red_sitemap_threshold: z
      .number()
      .int()
      .min(1_000)
      .max(10_000_000)
      .default(100_000)
      .describe("Sitemap entry count above which analyze_scrape_target refuses (Red).")
      .meta(tenant()),
    extract_too_large_yellow_pct: z
      .number()
      .int()
      .min(1)
      .max(100)
      .default(30)
      .describe(
        "Past-run extract_too_large ratio (over last 20 runs) above which the gate Yellows.",
      )
      .meta(tenant()),
  })
  .prefault({});

const WebScraperOptimization = z
  .object({
    scan_cron: z
      .string()
      .min(1)
      .default("0 3 * * *")
      .describe("Crontab for the per-tenant optimization scan (default daily 03:00).")
      .meta(global()),
    sample_size: z
      .number()
      .int()
      .min(3)
      .max(200)
      .default(10)
      .describe("Number of recent runs the analyzer reads per recipe.")
      .meta(tenant()),
    trivial_markdown_bytes: z
      .number()
      .int()
      .min(64)
      .max(16_384)
      .default(512)
      .describe("Pages whose MarkdownOutput.bytes is below this count as trivial.")
      .meta(tenant()),
    min_runs_before_proposing: z
      .number()
      .int()
      .min(1)
      .max(50)
      .default(3)
      .describe("Minimum recent runs before any candidate is emitted.")
      .meta(tenant()),
  })
  .prefault({});

const WebScraperSection = z
  .object({
    runtime: WebScraperRuntime,
    robots_cache: WebScraperRobotsCache,
    authoring: WebScraperAuthoring,
    optimization: WebScraperOptimization,
  })
  .prefault({})
  .describe("Web-scraper connector tunables. Every leaf has a useful default.");

const ConnectorsHttpSection = z
  .object({
    max_response_bytes: z
      .number()
      .int()
      .min(1_048_576)
      .max(1_073_741_824)
      .default(104_857_600)
      .describe(
        "Max bytes read from a single HTTP/GraphQL connector response before it is rejected as response_too_large. OOM guard; generous default (100 MB).",
      )
      .meta(tenant()),
  })
  .prefault({})
  .describe("HTTP/GraphQL connector transport limits (shared by the http + graphql drivers).");

export const ConnectorsMcpSection = z
  .object({
    per_server_manifest_byte_cap: z
      .number()
      .int()
      .min(1_000)
      .max(1_000_000)
      .default(30_000)
      .describe(
        "Byte cap on one external MCP connector's serialized tool manifest; the heaviest tools are dropped first when exceeded",
      )
      .meta(tenant()),
    remote_tool_call_timeout_ms: z
      .number()
      .int()
      .min(1_000)
      .max(300_000)
      .default(30_000)
      .describe("Bounded timeout (ms) for one remote external MCP tools/call invocation")
      .meta(tenant()),
    tools_list_max_pages: z
      .number()
      .int()
      .min(1)
      .max(50)
      .default(5)
      .describe(
        "Max tools/list pages followed per external MCP handshake; a server paginating past this keeps only the pages read",
      )
      .meta(tenant()),
  })
  .prefault({})
  .describe("External MCP connector client pool");

const ConnectorsSection = z
  .object({
    web_scraper: WebScraperSection,
    http: ConnectorsHttpSection,
    mcp: ConnectorsMcpSection,
  })
  .prefault({})
  .describe("Per-connector tunables. Each sub-section is owned by one connector template.");

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
        suggestion_model: z.string().optional(),
        context_1m: z.boolean().optional(),
        web_search: z.boolean().optional(),
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
        critic: z
          .object({
            enabled: z.boolean().optional(),
            min_steps: z.number().int().min(1).optional(),
            max_consecutive_rejections: z.number().int().min(1).optional(),
          })
          .optional(),
      })
      .optional(),
    queue: z.object({ concurrency: z.number().int().positive().max(64).optional() }).optional(),
    tokens: z
      .object({
        currency: z.string().optional(),
        prices: z.array(ModelPriceSchema).optional(),
        monthly_budget: z.number().int().nonnegative().optional(),
      })
      .optional(),
    repl: z
      .object({
        permissionMode: z.enum(["ask", "auto", "plan", "yolo"]).optional(),
        portalTokenTtlMin: z
          .number()
          .int()
          .positive()
          .max(60 * 24)
          .optional(),
      })
      .optional(),
    notifications: z
      .object({
        push: z
          .object({
            enabled: z.boolean().optional(),
            thresholdSec: z.number().int().positive().max(3600).optional(),
            quietHoursStart: QuietHoursStringSchema.optional(),
            quietHoursEnd: QuietHoursStringSchema.optional(),
          })
          .optional(),
      })
      .optional(),
    ui: z
      .object({
        theme: z.enum(["auto", "light", "dark", "high-contrast"]).optional(),
        personality: z.enum(["concise", "balanced", "verbose"]).optional(),
        title: z
          .object({
            format: z.enum(["session-id", "tenant-session", "model-tenant-session"]).optional(),
          })
          .optional(),
        statusline: z
          .object({
            format: z.enum(["minimal", "compact", "detailed"]).optional(),
          })
          .optional(),
      })
      .optional(),
    connectors: z
      .object({
        web_scraper: z
          .object({
            runtime: z
              .object({
                respect_robots: z.boolean().optional(),
                user_agent: z.string().min(1).optional(),
                max_pages: z.number().int().min(1).max(10_000).optional(),
                max_chars_readability: z.number().int().min(1_000).max(2_000_000).optional(),
                max_chars_markdown: z.number().int().min(1_000).max(2_000_000).optional(),
                default_wait_ms: z.number().int().min(0).max(60_000).optional(),
              })
              .optional(),
            authoring: z
              .object({
                yellow_sitemap_threshold: z.number().int().min(100).max(1_000_000).optional(),
                red_sitemap_threshold: z.number().int().min(1_000).max(10_000_000).optional(),
                extract_too_large_yellow_pct: z.number().int().min(1).max(100).optional(),
              })
              .optional(),
            optimization: z
              .object({
                sample_size: z.number().int().min(3).max(200).optional(),
                trivial_markdown_bytes: z.number().int().min(64).max(16_384).optional(),
                min_runs_before_proposing: z.number().int().min(1).max(50).optional(),
              })
              .optional(),
          })
          .optional(),
        http: z
          .object({
            max_response_bytes: z.number().int().min(1_048_576).max(1_073_741_824).optional(),
          })
          .optional(),
        mcp: z
          .object({
            per_server_manifest_byte_cap: z.number().int().min(1_000).max(1_000_000).optional(),
            remote_tool_call_timeout_ms: z.number().int().min(1_000).max(300_000).optional(),
            tools_list_max_pages: z.number().int().min(1).max(50).optional(),
          })
          .optional(),
      })
      .optional(),
  })
  .describe("Per-tenant overrides — only scope:tenant leaves may appear");

const ProductsSection = z
  .record(
    z.string().regex(/^[a-z][a-z0-9-]{0,62}$/),
    z
      .object({
        execution_environment: z
          .enum(["dev", "prod"])
          .describe(
            "Execution environment for runs of this product's principals without an x-subkit-environment header",
          ),
        assistant_workflow_id: z
          .uuid()
          .describe(
            "Saved workflow whose caller_daily_limit guard backs GET /v1/budget and GET /v1/health",
          ),
        budget_bucket: z
          .string()
          .min(1)
          .max(64)
          .describe("caller_daily_limit bucket reported by GET /v1/budget"),
      })
      .strict(),
  )
  .prefault({})
  .describe("Product settings keyed by product_id for product principals (oidc_bearer providers)")
  .meta(global({ structural: true, runtimeEditable: true }));

export const ConfigSchema = z
  .object({
    log: LogSection,
    server: ServerSection,
    database: DatabaseConfigSchema,
    llm: LlmSection,
    auth: AuthSection,
    platform: PlatformSection,
    storage: StorageSection,
    observability: ObservabilitySection,
    egress: EgressSection,
    mcp: McpSection,
    errors: ErrorsSection,
    spec: SpecSection,
    queue: QueueSection,
    tokens: TokensSection,
    operations: OperationsSection,
    sandbox: SandboxSection,
    repl: ReplSection,
    ui: UiSection,
    notifications: NotificationsSection,
    connectors: ConnectorsSection,
    products: ProductsSection,
    tenants: z
      .record(z.string(), TenantOverlaySchema)
      .prefault({})
      .describe("Per-tenant override map keyed by tenant_id"),
  })
  .superRefine((config, context) => {
    const message = hostedRegistrationPolicyError(config);
    if (message)
      context.addIssue({
        code: "custom",
        path: ["auth", "hosted", "registration_enabled"],
        message,
      });
  })
  .describe("subkit runtime configuration");

export type Config = z.infer<typeof ConfigSchema>;

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
  "errors",
  "docker",
  "spec",
  "queue",
  "tokens",
  "operations",
  "sandbox",
  "repl",
  "ui",
  "notifications",
  "connectors",
  "products",
] as const;

export type AuthProviderConfig = Config["auth"]["providers"][number];
export type OidcBearerProviderConfig = Extract<AuthProviderConfig, { protocol: "oidc_bearer" }>;
export type ProductConfig = Config["products"][string];

export function isBrowserLoginProvider(
  provider: AuthProviderConfig,
): provider is Exclude<AuthProviderConfig, OidcBearerProviderConfig> {
  return provider.protocol !== "oidc_bearer";
}
