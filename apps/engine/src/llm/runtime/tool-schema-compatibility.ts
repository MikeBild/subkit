import { stripPropertyNames } from "@shared/json-schema.ts";
import { asSchema, type FlexibleSchema, type JSONSchema7, jsonSchema } from "ai";

const SELF_DESCRIBING_FORMATS = new Set([
  "uuid",
  "date-time",
  "date",
  "time",
  "email",
  "ipv4",
  "ipv6",
]);

export function supportsToolSchema(schema: Record<string, unknown>): boolean {
  return (
    schema.type === "object" &&
    !["oneOf", "allOf", "anyOf", "$ref"].some((key) => Object.hasOwn(schema, key))
  );
}

export function compactToolJsonSchema(node: unknown): unknown {
  if (Array.isArray(node)) return node.map(compactToolJsonSchema);
  if (!node || typeof node !== "object") return node;
  const source = node as Record<string, unknown>;
  const formatted = typeof source.format === "string" && SELF_DESCRIBING_FORMATS.has(source.format);
  const out: Record<string, unknown> = {};
  for (const [key, value] of Object.entries(source)) {
    if (key === "$schema") continue;
    if (key === "pattern" && formatted) continue;
    if (key === "maximum" && value === Number.MAX_SAFE_INTEGER) continue;
    if (key === "minimum" && value === Number.MIN_SAFE_INTEGER) continue;
    out[key] = compactToolJsonSchema(value);
  }
  return out;
}

export async function compatibleToolPalette<T extends { inputSchema: unknown }>(
  tools: Record<string, T>,
) {
  const compatible: Record<string, T> = {};
  const omitted: string[] = [];
  for (const [name, entry] of Object.entries(tools)) {
    try {
      const original = asSchema(entry.inputSchema as FlexibleSchema<unknown>);
      const schema = await original.jsonSchema;
      if (!schema || !supportsToolSchema(schema as Record<string, unknown>)) {
        omitted.push(name);
        continue;
      }
      compatible[name] = {
        ...entry,
        inputSchema: jsonSchema(
          stripPropertyNames(compactToolJsonSchema(schema)) as JSONSchema7,
          original.validate ? { validate: original.validate } : {},
        ),
      };
    } catch {
      omitted.push(name);
    }
  }
  return { tools: compatible, omitted };
}
