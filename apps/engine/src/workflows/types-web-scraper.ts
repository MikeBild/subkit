// Web-scraper transform languages (#144) — schema sidecar for `types.ts`.
//
// Lives in its own file so `types.ts` stays under the 1000-LOC audit
// ceiling. `types.ts` imports the three config + three output Zod
// schemas from here and re-exports the output envelopes for downstream
// consumers (executor, chat tools, OpenAPI generation).
//
// Each transform operates on the upstream step's HTML body (passed
// through `input`) and returns a typed JSON envelope — no `expression`
// is consumed; per-language config arrives via the matching nested
// block on `TransformStep` (declared in `types.ts`).

import { z } from "@hono/zod-openapi";

export const ReadabilityConfigSchema = z
  .object({
    max_chars: z.number().int().positive().max(2_000_000).optional(),
    length_guard: z.number().int().positive().max(2_000_000).optional(),
  })
  .openapi("ReadabilityConfig");

export const MarkdownConfigSchema = z
  .object({
    max_chars: z.number().int().positive().max(2_000_000).optional(),
    preserve_links: z.boolean().optional(),
    strip_tags: z.array(z.string().min(1)).optional(),
    truncate: z.boolean().optional(),
  })
  .openapi("MarkdownConfig");

export const StructuredDataConfigSchema = z
  .object({
    types: z
      .array(z.enum(["json-ld", "opengraph", "microdata"]))
      .min(1)
      .optional(),
  })
  .openapi("StructuredDataConfig");

// Typed JSON envelopes returned by the three transform languages.
// Exposed in OpenAPI so downstream tooling (chat, dashboards, the
// authoring gate) can address fields by name with confidence.

export const ReadabilityOutputSchema = z
  .object({
    title: z.string().nullable(),
    byline: z.string().nullable(),
    excerpt: z.string().nullable(),
    lang: z.string().nullable(),
    site_name: z.string().nullable(),
    published_at: z.string().nullable(),
    content_html: z.string(),
    length: z.number().int().nonnegative(),
    url: z.string(),
  })
  .openapi("ReadabilityOutput");

export const MarkdownOutputSchema = z
  .object({
    markdown: z.string(),
    bytes: z.number().int().nonnegative(),
    url: z.string(),
    truncated: z.boolean(),
    stripped_elements: z.array(z.string()),
  })
  .openapi("MarkdownOutput");

export const StructuredDataOutputSchema = z
  .object({
    json_ld: z.array(z.record(z.string(), z.unknown())),
    opengraph: z.record(z.string(), z.string()),
    microdata: z.array(z.record(z.string(), z.unknown())),
    url: z.string(),
    found_any: z.boolean(),
  })
  .openapi("StructuredDataOutput");

export type ReadabilityOutput = z.infer<typeof ReadabilityOutputSchema>;
export type MarkdownOutput = z.infer<typeof MarkdownOutputSchema>;
export type StructuredDataOutput = z.infer<typeof StructuredDataOutputSchema>;

/** Languages on `TransformStep.language` that require a non-empty
 *  `expression`. Transforms are JavaScript-only; JSONata survives only in
 *  the one-line slots (`data_selector`, `branch.when`, `output_transform`,
 *  `${...}` interpolation). Used by the superRefine in `types.ts`. */
export const TRANSFORM_LANGUAGES_NEEDING_EXPRESSION = new Set(["javascript"]);

/** Languages on `TransformStep.language` that forbid an `expression`
 *  field (the per-language config object is the carrier). */
export const TRANSFORM_LANGUAGES_FORBIDDING_EXPRESSION = new Set([
  "readability",
  "html-to-markdown",
  "structured-data",
]);
