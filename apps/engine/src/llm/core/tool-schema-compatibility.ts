import { asSchema, type FlexibleSchema } from "ai";

export function supportsToolSchema(schema: Record<string, unknown>): boolean {
  return (
    schema.type === "object" &&
    !["oneOf", "allOf", "anyOf", "$ref"].some((key) => Object.hasOwn(schema, key))
  );
}

export async function compatibleToolPalette<T extends { inputSchema: unknown }>(
  tools: Record<string, T>,
) {
  const compatible: Record<string, T> = {};
  const omitted: string[] = [];
  for (const [name, entry] of Object.entries(tools)) {
    try {
      const schema = await asSchema(entry.inputSchema as FlexibleSchema<unknown>).jsonSchema;
      if (!schema || !supportsToolSchema(schema as Record<string, unknown>)) {
        omitted.push(name);
        continue;
      }
      compatible[name] = entry;
    } catch {
      omitted.push(name);
    }
  }
  return { tools: compatible, omitted };
}
