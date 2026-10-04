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
