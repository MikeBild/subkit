// Built-in connector template registry.
//
// The product ships a curated catalogue of connector "templates" — opinionated
// presets that turn into a real connector row when an admin clicks "use this
// template". The catalogue is shipped as JSON bundled at build time so the
// compiled `dist/engine` binary still has access to it. We validate every
// entry through a zod schema so a malformed JSON edit fails noisily at
// module load.
//
// Templates are read-only at runtime; tenant-specific overrides live in the
// `connector_templates` Postgres table and are merged in by the HTTP route
// (this module does not touch the database).

import { z } from "@hono/zod-openapi";
import { HttpError } from "../http/errors.ts";
import builtinJson from "./templates.json" with { type: "json" };

export const TemplateAuthTypeEnum = z.enum([
  "none",
  "header",
  "query",
  "bearer",
  "basic",
  "oauth2",
]);

export const TemplateIngestionSourceEnum = z.enum([
  "openapi",
  "markdown",
  "llms_txt",
  "html",
  "graphql",
  "postgres",
  "wsdl",
  "grpc_reflection",
  "asyncapi",
  "caldav_discovery",
  "unsupported",
]);

export const TokenAuthMethodEnum = z.enum(["body", "basic_auth"]);
export type TokenAuthMethod = z.infer<typeof TokenAuthMethodEnum>;

export const TokenContentTypeEnum = z.enum(["form", "json"]);
export type TokenContentType = z.infer<typeof TokenContentTypeEnum>;

export const OAuth2GrantTypeEnum = z.enum(["authorization_code", "client_credentials"]);
export type OAuth2GrantType = z.infer<typeof OAuth2GrantTypeEnum>;

export const PaginationStrategyEnum = z.enum(["offset", "page", "cursor", "none"]);
export type PaginationStrategy = z.infer<typeof PaginationStrategyEnum>;

export const InlineSchemaSchema = z
  .object({
    format: z.enum(["openapi", "graphql"]),
    content: z.string().min(1),
  })
  .openapi("ConnectorTemplateInlineSchema");
export type InlineSchema = z.infer<typeof InlineSchemaSchema>;

export const ProbeEndpointSchema = z
  .object({
    method: z.enum(["GET", "HEAD", "POST"]),
    // Appended to base_url. Empty string means "probe base_url itself"
    // (useful for GraphQL endpoints where base_url already points at /graphql).
    path: z.string(),
    expected_status: z.tuple([z.number().int().positive(), z.number().int().positive()]),
    description: z.string().default(""),
  })
  .openapi("ConnectorTemplateProbeEndpoint");
export type ProbeEndpoint = z.infer<typeof ProbeEndpointSchema>;

export const CredentialHintSchema = z
  .object({
    field: z.string().min(1),
    label: z.string().min(1),
    placeholder: z.string().default(""),
    doc_url: z.string().nullable(),
    secret: z.boolean(),
  })
  .openapi("ConnectorTemplateCredentialHint");
export type CredentialHint = z.infer<typeof CredentialHintSchema>;

export const BaseUrlOptionSchema = z
  .object({
    environment: z.string().min(1),
    base_url: z.string().min(1),
    label: z.string().min(1),
  })
  .openapi("ConnectorTemplateBaseUrlOption");
export type BaseUrlOption = z.infer<typeof BaseUrlOptionSchema>;

export const PaginationDefaultsSchema = z
  .object({
    strategy: PaginationStrategyEnum,
    offset_param: z.string().optional(),
    page_param: z.string().optional(),
    cursor_request_param: z.string().optional(),
    cursor_response_path: z.string().optional(),
    page_size: z.number().int().positive(),
    stop_condition: z.string().optional(),
  })
  .openapi("ConnectorTemplatePaginationDefaults");
export type PaginationDefaults = z.infer<typeof PaginationDefaultsSchema>;

export const RateLimitHintsSchema = z
  .object({
    requests_per_second: z.number().positive(),
    burst_size: z.number().int().positive(),
    recommended_backoff_ms: z.number().int().positive(),
  })
  .openapi("ConnectorTemplateRateLimits");
