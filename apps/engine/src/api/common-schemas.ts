import { z } from "@hono/zod-openapi";

export const ErrorSchema = z
  .object({
    code: z.string(),
    message: z.string(),
    hint: z.string().optional(),
    retry_after: z.number().optional(),
    trace_id: z.string().optional(),
    details: z.record(z.string(), z.any()).optional(),
  })
  .openapi("Error");

export const PaginationQuery = z.object({
  limit: z.coerce.number().int().positive().max(200).optional(),
  offset: z.coerce.number().int().nonnegative().optional(),
});

export const IdParam = z.object({
  id: z
    .string()
    .uuid()
    .openapi({ param: { name: "id", in: "path" } }),
});

export function paginatedResponse<Z extends z.ZodTypeAny>(
  item: Z,
  name: string,
): z.ZodObject<{
  items: z.ZodArray<Z>;
  next_cursor: z.ZodOptional<z.ZodNullable<z.ZodString>>;
}> {
  return z
    .object({
      items: z.array(item),
      next_cursor: z.string().nullable().optional(),
    })
    .openapi(name);
}
