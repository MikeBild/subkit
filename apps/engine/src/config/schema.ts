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

const AuthSection = z
  .object({
    oidc: z
      .object({
        issuer_url: optionalUrl.default("").meta(global({ requiresRestart: true })),
        client_id: z
          .string()
          .default("")
          .meta(global({ requiresRestart: true })),
        client_secret: z
          .string()
          .default("")
          .meta(global({ requiresRestart: true, secret: true })),
        redirect_uri: optionalUrl.default("").meta(global({ requiresRestart: true })),
      })
      .prefault({})
      .describe("Generic OIDC provider"),
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
    firebase: z
      .object({
        project_id: z
          .string()
          .default("")
          .meta(global({ requiresRestart: true })),
        login_url: optionalUrl.default("").meta(global({ requiresRestart: true })),
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
        endpoint: optionalUrl.default("").meta(global()),
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
  // Cross-leaf invariant (#7): knowledge.backend="s3" without
  // storage.s3 credentials is a half-configured engine. Reject at
  // parse time so an operator who flips backend without setting
  // keys gets a precise validation error instead of a runtime
  // surprise on the first knowledge ingest.
  .refine(
    (s) => {
      if (s.knowledge.backend !== "s3") return true;
      return Boolean(s.s3.access_key && s.s3.secret_key);
    },
    {
      message:
        "storage.knowledge.backend='s3' requires storage.s3.access_key and storage.s3.secret_key",
      path: ["knowledge", "backend"],
    },
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

const ErrorsSection = z
  .object({
    ring_size: z.number().int().positive().default(100).meta(global()),
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

// G4 closure of #159 M6 — sk REPL session preferences. Tenant-scoped so
// each operator picks a default permission mode that the next REPL run
// honors at startup. The four-value union mirrors PermissionMode in the
// CLI; the Permissions tab in /settings writes here.
const ReplSection = z
  .object({
    permissionMode: z
      .enum(["ask", "auto", "plan", "yolo"])
      .default("ask")
      .describe(
        // S7 of PR #161 review round 2: keep the description to data
        // semantics; sk-specific UI hints (slash names, key chords)
        // belong in the slash registry / docs, not the OpenAPI surface.
        "Default REPL permission mode for the principal: ask, auto, plan, or yolo.",
      )
      .meta(tenant()),
    // S6 of PR #161 review round 5: surface the `/session` portal-
    // token TTL as an operator-tunable setting instead of hardcoding
    // 15 minutes in the slash handler. Tenant-scoped so different
    // tenants can pick different security/usability tradeoffs without
    // a CLI release.
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

// H1 closure of #159 — sk REPL push-notification preferences.
// Tenant-scoped so each operator picks their own threshold + opt-in.
// `quietHoursStart` and `quietHoursEnd` are 24h "HH:MM" wall-clock
// strings (local timezone) that the CLI uses to suppress emits. An
// empty string disables the time-window check.
//
// S1 of PR #161 review (round 6): single source of truth for the
// HH:MM-or-empty regex. The base section + the tenant overlay both
// reuse this — a future change to the format only edits one place.
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
        // W2 of PR #161 review (round 4): regex-constrain the wall-
        // clock string at the engine boundary. Bare `z.string()` let
        // `"99:99"` or `"foo"` round-trip through the API silently;
        // the CLI's `parseHHMM` then quietly fell back to "no quiet
        // hours". Constraining here makes the OpenAPI surface honest
        // and protects every other consumer (chat adapter, future
        // workflow steps) from the same trap. Pinned shape lives in
        // `QuietHoursStringSchema` above (S1 of round 6).
        quietHoursStart: QuietHoursStringSchema.default("")
          .describe("Quiet-hours window start (HH:MM, local TZ). Empty disables the window.")
          .meta(tenant()),
        quietHoursEnd: QuietHoursStringSchema.default("")
          .describe("Quiet-hours window end (HH:MM, local TZ). Empty disables the window.")
          .meta(tenant()),
      })
      .prefault({}),
  })
  .prefault({})
  .describe("sk REPL notification preferences");

// G5 closure of #159 M11 — UI value pickers (theme, personality, title,
// statusline). Tenant-scoped so each operator's REPL runs with their
// preferred chrome. The Config tab opens the matching ValuePicker
// component when one of these rows is selected.
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

// Web-scraper #144 — every tunable the connector introduces lives here
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
  .describe("Web-scraper connector tunables (#144). Every leaf has a useful default.");

const ConnectorsSection = z
  .object({
    web_scraper: WebScraperSection,
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
            // W2 of PR #161 review (round 4): mirror the regex from
            // `NotificationsSection` via the shared
            // `QuietHoursStringSchema` constant (S1 of round 6).
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
    // Web-scraper #144 — only the tenant-scoped leaves; the robots_cache.*
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
  "repl",
  "ui",
  "notifications",
  "connectors",
] as const;
export type SectionKey = (typeof SECTION_ORDER)[number];
