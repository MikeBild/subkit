type JsonSchema7 = Record<string, unknown>;

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
    if (keys.length === 0) return { type: "object" };
    return {
      type: "object",
      properties,
      required: keys,
    };
  }
  return {};
}

function mergeSchemas(list: JsonSchema7[]): JsonSchema7 {
  if (list.length === 0) return {};
  const seen = new Map<string, JsonSchema7>();
  for (const s of list) {
    const key = canonical(s);
    if (!seen.has(key)) seen.set(key, s);
  }
  const unique = [...seen.values()];
  if (unique.length === 1) return unique[0]!;
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
  const required = [...requiredCounts.entries()]
    .filter(([, c]) => c === list.length)
    .map(([k]) => k);
  const out: JsonSchema7 = { type: "object", properties };
  if (required.length > 0) out.required = required;
  return out;
}

function canonical(value: unknown): string {
  if (value === null || typeof value !== "object") return JSON.stringify(value);
  if (Array.isArray(value)) return `[${value.map(canonical).join(",")}]`;
  const obj = value as Record<string, unknown>;
  const keys = Object.keys(obj).sort();
  const parts = keys.map((k) => `${JSON.stringify(k)}:${canonical(obj[k])}`);
  return `{${parts.join(",")}}`;
}
