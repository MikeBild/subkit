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
import { type WorkflowDef, WorkflowDefSchema } from "../workflows/types.ts";
import templateSkillsJson from "./template-skills.json" with { type: "json" };
import builtinJson from "./templates.json" with { type: "json" };
import { OperatorQuirksSchema } from "./types.ts";

export const TemplateAuthTypeEnum = z.enum([
  "none",
  "header",
  "query",
  "bearer",
  "basic",
  "oauth2",
  "aws_sigv4",
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

export const ProbeEndpointSchema = z
  .object({
    method: z.enum(["GET", "HEAD", "POST"]),
    // Appended to base_url. Empty string means "probe base_url itself"
    // (useful for GraphQL endpoints where base_url already points at /graphql).
    path: z.string(),
    /** Inclusive [min, max] HTTP status range that counts as "probe
     *  succeeded". Optional — when omitted, the probe accepts any 2xx.
     *  Pre-fix this was required, which broke any template author
     *  that legitimately wanted "2xx is fine, no need to be more
     *  specific" — including all four AWS / GCP templates added
     *  alongside the auth-flows feature. */
    expected_status: z.tuple([z.number().int().positive(), z.number().int().positive()]).optional(),
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
    dynamic_registration: z.boolean().default(false),
    // client_credentials_json extension. Only meaningful when
    // grant_type === "client_credentials_json".
    /** How to extract the token from the response body. */
    token_response_format: z.enum(["raw", "json"]).optional(),
    /** Fallback TTL in milliseconds when the response carries no expiry. */
    token_response_ttl_ms: z.number().positive().optional(),
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

// Recipe category mirrors the connector category enum so authoring stays
// anchored to the same vocabulary the rest of the catalog uses. `other`
// is the escape hatch for cross-cutting recipes (multi-connector chains
// where no single category dominates).
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

// Multi-connector binding. When a recipe spans more than one connector,
// each `placeholder` UUID inside `recipe.workflow` (any step's
// `connector_id` field carrying that UUID) is rebound by
// `start_workflow_from_recipe` to a saved connector matching `template`.
// The single-connector legacy path (placeholder UUID
// `00000000-0000-0000-0000-000000000000` substituted for the `connector_id`
// arg) still works when `required_connectors` is empty.
export const RecipeRequiredConnectorSchema = z
  .object({
    placeholder: z.string().uuid(),
    template: z.string().min(1),
  })
  .openapi("RecipeRequiredConnector");

// Per-template executable workflow recipe. A recipe IS a workflow — the
// `workflow` field runs through the same `WorkflowDefSchema` that gates
// every saved workflow, so a recipe is guaranteed to be structurally
// valid (id uniqueness, JSONata parse, loop bodies, etc.). Recipes cover
// the gap between a markdown skill (which describes the connector) and a
// working draft the operator can clone and edit. Surfaced to the LLM via
// `start_workflow_from_recipe(template_slug, recipe_slug)` and via
// `connector-template-intelligence` when a connector is in scope.
export const ConnectorRecipeSchema = z
  .object({
    slug: z
      .string()
      .min(1)
      .regex(/^[a-z0-9][a-z0-9-]*$/),
    title: z.string().min(1),
    description: z.string().min(1),
    /** Words/phrases the conversation pipeline matches against the user
     *  intent to surface this recipe ahead of others. Lowercased before
     *  match. Empty list = recipe is only reachable by explicit slug. */
    intent_keywords: z.array(z.string().min(1)).default([]),
    /** Optional pointer to a `template-skills.json` slug. When set, the
     *  cloned workflow draft inherits `derived_from_skill_id` so the
     *  workflow validator can apply the proof-before-save gate. */
    derived_from_skill: z.string().min(1).nullable().default(null),
    /** Discovery: which broad category the recipe serves. Mirrors the
     *  connector category enum so the LLM and operator UI can group
     *  recipes the same way they group connectors. */
    category: RecipeCategoryEnum.default("other"),
    /** Discovery: free-form labels (e.g. `"webhook"`, `"daily-digest"`,
     *  `"notification"`) the LLM and search surfaces can rank against.
     *  Distinct from `intent_keywords` — tags describe the SHAPE of the
     *  recipe (trigger kind, pattern, vertical), keywords describe the
     *  intent the operator might phrase. */
    tags: z.array(z.string().min(1)).default([]),
    /** Operator guidance: rough effort to take the cloned draft to a
     *  saved, dry-run-green workflow. Defaults to `intermediate` when
     *  auto-migrated from the legacy shape. */
    difficulty: RecipeDifficultyEnum.default("intermediate"),
    /** Operator guidance: estimated minutes to first successful save +
     *  dry-run after cloning. Five minutes is the historical median for
     *  the existing 190 recipes; raise for chained-auth or webhook
     *  recipes that demand external setup. */
    estimated_setup_minutes: z.number().int().positive().default(5),
    /** Operator guidance: external prerequisites the operator must have
     *  in place before the cloned draft can dry-run successfully (e.g.
     *  `"Stripe API key with events:read"`, `"Slack channel write
     *  permission"`). Not enforced at clone time — surfaced in
     *  `inspect_recipe` so the operator can self-verify. */
    prerequisites: z.array(z.string().min(1)).default([]),
    /** Optional canonical input example. When set, must satisfy the
     *  workflow's `input_schema` (lint enforces). The LLM uses this to
     *  populate the cloned draft's first dry-run without prompting the
     *  operator for shape. */
    sample_input: z.unknown().nullable().default(null),
    /** Optional redacted output preview. Operator sees this in
     *  `inspect_recipe` to confirm the recipe matches the intent before
     *  cloning. PII / secrets must be masked. */
    expected_output_preview: z.unknown().nullable().default(null),
    /** Multi-connector binding. Empty (default) means the recipe is
     *  single-connector — the legacy
     *  `00000000-0000-0000-0000-000000000000` placeholder substitution
     *  still applies. When non-empty, every UUID listed must appear at
     *  least once in `workflow.steps[*].connector_id`; lint enforces. */
    required_connectors: z.array(RecipeRequiredConnectorSchema).default([]),
    /** Recipe semver. Bump on shape changes that break cloned drafts;
     *  bump minor on additive changes; bump patch on copy-only
     *  changes. Operators see this in `inspect_recipe`. */
    version: z
      .string()
      .regex(/^\d+\.\d+\.\d+$/)
      .default("1.0.0"),
    /** Provenance. `subkit-builtin` for everything in `templates.json`;
     *  `tenant` for tenant-authored recipes via the per-tenant authoring
     *  surface. */
    author: RecipeAuthorEnum.default("subkit-builtin"),
    /** Quality marker: when this recipe was last dry-run successfully
     *  against a vendor sandbox. Null means schema-only validation
     *  only — operators should still trust the recipe but treat
     *  vendor-specific quirks (rate limits, edge-case errors) as
     *  unverified. The competitive page leads with this field, not
     *  the raw recipe count. */
    last_validated_at: z.string().datetime().nullable().default(null),
    /** Deprecation marker. When set, `inspect_recipe` and
     *  `start_workflow_from_recipe` emit a warning pointing the
     *  operator at `replacement_slug`. The recipe still clones — no
     *  silent breakage, no shim. */
    deprecated: z
      .object({
        since: z.string().datetime(),
        replacement_slug: z.string().min(1),
      })
      .nullable()
      .default(null),
    // The workflow shape is validated through WorkflowDefSchema at
    // template load time (see `loadBuiltinTemplates` below). For the
    // OpenAPI surface we expose it as a generic object — recursing
    // into the full discriminated-union step schema crashed
    // @asteasolutions/zod-to-openapi's `isNullableSchema` detection
    // on the superRefine wrapper. The TypeScript type stays exact:
    // every parser invocation goes through WorkflowDefSchema, so the
    // runtime shape is identical; the static type is `WorkflowDef`
    // via the cast below.
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
    version: z.literal(1),
    slug: z
      .string()
      .min(1)
      .regex(/^[a-z0-9][a-z0-9-]*$/),
    name: z.string().min(1),
    driver: z.enum(["http", "postgres", "s3", "graphql"]),
    /** Operator-supplied or template-default base URL. Nullable for
     *  templates whose endpoint is per-tenant / per-region (e.g.
     *  AppSync, API Gateway, GCP service-account-driven APIs). The
     *  draft authoring flow asks the operator for the URL up front. */
    base_url: z.string().nullable(),
    auth_type: TemplateAuthTypeEnum,
    oauth: TemplateOAuthSchema.nullable(),
    default_skill: z.string().nullable(),
    /** Ingestion strategy hint. Nullable for templates that don't
     *  expose a discoverable spec (AWS IAM-signed services). */
    ingestion_source: TemplateIngestionSourceEnum.nullable(),
    ingestion_url: z.string().nullable(),
    icon: z.string(),
    description: z.string(),
    category: z.string().min(1),
    tags: z.array(z.string()).default([]),
    aliases: z.array(z.string()).default([]),
    setup_instructions: z.string().min(1),
    auth_options: z.array(TemplateAuthOptionSchema).default([]),
    /** Regex matched against connector base URLs to disambiguate
     *  templates. Nullable when the template can't predict the URL
     *  (per-tenant AppSync IDs, GCP-style API hosts). */
    url_pattern: z.string().min(1).nullable(),
    keywords: z.array(z.string()).default([]),
    inline_schema: InlineSchemaSchema.nullable(),
    probe_endpoint: ProbeEndpointSchema.nullable(),
    credential_hints: z.array(CredentialHintSchema).default([]),
    base_url_options: z.array(BaseUrlOptionSchema).default([]),
    pagination_defaults: PaginationDefaultsSchema.nullable(),
    capabilities: CapabilitiesSchema,
    /**
     * Optional list of canonical request paths surfaced to the LLM
     * authoring agent so it does not have to guess `/v2` prefixes.
     * Each entry is a path *relative to* `base_url` (i.e. paths must NOT
     * include the segment already baked into `base_url`). The propose-step
     * tool surfaces these in its response so the next round-trip carries
     * the hint. Pre-fix the LLM in session f00b8d1c repeatedly authored
     * `/v2/projects` against a connector whose base_url already ended in
     * `/v2`, producing recurring `https://…/v2/v2/projects` 404s.
     */
    example_paths: z.array(z.string()).default([]),
    /**
     * Categorized operator quirks propagated to every connector created
     * from this template. The context assembler picks only the
     * relevant categories per turn — `auth + pagination + rate_limit`
     * for `propose_step kind=request`, `schema` for `kind=transform`,
     * `error_handling` after a failed envelope, `general` otherwise.
     * Each slot caps at 2K characters; the whole block lives in the
     * stable cached prompt section.
     */
    operator_quirks: OperatorQuirksSchema.default({}),
    /**
     * Per-template executable workflow recipes. Each recipe IS a
     * workflow validated through `WorkflowDefSchema`, so recipes are
     * structurally guaranteed to load and run. The conversation tool
     * `start_workflow_from_recipe` clones a recipe into a draft the
     * operator can edit. Empty array means the template ships no
     * starter workflows (LLM must author from scratch using the
     * markdown skill + ingested docs).
     */
    recipes: z.array(ConnectorRecipeSchema).default([]),
    /**
     * AWS SigV4 service identifier (e.g. `lambda`, `dynamodb`,
     * `cognito-idp`, `appsync`, `execute-api`). Required for templates
     * with `auth_type: "aws_sigv4"` so the http driver can sign
     * requests; null otherwise. The enrichment pipeline copies this
     * into `config.aws_service` at draft mint time.
     */
    aws_service: z.string().min(1).nullable().default(null),
    /**
     * AWS region default for templates with a region-specific endpoint
     * (e.g. `us-east-1`). Optional even on aws_sigv4 templates because
     * per-tenant endpoints (AppSync IDs, API Gateway custom domains)
     * carry the region in `base_url` instead. Enrichment seeds
     * `config.aws_region` from this value when present, then from
     * `base_url` parsing as a fallback.
     */
    aws_region: z.string().min(1).nullable().default(null),
    /**
     * Vendor-drift sweep stamp — wall-clock ISO8601 timestamp of the
     * last successful Layer-3 audit run that confirmed the template's
     * `base_url`, `probe_endpoint`, and (where applicable) the OAuth
     * issuer's `.well-known/openid-configuration` are still live. `null`
     * means the template has never been swept (a fresh authoring entry,
     * or the script has not been run since the field landed). The
     * Layer-1 lint emits a `console.warn` (not a failure) when this is
     * `null` or older than 90 days; the Layer-3 vendor-drift sweep
     * (gated by `RUN_TEMPLATE_AUDIT=1`, maintained in the `subkit-deploy`
     * repo) refreshes it. See `docs/connectors.md` →
     * "Vendor-drift sweep" for the lifecycle.
     */
    verified_at: z.string().datetime().nullable().default(null),
    /**
     * Opts the web-scraper template into robots.txt enforcement
     * inside `drivers/http.ts buildRequestPlan`. This field GATES the
     * cascade; once gated, the tenant-overlay
     * `connectors.web_scraper.runtime.respect_robots` toggle (and the
     * per-connector `config.respect_robots` override) decide whether
     * the check actually fires. Default `false` keeps the 101 existing
     * private-API templates exempt; future RSS / sitemap / crawler
     * templates opt in by setting `true` without a driver code change.
     */
    respects_robots: z.boolean().default(false),
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
    // url_pattern must compile to a valid RegExp when present. Templates
    // without a stable URL pattern (per-tenant AppSync IDs, GCP service
    // accounts) leave it null and skip the URL-match path.
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
      // Semantic guard: a backslash-escaped character class (`\[\^…`) compiles
      // fine but matches the *literal* string "[^/]+" instead of "any host" —
      // so the pattern silently never matches a real URL. This over-escape is a
      // generation typo that the compile check above cannot catch; reject it at
      // the boundary so a malformed pattern can never reach `matchTemplateByUrl`.
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
    // NB: "every auth-requiring template documents an auth path in auth_options"
    // is enforced for the BUILT-IN catalog by templates.test.ts, NOT here — the
    // same schema validates tenant-authored templates on read, and an empty
    // auth_options is a legitimate (if terse) tenant shape we must not reject
    // retroactively. The builtin catalog is curated, so the test is the right
    // chokepoint for it.
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
    const aliases = t.aliases.map((alias) => alias.toLowerCase());
    if (new Set(aliases).size !== aliases.length) {
      ctx.addIssue({
        code: z.ZodIssueCode.custom,
        path: ["aliases"],
        message: `template "${t.slug}" has duplicate aliases`,
      });
    }
    // Recipe slug uniqueness per template — the recipe slug is a stable
    // identifier the LLM passes to `start_workflow_from_recipe` and must
    // be unambiguous within the template.
    const recipeSlugs = t.recipes.map((r) => r.slug);
    if (new Set(recipeSlugs).size !== recipeSlugs.length) {
      ctx.addIssue({
        code: z.ZodIssueCode.custom,
        path: ["recipes"],
        message: `template "${t.slug}" has duplicate recipe slugs`,
      });
    }
    // aws_sigv4 templates must declare the SigV4 service so the http
    // driver knows what to sign for. aws_region may be null for
    // per-tenant endpoints — drivers fall back to URL parsing or
    // explicit operator config in that case.
    if (t.auth_type === "aws_sigv4" && t.aws_service === null) {
      ctx.addIssue({
        code: z.ZodIssueCode.custom,
        path: ["aws_service"],
        message: `template "${t.slug}" has auth_type=aws_sigv4 but no aws_service`,
      });
    }
  })
  .openapi("ConnectorTemplate");

export type ConnectorTemplate = z.infer<typeof ConnectorTemplateSchema>;

export interface CompiledTemplate {
  template: ConnectorTemplate;
  /** `null` when the template has no `url_pattern` (per-tenant URL
   *  templates like AppSync / GCP). Such templates are unreachable
   *  via `matchTemplateByUrl` — they're surfaced to the LLM via slug
   *  lookup instead. */
  urlRe: RegExp | null;
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
  const literalHost = pattern.match(/^\^?https?:\\\/\\\/([a-z0-9.-]+)/i)?.[1];
  const fixedHostSegments = literalHost
    ? literalHost.split(/\\\./).filter((s) => s.length > 0).length
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
 *
 * Also enforces template ↔ skill cross-reference integrity: every template's
 * non-null `default_skill` must resolve to an entry in `template-skills.json`.
 * Stale renames break startup instead of silently failing to seed the skill
 * when a connector is later created from the template.
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
      urlRe: template.url_pattern ? new RegExp(template.url_pattern) : null,
      specificity: template.url_pattern ? computeSpecificity(template.url_pattern) : 0,
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
