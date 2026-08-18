import { z } from "zod";

export type FieldScope = "global" | "tenant";

export interface FieldMeta {
  secret?: boolean;
  scope?: FieldScope;
  requiresRestart?: boolean;
  structural?: boolean;
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

// Helper for "either an empty string OR a valid URL" — the schema's
// pattern for optional URL leaves that ship empty until the operator
// configures them.
const optionalUrl = z.union([z.literal(""), z.string().url()]);

const ServerSection = z
  .object({
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
    web_search: z
      .boolean()
      .default(true)
      .describe(
        "Allow the assistant to use Anthropic-native server-side web search (billed per search; Anthropic models only). Toggle off per tenant via /settings.",
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
      z.object({
        protocol: z.literal("api_key"),
        id: z.string().regex(/^[a-z0-9][a-z0-9-]{0,62}$/),
        label: z.string().min(1).max(120),
      }),
      z.object({
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
        client_secret: z
          .string()
          .default("")
          .meta(global({ secret: true })),
        scopes: z.string().default("openid profile email"),
        tenant_slug: z.string().min(1).default("default"),
      }),
    ]),
  )
  .superRefine((providers, ctx) => {
    const seen = new Set<string>();
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
    });
  })
  .min(1)
  .default([{ protocol: "api_key", id: "api-key", label: "SubKit API key" }])
  .describe("Provider-neutral browser and bearer authentication adapters.")
  .meta(global({ requiresRestart: true, secret: true, structural: true }));

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
      .default(["mcp:read", "mcp:authoring", "mcp:admin"])
      .describe("OAuth scopes advertised in the authorization server metadata.")
      .meta(global()),
  })
  .strict()
  .prefault({})
  .describe("MCP OAuth 2.1 authorization + resource server");

const AuthSection = z
  .object({
    providers: AuthProviders,
    enable_signup: z
      .boolean()
      .default(false)
      .describe(
        "Allow first-time SSO sign-ins to auto-provision a new member account (JIT signup). When false, unknown identities are rejected with access_denied; existing users and links keep working.",
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
        // App-level Chat-app service account (one per engine, like
        // Slack's signing secret): outbound REST auth via JWT assertion.
        client_email: z
          .string()
          .default("")
          .meta(global({ requiresRestart: true })),
        private_key: z
          .string()
          .default("")
          .meta(global({ requiresRestart: true, secret: true })),
        // Inbound JWT audience. The Chat-app console setting
        // "Authentication Audience" MUST be "Project Number" — this is
        // that number (a numeric string). In the alternative
        // "HTTP endpoint URL" mode Google signs a different token shape
        // the adapter deliberately does not speak.
        audience: z
          .string()
          .default("")
          .meta(global({ requiresRestart: true })),
        // Bounded wait for the inline synchronous Google-Chat turn before
        // the route acks and falls back to detached async delivery. Google
        // renders "[app] is not responding" unless the synchronous webhook
        // response is a valid Chat Message, so a fast turn returns its
        // reply as the HTTP body; a slow one detaches. Max 29_000 keeps us
        // inside Google's ~30s sync window including network.
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
    s3: z
      .object({
        endpoint: optionalUrl.default("").meta(global({ requiresRestart: true })),
        access_key: z
          .string()
          .default("")
          .meta(global({ requiresRestart: true, secret: true })),
        secret_key: z
          .string()
          .default("")
          .meta(global({ requiresRestart: true, secret: true })),
      })
      .prefault({})
      .describe("S3-compatible object store"),
    files: z
      .object({
        backend: z
          .enum(["local", "s3"])
          .default("local")
          .meta(global({ requiresRestart: true })),
        dir: z
          .string()
          .default("")
          .describe("Local-disk root when backend=local. Ignored when backend=s3.")
          .meta(global({ requiresRestart: true })),
        bucket: z
          .string()
          .default("")
          .describe("S3 bucket name when backend=s3. Ignored when backend=local.")
          .meta(global({ requiresRestart: true })),
      })
      .prefault({})
      .describe(
        "Unified files storage (chat attachments, knowledge sources, workflow file inputs/outputs, discovery archives)",
      ),
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
        endpoint: optionalUrl
          .default("")
          .describe("Optional S3 endpoint override (MinIO, R2, etc.)")
          .meta(global()),
        key_prefix: z.string().default("offload").meta(global()),
      })
      .prefault({})
      .describe("Execution-payload offload to S3"),
  })
  .prefault({})
  .describe("Storage backends")
  // Cross-leaf invariant (#7): files.backend="s3" without
  // storage.s3 credentials OR without storage.files.bucket is a
  // half-configured engine. Reject at parse time so an operator who
  // flips backend without setting keys/bucket gets a precise validation
  // error instead of a runtime surprise on the first file ingest.
  .refine(
    (s) => {
      if (s.files.backend !== "s3") return true;
      return Boolean(s.s3.access_key && s.s3.secret_key && s.files.bucket);
    },
    {
      message:
        "storage.files.backend='s3' requires storage.s3.access_key, storage.s3.secret_key, and storage.files.bucket",
      path: ["files", "backend"],
    },
  );

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
        // 4.2.0: requiresRestart=false — setConfigKey() hot-reloads the
        // OTel SDK + resets the langfuse-spans cache via
        // reconfigureTracing(). Operators see `sk settings set
        // observability.langfuse.secret_key '"…"'` take effect on the
        // next span.
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
      .default("development")
      .describe(
        "Deployment identity used for the OpenTelemetry deployment.environment.name resource attribute.",
      )
      .meta(global()),
    // Phase 1 (logging) per-field string cap, now config-driven. The
    // logger hot-reloads this via reconfigureObservability() on any
    // observability.* write; it falls back to 2048 when the loader is not
    // initialised (boot, unit tests).
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
    // Phase 2 predictive-maintenance thresholds. These are the leading
    // indicators the operator health-digest evaluates against the live
    // gauges/counters; tuning them is an operator decision, not a code
    // change. They are advisory inputs — the metrics flow to /metrics
    // unconditionally regardless of these values.
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
    concurrency: z.number().int().positive().max(64).default(8).meta(tenant()),
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

