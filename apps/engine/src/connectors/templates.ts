import { z } from "@hono/zod-openapi";
import { HttpError } from "../http/errors.ts";
import { type WorkflowDef, WorkflowDefSchema } from "../workflows/types.ts";
import templateSkillsJson from "./template-skills.json" with { type: "json" };
import builtinJson from "./templates.json" with { type: "json" };
import { DriverEnum, OperatorQuirksSchema } from "./types.ts";

export const TemplateAuthTypeEnum = z.enum([
  "none",
  "header",
  "query",
  "bearer",
  "basic",
  "oauth2",
  "signed_jwt",
  "aws_sigv4",
]);

export const TemplateIngestionSourceEnum = z.enum([
  "openapi",
  "google_discovery",
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

export const OAuth2GrantTypeEnum = z.enum([
  "authorization_code",
  "client_credentials",
  "password",
  "cognito_user_password",
  "client_credentials_json",
]);
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

const PROBE_HEADER_NAME_RE = /^[!#$%&'*+\-.^_`|~0-9A-Za-z]+$/;
const PROBE_RESERVED_HEADER_NAMES = new Set([
  "authorization",
  "proxy-authorization",
  "cookie",
  "set-cookie",
  "host",
  "content-length",
  "transfer-encoding",
  "connection",
  "upgrade",
]);
const PROBE_AUTH_HEADER_PART_RE = /(?:^|[-_])(api[-_]?key|token|secret|credential|auth)(?:$|[-_])/i;

export const ProbeHeadersSchema = z
  .record(
    z.string().max(128).regex(PROBE_HEADER_NAME_RE),
    z
      .string()
      .min(1)
      .max(1024)
      .refine((value) => !/[\r\n]/.test(value), "header values cannot contain CR or LF"),
  )
  .superRefine((headers, ctx) => {
    const entries = Object.entries(headers);
    if (entries.length > 16) {
      ctx.addIssue({ code: "custom", message: "probe headers are limited to 16 entries" });
    }
    let totalBytes = 0;
    for (const [name, value] of entries) {
      const normalized = name.toLowerCase();
      totalBytes += new TextEncoder().encode(`${name}:${value}\r\n`).byteLength;
      if (
        PROBE_RESERVED_HEADER_NAMES.has(normalized) ||
        PROBE_AUTH_HEADER_PART_RE.test(normalized)
      ) {
        ctx.addIssue({
          code: "custom",
          path: [name],
          message: `probe header "${name}" is reserved for transport or saved credentials`,
        });
      }
    }
    if (totalBytes > 8192) {
      ctx.addIssue({ code: "custom", message: "probe headers are limited to 8192 bytes" });
    }
  });

export const ProbeEndpointSchema = z
  .object({
    method: z.enum(["GET", "HEAD", "POST"]),
    path: z.string(),
    expected_status: z.tuple([z.number().int().positive(), z.number().int().positive()]).optional(),
    description: z.string().default(""),
    headers: ProbeHeadersSchema.optional(),
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
    header_name: z.string().regex(PROBE_HEADER_NAME_RE).optional(),
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
    dynamic_registration: z.boolean().default(false),
    token_response_format: z.enum(["raw", "json"]).optional(),
    token_response_ttl_ms: z.number().positive().optional(),
  })
  .openapi("ConnectorTemplateOAuth");

const JwtClaimValueSchema = z.union([
  z.string(),
  z.number().finite(),
  z.boolean(),
  z.array(z.union([z.string(), z.number().finite(), z.boolean()])),
]);

export const TemplateSignedJwtSchema = z
  .object({
    algorithm: z.enum(["ES256", "RS256"]),
    audience: z.union([z.string().min(1), z.array(z.string().min(1)).min(1)]),
    issuer: z.string().min(1).optional(),
    subject: z.string().min(1).optional(),
    key_id: z.string().min(1).optional(),
    claims: z.record(z.string().min(1), JwtClaimValueSchema).default({}),
    ttl_seconds: z.number().int().min(60).max(3600).default(300),
  })
  .superRefine((value, ctx) => {
    for (const name of Object.keys(value.claims)) {
      if (["aud", "exp", "iat", "iss", "nbf", "sub"].includes(name)) {
        ctx.addIssue({
          code: z.ZodIssueCode.custom,
          path: ["claims", name],
          message: `claims.${name} is reserved for signed JWT authentication`,
        });
      }
    }
  })
  .openapi("ConnectorTemplateSignedJwt");

export const TemplateAuthOptionSchema = z
  .object({
    auth_type: TemplateAuthTypeEnum,
    label: z.string(),
    description: z.string(),
    oauth: TemplateOAuthSchema.nullable().optional(),
    signed_jwt: TemplateSignedJwtSchema.nullable().optional(),
  })
  .openapi("ConnectorTemplateAuthOption");

export const RecipeCategoryEnum = z.enum([
  "ai",
  "analytics",
  "aws",
  "cloud",
  "communication",
  "crm",
  "database",
  "devops",
  "ecommerce",
  "enterprise",
  "marketing",
  "payments",
  "productivity",
  "project-management",
  "protocol",
  "scraping",
  "storage",
  "support",
  "other",
]);

export const RecipeDifficultyEnum = z.enum(["beginner", "intermediate", "advanced"]);
export const RecipeAuthorEnum = z.enum(["subkit-builtin", "tenant"]);

export const RecipeRequiredConnectorSchema = z
  .object({
    placeholder: z.string().uuid(),
    template: z.string().min(1),
  })
  .openapi("RecipeRequiredConnector");

export const ConnectorRecipeSchema = z
  .object({
    slug: z
      .string()
      .min(1)
      .regex(/^[a-z0-9][a-z0-9-]*$/),
    title: z.string().min(1),
    description: z.string().min(1),
    intent_keywords: z.array(z.string().min(1)).default([]),
    derived_from_skill: z.string().min(1).nullable().default(null),
    category: RecipeCategoryEnum.default("other"),
    tags: z.array(z.string().min(1)).default([]),
    difficulty: RecipeDifficultyEnum.default("intermediate"),
    estimated_setup_minutes: z.number().int().positive().default(5),
    prerequisites: z.array(z.string().min(1)).default([]),
    sample_input: z.unknown().nullable().default(null),
    expected_output_preview: z.unknown().nullable().default(null),
    required_connectors: z.array(RecipeRequiredConnectorSchema).default([]),
    version: z
      .string()
      .regex(/^\d+\.\d+\.\d+$/)
      .default("1.0.0"),
    author: RecipeAuthorEnum.default("subkit-builtin"),
    last_validated_at: z.string().datetime().nullable().default(null),
    deprecated: z
      .object({
        since: z.string().datetime(),
        replacement_slug: z.string().min(1),
      })
      .nullable()
      .default(null),
    workflow: z
      .unknown()
      .refine((v) => WorkflowDefSchema.safeParse(v).success, {
        message: "recipe.workflow must satisfy WorkflowDefSchema",
      })
      .transform((v) => v as WorkflowDef)
      .openapi({ type: "object" }),
  })
  .openapi("ConnectorTemplateRecipe");
export type ConnectorRecipe = z.infer<typeof ConnectorRecipeSchema>;

export const ConnectorTemplateSchema = z
  .object({
    version: z.number().int().positive(),
    slug: z
      .string()
      .min(1)
      .regex(/^[a-z0-9][a-z0-9-]*$/),
    name: z.string().min(1),
    driver: DriverEnum,
    base_url: z.string().nullable(),
    auth_type: TemplateAuthTypeEnum,
    oauth: TemplateOAuthSchema.nullable(),
    signed_jwt: TemplateSignedJwtSchema.nullable().default(null),
    default_skill: z.string().nullable(),
    ingestion_source: TemplateIngestionSourceEnum.nullable(),
    ingestion_url: z.string().nullable(),
    icon: z.string(),
    description: z.string(),
    category: z.string().min(1),
    tags: z.array(z.string()).default([]),
    aliases: z.array(z.string()).default([]),
    setup_instructions: z.string().min(1),
    auth_options: z.array(TemplateAuthOptionSchema).default([]),
    url_pattern: z.string().min(1).nullable(),
    keywords: z.array(z.string()).default([]),
    inline_schema: InlineSchemaSchema.nullable(),
    probe_endpoint: ProbeEndpointSchema.nullable(),
    credential_hints: z.array(CredentialHintSchema).default([]),
    base_url_options: z.array(BaseUrlOptionSchema).default([]),
    pagination_defaults: PaginationDefaultsSchema.nullable(),
    capabilities: CapabilitiesSchema,
    example_paths: z.array(z.string()).default([]),
    operator_quirks: OperatorQuirksSchema.default({}),
    recipes: z.array(ConnectorRecipeSchema).default([]),
    aws_service: z.string().min(1).nullable().default(null),
    aws_region: z.string().min(1).nullable().default(null),
    verified_at: z.string().datetime().nullable().default(null),
    respects_robots: z.boolean().default(false),
  })
  .superRefine((t, ctx) => {
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
    if (t.url_pattern !== null) {
      try {
        new RegExp(t.url_pattern);
      } catch (e) {
        ctx.addIssue({
          code: z.ZodIssueCode.custom,
          path: ["url_pattern"],
          message: `template "${t.slug}" has invalid url_pattern: ${String(e)}`,
        });
      }
      if (/\\\[\\?\^/.test(t.url_pattern)) {
        ctx.addIssue({
          code: z.ZodIssueCode.custom,
          path: ["url_pattern"],
          message:
            `template "${t.slug}" has an over-escaped character class in url_pattern ` +
            `(found \\[\\^ — this matches the literal text "[^...]", never a real host). ` +
            `Use an unescaped class such as [^/]+ instead.`,
        });
      }
    }
    const fields = t.credential_hints.map((h) => h.field);
    if (new Set(fields).size !== fields.length) {
      ctx.addIssue({
        code: z.ZodIssueCode.custom,
        path: ["credential_hints"],
        message: `template "${t.slug}" has duplicate credential_hints.field entries`,
      });
    }
    const envs = t.base_url_options.map((o) => o.environment);
    if (new Set(envs).size !== envs.length) {
      ctx.addIssue({
        code: z.ZodIssueCode.custom,
        path: ["base_url_options"],
        message: `template "${t.slug}" has duplicate base_url_options.environment entries`,
      });
    }
    const aliases = t.aliases.map((alias) => alias.toLowerCase());
    if (new Set(aliases).size !== aliases.length) {
      ctx.addIssue({
        code: z.ZodIssueCode.custom,
        path: ["aliases"],
        message: `template "${t.slug}" has duplicate aliases`,
      });
    }
    const recipeSlugs = t.recipes.map((r) => r.slug);
    if (new Set(recipeSlugs).size !== recipeSlugs.length) {
      ctx.addIssue({
        code: z.ZodIssueCode.custom,
        path: ["recipes"],
        message: `template "${t.slug}" has duplicate recipe slugs`,
      });
    }
    if (t.auth_type === "aws_sigv4" && t.aws_service === null) {
      ctx.addIssue({
        code: z.ZodIssueCode.custom,
        path: ["aws_service"],
        message: `template "${t.slug}" has auth_type=aws_sigv4 but no aws_service`,
      });
    }
    if (t.auth_type === "signed_jwt" && t.signed_jwt === null) {
      ctx.addIssue({
        code: z.ZodIssueCode.custom,
        path: ["signed_jwt"],
        message: `template "${t.slug}" has auth_type=signed_jwt but no signed_jwt policy`,
      });
    }
    if (t.auth_type === "signed_jwt" && t.oauth !== null) {
      ctx.addIssue({
        code: z.ZodIssueCode.custom,
        path: ["oauth"],
        message: `template "${t.slug}" must not mix direct signed JWT authentication with OAuth`,
      });
    }
  })
  .openapi("ConnectorTemplate");

export type ConnectorTemplate = z.infer<typeof ConnectorTemplateSchema>;

export interface CompiledTemplate {
  template: ConnectorTemplate;
  urlRe: RegExp | null;
  specificity: number;
}

function computeSpecificity(pattern: string): number {
  const base = pattern.length;
  const wildcards = (pattern.match(/\[|\.\*|\.\+|\\w|\\d|\\s|\[\^/g) ?? []).length;
  const literalHost = pattern.match(/^\^?https?:\\\/\\\/([a-z0-9.-]+)/i)?.[1];
  const fixedHostSegments = literalHost
    ? literalHost.split(/\\\./).filter((s) => s.length > 0).length
    : 0;
  return base - 3 * wildcards + 5 * fixedHostSegments;
}

let cached: ConnectorTemplate[] | null = null;
let compiledCache: CompiledTemplate[] | null = null;

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
  validateTemplateSkillReferences(parsed.data);
  cached = Object.freeze([...parsed.data]) as ConnectorTemplate[];
  return cached;
}

function validateTemplateSkillReferences(templates: ConnectorTemplate[]): void {
  const knownSkills = new Set(Object.keys(templateSkillsJson as Record<string, unknown>));
  const orphans: string[] = [];
  for (const t of templates) {
    if (t.default_skill && !knownSkills.has(t.default_skill)) {
      orphans.push(`${t.slug} -> ${t.default_skill}`);
    }
    for (const recipe of t.recipes) {
      if (recipe.derived_from_skill && !knownSkills.has(recipe.derived_from_skill)) {
        orphans.push(`${t.slug}.recipes.${recipe.slug} -> ${recipe.derived_from_skill}`);
      }
    }
  }
  if (orphans.length > 0) {
    throw new Error(
      `templates.json references missing skills in template-skills.json: ${orphans.join(", ")}`,
    );
  }
}

export function loadCompiledTemplates(): CompiledTemplate[] {
  if (compiledCache) return compiledCache;
  const templates = loadBuiltinTemplates();
  compiledCache = Object.freeze(
    templates.map((template) => ({
      template,
      urlRe: template.url_pattern ? new RegExp(template.url_pattern) : null,
      specificity: template.url_pattern ? computeSpecificity(template.url_pattern) : 0,
    })),
  ) as CompiledTemplate[];
  return compiledCache;
}

export function getBuiltinTemplate(slug: string): ConnectorTemplate | null {
  return loadBuiltinTemplates().find((t) => t.slug === slug) ?? null;
}

export class UnsupportedIngestionSourceError extends HttpError {
  readonly slug: string;
  constructor(slug: string) {
    super(
      400,
      "unsupported_ingestion_source",
      `template ${slug} does not have a supported ingestion source`,
      { details: { slug } },
    );
    this.slug = slug;
  }
}
