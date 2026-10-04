import { toJsonSchemaCompat } from "@modelcontextprotocol/sdk/server/zod-json-schema-compat.js";
import type { ZodType } from "zod";

function normalizeToNativeShape(node: unknown): void {
  if (Array.isArray(node)) {
    for (const el of node) normalizeToNativeShape(el);
    return;
  }
  if (!node || typeof node !== "object") return;
  const obj = node as Record<string, unknown>;
  delete obj.$schema;
  if ("propertyNames" in obj && "additionalProperties" in obj && obj.type === "object") {
    delete obj.propertyNames;
  }
  for (const v of Object.values(obj)) normalizeToNativeShape(v);
}

export function zodToJsonSchema7(schema: ZodType): Record<string, unknown> {
  const out = toJsonSchemaCompat(schema as never, {
    target: "jsonSchema7",
    pipeStrategy: "output",
  });
  normalizeToNativeShape(out);
  return out;
}
