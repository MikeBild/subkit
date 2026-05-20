// Cross-surface contract for `POST /v1/extract`.
//
// `/v1/extract` is hand-registered via `app.post(...)` (not
// `app.openapi(...)`) because the *request* body is polymorphic — it
// dispatches on `Content-Type` to one of ~10 format-specific parsers.
// The OpenAPI generator can only describe one body schema per route
// path, so the request side stays out of the generated spec on
// purpose. See the doc-comment at the top of
// `apps/engine/src/http/routes/ai/extract.ts` for the rationale.
//
// The *response* side, however, is well-typed per format. Exporting
// the discriminated union from `api/` so the engine-client and any
// external consumer can import the response shape directly even
// though it's not reachable through `openapi.json`.

import { z } from "@hono/zod-openapi";

export const ExtractFileResponseSchema = z.discriminatedUnion("format", [
  z.object({ format: z.literal("json"), bytes: z.number(), data: z.unknown() }),
  z.object({ format: z.literal("yaml"), bytes: z.number(), data: z.unknown() }),
  z.object({
    format: z.literal("csv"),
    bytes: z.number(),
    data: z.array(z.record(z.string(), z.string())),
  }),
  z.object({ format: z.literal("xml"), bytes: z.number(), data: z.unknown() }),
  z.object({ format: z.literal("plaintext"), bytes: z.number(), data: z.string() }),
  z.object({
    format: z.literal("pdf"),
    bytes: z.number(),
    pages: z.number(),
    data: z.object({ text: z.string() }),
  }),
  z.object({
    format: z.literal("docx"),
    bytes: z.number(),
    data: z.object({ markdown: z.string() }),
  }),
  z.object({
    format: z.literal("xlsx"),
    bytes: z.number(),
    data: z.object({ sheets: z.record(z.string(), z.array(z.record(z.string(), z.unknown()))) }),
  }),
  z.object({
    format: z.literal("xls"),
    bytes: z.number(),
    data: z.object({ sheets: z.record(z.string(), z.array(z.record(z.string(), z.unknown()))) }),
  }),
  z.object({
    format: z.literal("pptx"),
    bytes: z.number(),
    data: z.object({
      slides: z.array(z.object({ index: z.number(), text: z.string() })),
    }),
  }),
]);

export type ExtractFileResponse = z.infer<typeof ExtractFileResponseSchema>;