// QuickJS sandbox limits for user-authored JavaScript (transforms,
// validation/output-transform functions, loop/for_each selectors). These
// are the GENERAL-tier defaults; before-request hooks keep their own
// tighter, security-fixed limits in auth/hooks.ts and do NOT track these.
//
// `tick_budget` is an interrupt-tick budget, NOT an opcode count: QuickJS
// fires the interrupt handler on an internal counter at loop back-edges and
// function calls, so this is a coarse runaway backstop — the wall-clock and
// memory caps are the real guards. See sandboxes/quickjs/QUICKJS.md.
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
  })
  .prefault({})
  .describe("QuickJS JS sandbox limits");

// sk REPL session preferences. Tenant-scoped so each operator picks a
// default permission mode that the next REPL run honors at startup.
// The four-value union mirrors PermissionMode in the CLI; the
// Permissions tab in /settings writes here.
const ReplSection = z
  .object({
    permissionMode: z
      .enum(["ask", "auto", "plan", "yolo"])
      .default("ask")
      .describe(
        // Keep the description to data semantics; sk-specific UI
        // hints (slash names, key chords) belong in the slash registry
        // / docs, not the OpenAPI surface.
        "Default REPL permission mode for the principal: ask, auto, plan, or yolo.",
      )
      .meta(tenant()),
    // Operator-tunable `/session` portal-token TTL instead of a
    // hardcoded 15 minutes in the slash handler. Tenant-scoped so
    // different tenants can pick different security/usability
    // tradeoffs without a CLI release.
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

// sk REPL push-notification preferences. Tenant-scoped so each
// operator picks their own threshold + opt-in. `quietHoursStart` and
// `quietHoursEnd` are 24h "HH:MM" wall-clock strings (local timezone)
// that the CLI uses to suppress emits. An empty string disables the
// time-window check.
//
// Single source of truth for the HH:MM-or-empty regex. The base
// section + the tenant overlay both reuse this — a future change to
// the format only edits one place.
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
        // Regex-constrain the wall-clock string at the engine
        // boundary. Bare `z.string()` lets `"99:99"` or `"foo"`
        // round-trip through the API silently; the CLI's `parseHHMM`
        // then quietly falls back to "no quiet hours". Constraining
        // here makes the OpenAPI surface honest and protects every
        // other consumer (chat adapter, future workflow steps) from
        // the same trap. Pinned shape lives in
        // `QuietHoursStringSchema` above.
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
        // Nothing deletes an inbox row on the request path any more —
        // `ack` marks read instead of deleting — so this window is the
        // only thing bounding the table.
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

// UI value pickers (theme, personality, title, statusline). Tenant-
// scoped so each operator's REPL runs with their preferred chrome.
// The Config tab opens the matching ValuePicker component when one
// of these rows is selected.
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

// Every tunable the web-scraper connector introduces lives here
// with a useful default, so `sk connectors create web-scraper --slug=<x>`
// is a zero-arg command. Operators tune via `sk settings set
// connectors.web_scraper.<leaf> <value>` or the /settings → Config tab;
// the /v1/settings routes and CLI auto-discover by walking the schema.
const WebScraperRuntime = z
  .object({
    respect_robots: z
      .boolean()
      .default(true)
      .describe("Skip URLs that robots.txt disallows for the configured User-Agent.")
      .meta(tenant()),
    user_agent: z
      .string()
      .min(1)
      .default("sk-web-scraper/1.0 (+https://subkit.io/bot)")
      .describe("User-Agent header on every fetch; passed to robots-parser matching.")
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
      // Keep this default in sync with DEFAULT_MAX_RESPONSE_BYTES in
      // connectors/drivers/http.ts (used when config isn't yet loaded).
      .default(104_857_600)
      .describe(
        "Max bytes read from a single HTTP/GraphQL connector response before it is rejected as response_too_large. OOM guard; generous default (100 MB).",
      )
      .meta(tenant()),
  })
  .prefault({})
  .describe("HTTP/GraphQL connector transport limits (shared by the http + graphql drivers).");

// External MCP client-pool budgets. An external MCP server is a connector
// whose driver is `mcp`, so its tunables belong beside the other
// per-driver sections rather than under the inbound `mcp` section, which
// configures the MCP server subkit HOSTS. The defaults mirror the
// module-level constants in `mcp/client/pool.ts`, which stay as the
// fallback when the config loader is not initialised (unit tests).
// Exported so the retired-section boot check can ask what the budgets default
// to instead of restating the numbers. A leftover `mcp.client` that merely
// repeats these values carries no operator intent, and refusing to boot over it
// would stop a deploy to protect nothing — so the check needs the real defaults,
// from here, or it drifts the moment one of them changes.
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
    tokens: z.object({ monthly_budget: z.number().int().nonnegative().optional() }).optional(),
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
            // Mirror the regex from `NotificationsSection` via the
            // shared `QuietHoursStringSchema` constant.
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
    // Web-scraper connector — only the tenant-scoped leaves; the robots_cache.*
    // and optimization.scan_cron are global and may not appear here.
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
        // External MCP client-pool budgets. Mirrors `ConnectorsMcpSection`
        // (same bounds, every leaf optional).
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
    errors: ErrorsSection,
    spec: SpecSection,
    queue: QueueSection,
    tokens: TokensSection,
    sandbox: SandboxSection,
    repl: ReplSection,
    ui: UiSection,
    notifications: NotificationsSection,
    connectors: ConnectorsSection,
    tenants: z
      .record(z.string(), TenantOverlaySchema)
      .prefault({})
      .describe("Per-tenant override map keyed by tenant_id"),
  })
  .describe("subkit runtime configuration");

export type Config = z.infer<typeof ConfigSchema>;
export type TenantOverlay = z.infer<typeof TenantOverlaySchema>;

const TENANT_OVERLAY_KEYS = [
  "llm",
  "queue",
  "tokens",
  "repl",
  "ui",
  "notifications",
  "connectors",
] as const;
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
  "errors",
  "docker",
  "spec",
  "queue",
  "tokens",
  "sandbox",
  "repl",
  "ui",
  "notifications",
  "connectors",
] as const;
export type SectionKey = (typeof SECTION_ORDER)[number];
