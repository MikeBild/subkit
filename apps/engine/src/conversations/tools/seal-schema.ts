// sealSchema — registration-time pass over every conversation-tool
// input schema.
//
// Goal: tighten the contract the LLM sees so it cannot emit a tool
// call with fields the schema doesn't permit. Concretely:
//   - ZodObject schemas become `.strict()` (extra keys rejected).
//   - Non-object schemas pass through unchanged (currently no
//     conversation tool uses one at the top level; the helper is
//     defensive against future additions).
//
// Applied centrally in `tools/index.ts` so every tool benefits with
// no per-tool change. Tools that legitimately need a loose payload
// (none today) can opt out by setting `sealed: false` on the
// ConversationTool before registration.

import type { z } from "@hono/zod-openapi";

interface ObjectLike {
  shape?: Record<string, unknown>;
  strict?: () => z.ZodTypeAny;
}

/**
 * Return a sealed copy of the schema. For ZodObject this is
 * `.strict()`; for anything else this is the input unchanged.
 *
 * Detection uses two ZodObject hallmarks (`.shape` map + `.strict`
 * method) rather than `_def.typeName`, because the bundled Zod
 * variant in `@hono/zod-openapi` does not always set typeName.
 *
 * Idempotent — sealing an already-strict schema is a no-op (Zod's
 * `.strict()` toggles a flag).
 */
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