export type RateLimitHints = z.infer<typeof RateLimitHintsSchema>;

export const CapabilitiesSchema = z
  .object({
    webhooks: z.boolean(),
    webhook_events: z.array(z.string()).default([]),
    rate_limits: RateLimitHintsSchema.nullable(),
  })
  .openapi("ConnectorTemplateCapabilities");
export type TemplateCapabilities = z.infer<typeof CapabilitiesSchema>;

export const TemplateOAuthSchema = z
  .object({
    issuer_url: z.string(),
    authorization_endpoint: z.string().optional(),
    token_endpoint: z.string().optional(),
    scopes: z.string().optional(),
    grant_type: OAuth2GrantTypeEnum,
    token_auth_method: TokenAuthMethodEnum,
    token_content_type: TokenContentTypeEnum,
    use_pkce: z.boolean(),
    client_id: z.string().nullable(),
    extra_headers: z.record(z.string(), z.string()).default({}),
  })
  .openapi("ConnectorTemplateOAuth");

export const TemplateAuthOptionSchema = z
  .object({
    auth_type: TemplateAuthTypeEnum,
    label: z.string(),
    description: z.string(),
    oauth: TemplateOAuthSchema.nullable().optional(),
  })
  .openapi("ConnectorTemplateAuthOption");

export const ConnectorTemplateSchema = z
  .object({
    version: z.literal(1),
    slug: z
      .string()
      .min(1)
      .regex(/^[a-z0-9][a-z0-9-]*$/),
    name: z.string().min(1),
    driver: z.enum([
      "http",
      "postgres",
      "s3",
      "graphql",
      "mssql",
      "mysql",
      "caldav",
      "webdav",
      "soap",
      "grpc",
      "mqtt",
      "imap",
      "ftp",
    ]),
    base_url: z.string(),
    auth_type: TemplateAuthTypeEnum,
    oauth: TemplateOAuthSchema.nullable(),
    default_skill: z.string().nullable(),
    ingestion_source: TemplateIngestionSourceEnum,
    ingestion_url: z.string().nullable(),
    icon: z.string(),
    description: z.string(),
    category: z.string().min(1),
    tags: z.array(z.string()).default([]),
    setup_instructions: z.string().min(1),
    auth_options: z.array(TemplateAuthOptionSchema).default([]),
    url_pattern: z.string().min(1),
    keywords: z.array(z.string()).default([]),
    inline_schema: InlineSchemaSchema.nullable(),
    probe_endpoint: ProbeEndpointSchema.nullable(),
    credential_hints: z.array(CredentialHintSchema).default([]),
    base_url_options: z.array(BaseUrlOptionSchema).default([]),
    pagination_defaults: PaginationDefaultsSchema.nullable(),
    capabilities: CapabilitiesSchema,
  })
  .superRefine((t, ctx) => {
    // Consistency gate: a template that offers BOTH a primary non-oauth auth
    // AND an oauth block MUST enumerate both paths in `auth_options` so the
    // operator/LLM can pick one deliberately.
    const mixesWithOauth = t.oauth !== null && t.auth_type !== "oauth2";
    if (mixesWithOauth && t.auth_options.length < 2) {
      ctx.addIssue({
        code: z.ZodIssueCode.custom,
        path: ["auth_options"],
        message:
          `template "${t.slug}" mixes auth_type=${t.auth_type} with an oauth block ` +
          `but declares fewer than 2 auth_options — add an explicit auth_options ` +
          `array enumerating the primary + oauth2 paths, or remove the oauth block.`,
      });
    }
    // url_pattern must compile to a valid RegExp. Invalid patterns would
    // otherwise surface only at the first `matchTemplateByUrl` call.
    try {
      new RegExp(t.url_pattern);
    } catch (e) {
      ctx.addIssue({
        code: z.ZodIssueCode.custom,
        path: ["url_pattern"],
        message: `template "${t.slug}" has invalid url_pattern: ${String(e)}`,
      });
    }
    // credential_hints.field must be unique per template.
    const fields = t.credential_hints.map((h) => h.field);
    if (new Set(fields).size !== fields.length) {
      ctx.addIssue({
        code: z.ZodIssueCode.custom,
        path: ["credential_hints"],
        message: `template "${t.slug}" has duplicate credential_hints.field entries`,
      });
    }
    // base_url_options.environment must be unique per template.
    const envs = t.base_url_options.map((o) => o.environment);
    if (new Set(envs).size !== envs.length) {
      ctx.addIssue({
        code: z.ZodIssueCode.custom,
        path: ["base_url_options"],
        message: `template "${t.slug}" has duplicate base_url_options.environment entries`,
      });
    }
  })
  .openapi("ConnectorTemplate");

