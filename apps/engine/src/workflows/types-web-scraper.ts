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

export const TRANSFORM_LANGUAGES_NEEDING_EXPRESSION = new Set(["javascript"]);

export const TRANSFORM_LANGUAGES_FORBIDDING_EXPRESSION = new Set([
  "readability",
  "html-to-markdown",
  "structured-data",
]);
