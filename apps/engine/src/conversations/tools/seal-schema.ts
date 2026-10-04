import type { z } from "@hono/zod-openapi";

interface ObjectLike {
  shape?: Record<string, unknown>;
  strict?: () => z.ZodTypeAny;
}

export function sealSchema(schema: z.ZodTypeAny): z.ZodTypeAny {
  const candidate = schema as unknown as ObjectLike;
  if (
    candidate &&
    typeof candidate.strict === "function" &&
    candidate.shape !== undefined &&
    typeof candidate.shape === "object"
  ) {
    return candidate.strict();
  }
  return schema;
}
