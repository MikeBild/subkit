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
  "unsupported",
]);

export const TemplateOAuthSchema = z
  .object({
    issuer_url: z.string(),
    authorization_endpoint: z.string().optional(),
    token_endpoint: z.string().optional(),
    scopes: z.string().optional(),
  })
  .openapi("ConnectorTemplateOAuth");

export const ConnectorTemplateSchema = z
  .object({
    slug: z
      .string()
      .min(1)
      .regex(/^[a-z0-9][a-z0-9-]*$/),
    name: z.string().min(1),
    driver: z.enum(["http", "postgres"]),
    base_url: z.string(),
    auth_type: TemplateAuthTypeEnum,
    oauth: TemplateOAuthSchema.nullable(),
    default_skill: z.string().nullable(),
    ingestion_source: TemplateIngestionSourceEnum,
    ingestion_url: z.string().nullable(),
    icon: z.string(),
    description: z.string(),
  })
  .openapi("ConnectorTemplate");

export type ConnectorTemplate = z.infer<typeof ConnectorTemplateSchema>;

let cached: ConnectorTemplate[] | null = null;

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
  // Sanity: the spec ships exactly 10 templates. Drift here usually means
  // somebody added one without updating tests/docs, so we fail loudly.
  if (parsed.data.length !== 10) {
    throw new Error(
      `templates.json must contain exactly 10 templates, found ${parsed.data.length}`,
    );
  }
  cached = Object.freeze([...parsed.data]) as ConnectorTemplate[];
  return cached;
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
