import { toJsonSchemaCompat } from "@modelcontextprotocol/sdk/server/zod-json-schema-compat.js";
import { stripPropertyNames } from "@shared/json-schema.ts";
import type { ZodType } from "zod";

function dropSchemaDialect(node: unknown): void {
  if (Array.isArray(node)) {
    for (const el of node) dropSchemaDialect(el);
    return;
  }
  if (!node || typeof node !== "object") return;
  const obj = node as Record<string, unknown>;
  delete obj.$schema;
  for (const v of Object.values(obj)) dropSchemaDialect(v);
}

export function zodToJsonSchema7(schema: ZodType): Record<string, unknown> {
  const out = toJsonSchemaCompat(schema as never, {
    target: "jsonSchema7",
    pipeStrategy: "output",
  });
  dropSchemaDialect(out);
  return stripPropertyNames(out) as Record<string, unknown>;
}
