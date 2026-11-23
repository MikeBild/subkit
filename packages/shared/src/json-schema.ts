const SCHEMA_MAP_KEYS = new Set(["properties", "patternProperties", "$defs", "definitions"]);
const SCHEMA_DATA_KEYS = new Set(["const", "enum", "default", "examples"]);

export function stripPropertyNames(node: unknown): unknown {
  if (Array.isArray(node)) return node.map(stripPropertyNames);
  if (!node || typeof node !== "object") return node;
  const out: Record<string, unknown> = {};
  for (const [key, value] of Object.entries(node as Record<string, unknown>)) {
    if (key === "propertyNames") continue;
    if (SCHEMA_DATA_KEYS.has(key)) {
      out[key] = value;
      continue;
    }
    if (SCHEMA_MAP_KEYS.has(key) && value && typeof value === "object" && !Array.isArray(value)) {
      out[key] = Object.fromEntries(
        Object.entries(value as Record<string, unknown>).map(([name, sub]) => [
          name,
          stripPropertyNames(sub),
        ]),
      );
      continue;
    }
    out[key] = stripPropertyNames(value);
  }
  return out;
}
