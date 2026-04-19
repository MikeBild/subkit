// Infer a minimal JSON Schema (draft-07 compatible) from a sample value.
//
// Used by `build_workflow` so the LLM can hand the operator "here is a
// sample payload — derive the input_schema" instead of writing JSON
// Schema by hand. The inference is deliberately simple:
//
//   - null / undefined  →  {}  (permissive)
//   - string / number / boolean / bigint → { type: "<prim>" }
//   - arrays: { type: "array", items: <merge of all element schemas> }
//     * mixed element types produce `{ oneOf: [...] }` after de-dup
//   - objects: { type: "object", properties: {...}, required: [keys] }
//     * every observed key is `required` in the inferred schema
//
// This produces tight schemas from concrete samples. Authors who want
// looser schemas should edit the result rather than expect sample-
// driven looseness.

export type JsonSchema7 = Record<string, unknown>;

export function sampleToSchema(sample: unknown): JsonSchema7 {
  if (sample === null || sample === undefined) return {};
  const t = typeof sample;
  if (t === "string") return { type: "string" };
  if (t === "number") return { type: "number" };
  if (t === "boolean") return { type: "boolean" };
  if (t === "bigint") return { type: "integer" };
  if (Array.isArray(sample)) {
    if (sample.length === 0) return { type: "array", items: {} };
    const itemSchemas = sample.map((v) => sampleToSchema(v));
    const merged = mergeSchemas(itemSchemas);
    return { type: "array", items: merged };
  }
  if (t === "object") {
    const obj = sample as Record<string, unknown>;
    const keys = Object.keys(obj);
    const properties: Record<string, JsonSchema7> = {};
    for (const k of keys) {
      properties[k] = sampleToSchema(obj[k]);
    }
    // Objects with no keys: `{ type: "object" }` — the schema matches
    // any object (including non-empty). Callers can tighten later.
    if (keys.length === 0) return { type: "object" };
    return {
      type: "object",
      properties,
      required: keys,
    };
  }
  return {};
}

/** Merge N schemas that all describe array items into one schema. Equal
 *  schemas collapse; mixed primitives become `oneOf`. */
function mergeSchemas(list: JsonSchema7[]): JsonSchema7 {
  if (list.length === 0) return {};
  // De-dup by JSON-canonical form.
  const seen = new Map<string, JsonSchema7>();
  for (const s of list) {
    const key = canonical(s);
    if (!seen.has(key)) seen.set(key, s);
  }
  const unique = [...seen.values()];
  if (unique.length === 1) return unique[0]!;
  // Multiple shapes — preserve all via oneOf. If they are all objects,
  // we do an additional shallow "union properties" pass so the schema
  // captures every observed key.
  if (unique.every((s) => s.type === "object")) {
    return unionObjectSchemas(unique);
  }
  return { oneOf: unique };
}

function unionObjectSchemas(list: JsonSchema7[]): JsonSchema7 {
  const properties: Record<string, JsonSchema7> = {};
  const requiredCounts = new Map<string, number>();
  for (const s of list) {
    const props = (s.properties ?? {}) as Record<string, JsonSchema7>;
    for (const [k, v] of Object.entries(props)) {
      // If the same key exists with different shapes across list items,
      // recurse through mergeSchemas so nested objects union properly.
      if (properties[k] === undefined) {
        properties[k] = v;
      } else {
        properties[k] = mergeSchemas([properties[k], v]);
      }
    }
    const required = Array.isArray(s.required) ? (s.required as string[]) : [];
    for (const k of required) {
      requiredCounts.set(k, (requiredCounts.get(k) ?? 0) + 1);
    }
  }
  // Keep a key required only if ALL items had it. Anything less and the
  // union schema must treat it as optional.
  const required = [...requiredCounts.entries()]
    .filter(([, c]) => c === list.length)
    .map(([k]) => k);
  const out: JsonSchema7 = { type: "object", properties };
  if (required.length > 0) out.required = required;
  return out;
}

/** Canonical JSON (sorted keys) for use as a dedup key. */
function canonical(value: unknown): string {
  if (value === null || typeof value !== "object") return JSON.stringify(value);
  if (Array.isArray(value)) return `[${value.map(canonical).join(",")}]`;
  const obj = value as Record<string, unknown>;
  const keys = Object.keys(obj).sort();
  const parts = keys.map((k) => `${JSON.stringify(k)}:${canonical(obj[k])}`);
  return `{${parts.join(",")}}`;
}
