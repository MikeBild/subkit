// Schema normalizer for LLM structured outputs.
//
// Anthropic (and several other providers routed via the AI Gateway) reject
// certain JSON Schema shapes that Zod-to-JSON-Schema emits. This normaliser
// runs before every structured call to:
//   - strip `patternProperties` (not supported)
//   - force `additionalProperties: false` on objects
//   - wrap array-rooted schemas as `{ result: [...] }` (root must be object)
//   - drop min/maxItems on arrays (some providers reject)
//
// Keep this pure — no imports from `ai` or provider packages. The only
// purpose is to shape a schema so downstream `generateObject` calls do not
// fail with `NoObjectGeneratedError` for format reasons.

export interface NormalizedSchema {
  schema: Record<string, unknown>;
  /** True if the root was wrapped into `{ result: ... }`. Callers unwrap. */
  wrappedInResult: boolean;
}

function cleanNode(node: unknown, isRoot: boolean): unknown {
  if (!node || typeof node !== "object") return node;
  const n = node as Record<string, unknown>;
  const out: Record<string, unknown> = { ...n };

  if (out.type === "object" || out.type === "array") {
    out.additionalProperties = false;
    delete out.patternProperties;

    if (out.properties && typeof out.properties === "object") {
      const props = out.properties as Record<string, unknown>;
      const cleanedProps: Record<string, unknown> = {};
      for (const [key, value] of Object.entries(props)) {
        cleanedProps[key] = cleanNode(value, false);
      }
      out.properties = cleanedProps;
    }

    if (out.items) {
      out.items = cleanNode(out.items, false);
      delete out.minItems;
      delete out.maxItems;
    }
  }

  // Recurse into oneOf / anyOf / allOf.
  for (const combiner of ["oneOf", "anyOf", "allOf"] as const) {
    if (Array.isArray(out[combiner])) {
      out[combiner] = (out[combiner] as unknown[]).map((sub) => cleanNode(sub, false));
    }
  }

  if (isRoot && out.type === "array") {
    return {
      type: "object",
      properties: { result: out },
      required: ["result"],
      additionalProperties: false,
    };
  }

  return out;
}

export function normalizeSchema(schema: Record<string, unknown>): NormalizedSchema {
  const cleaned = cleanNode(schema, true) as Record<string, unknown>;
  const wrappedInResult =
    (schema as { type?: unknown }).type === "array" && cleaned.type === "object";
  return { schema: cleaned, wrappedInResult };
}

/** Unwrap `{ result: T }` back to T when the caller knows the wrap happened. */
export function unwrapResult<T>(value: unknown, wrapped: boolean): T {
  if (!wrapped) return value as T;
  if (value && typeof value === "object" && "result" in (value as Record<string, unknown>)) {
    return (value as { result: T }).result;
  }
  return value as T;
}