export type ConnectorTemplate = z.infer<typeof ConnectorTemplateSchema>;

export interface CompiledTemplate {
  template: ConnectorTemplate;
  urlRe: RegExp;
  specificity: number;
}

/**
 * Specificity score for a url_pattern. Literal-heavy patterns win over
 * wildcard-heavy ones. Tie-break is by slug alphabetical order at the
 * caller site.
 */
function computeSpecificity(pattern: string): number {
  const base = pattern.length;
  const wildcards = (pattern.match(/\[|\.\*|\.\+|\\w|\\d|\\s|\[\^/g) ?? []).length;
  const literalHost = pattern.match(/^\^?https?:\\\/\\\/([a-z0-9.-]+)/i);
  const fixedHostSegments = literalHost
    ? literalHost[1]!.split(/\\\./).filter((s) => s.length > 0).length
    : 0;
  return base - 3 * wildcards + 5 * fixedHostSegments;
}

let cached: ConnectorTemplate[] | null = null;
let compiledCache: CompiledTemplate[] | null = null;

/**
 * Return the validated, in-memory list of built-in templates. The first call
 * parses + freezes the array; subsequent calls re-use the cached copy. Throws
 * a typed `Error` if any entry fails the schema — this is intentional: we
 * want a malformed edit to break startup, not silently ship a broken catalog.
 */
export function loadBuiltinTemplates(): ConnectorTemplate[] {
  if (cached) return cached;
  const parsed = z.array(ConnectorTemplateSchema).safeParse(builtinJson);
  if (!parsed.success) {
    const issues = parsed.error.issues.map((i) => `${i.path.join(".")}: ${i.message}`).join("; ");
    throw new Error(`templates.json validation failed: ${issues}`);
  }
  if (parsed.data.length < 10) {
    throw new Error(
      `templates.json must contain at least 10 templates, found ${parsed.data.length}`,
    );
  }
  cached = Object.freeze([...parsed.data]) as ConnectorTemplate[];
  return cached;
}

/**
 * Return the built-in templates together with their compiled `url_pattern`
 * RegExp and pre-computed specificity score. Used by `matchTemplateByUrl`.
 */
export function loadCompiledTemplates(): CompiledTemplate[] {
  if (compiledCache) return compiledCache;
  const templates = loadBuiltinTemplates();
  compiledCache = Object.freeze(
    templates.map((template) => ({
      template,
      urlRe: new RegExp(template.url_pattern),
      specificity: computeSpecificity(template.url_pattern),
    })),
  ) as CompiledTemplate[];
  return compiledCache;
}

/**
 * Look up a single built-in template by slug.
 */
export function getBuiltinTemplate(slug: string): ConnectorTemplate | null {
  return loadBuiltinTemplates().find((t) => t.slug === slug) ?? null;
}

/**
 * Typed error raised when a caller asks the engine to ingest documentation
 * from a template whose `ingestion_source` is `unsupported`. Subclasses
 * `HttpError` so the central error middleware emits the typed
 * `unsupported_ingestion_source` envelope automatically.
 */
export class UnsupportedIngestionSourceError extends HttpError {
  readonly slug: string;
  constructor(slug: string) {
    super(
      400,
      "unsupported_ingestion_source",
      `template ${slug} does not have a supported ingestion source`,
      { slug },
    );
    this.slug = slug;
  }
}
