// Schema normalizer for LLM structured outputs.
//
// Anthropic (and several other providers routed via the AI Gateway) reject
// certain JSON Schema shapes that Zod-to-JSON-Schema emits. This normaliser
// runs before every structured call to:
//   - strip `patternProperties` (not supported)
//   - force `additionalProperties: false` on objects
//   - wrap array-rooted schemas as `{ result: [...] }` (root must be object)
//   - drop min/maxItems on arrays (some providers reject)
//   - backfill empty-object / shape-less schemas (`z.unknown()` emits `{}`,
//     which Anthropic rejects with `Empty schema ({}) that accepts any
//     JSON value is not supported`)
//   - rename `oneOf` → `anyOf` (Anthropic rejects `Schema type 'oneOf' is
//     not supported`; the semantics of `anyOf` are compatible for our use
//     of discriminated unions because the runtime parses tool calls back
//     through Zod, which still enforces discriminator constraints)
//
// Keep this pure — no imports from `ai` or provider packages. The only
// purpose is to shape a schema so downstream `generateObject` calls do not
// fail with `NoObjectGeneratedError` for format reasons.

export interface NormalizedSchema {
  schema: Record<string, unknown>;
  /** True if the root was wrapped into `{ result: ... }`. Callers unwrap. */
  wrappedInResult: boolean;
}

const SHAPE_KEYS = new Set([
  "type",
  "properties",
  "items",
  "oneOf",
  "anyOf",
  "allOf",
  "const",
  "enum",
  "$ref",
  "not",
]);

/** Returns true if a sub-schema lacks any keyword that constrains its
 *  value (`type`, `properties`, `items`, combiners, `enum`, `$ref`).
 *  Such nodes — emitted by `z.unknown()` / `z.any()` — get rejected by
 *  Anthropic with "Empty schema ({}) that accepts any JSON value is not
 *  supported", so we backfill them to an unconstrained string. The
 *  runtime caller re-parses the tool args through the original Zod
 *  schema, which still accepts any string for `z.unknown()`. */
function isShapeless(node: Record<string, unknown>): boolean {
  for (const key of Object.keys(node)) {
    if (SHAPE_KEYS.has(key)) return false;
  }
  return true;
}

function cleanNode(node: unknown, isRoot: boolean): unknown {
  if (!node || typeof node !== "object") return node;
  const n = node as Record<string, unknown>;

  // Empty-object backfill: replace shape-less schemas with a typed
  // placeholder Anthropic accepts. Skipped at the root because the
  // outer caller always supplies a typed object; only sub-schemas
  // emitted by `z.unknown()` / `z.any()` hit this branch.
  if (!isRoot && isShapeless(n)) {
    return { type: "string" };
  }

  // Rename `oneOf` → `anyOf` BEFORE recursing so the combiner-walk
  // below sees a single combiner key per node. We don't merge if both
  // existed — that's a malformed schema upstream that should fail loudly.
  const out: Record<string, unknown> = { ...n };
  if (Array.isArray(out.oneOf)) {
    if (Array.isArray(out.anyOf)) {
      // Defensive: a Zod-generated schema never produces both; if it
      // happens, surface upstream by leaving both fields so the
      // downstream provider error names the schema, not us.
    } else {
      out.anyOf = out.oneOf;
      delete out.oneOf;
    }
  }

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

  // Recurse into anyOf / allOf (oneOf was renamed above).
  for (const combiner of ["anyOf", "allOf"] as const) {
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
