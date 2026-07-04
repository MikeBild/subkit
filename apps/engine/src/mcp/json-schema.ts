// Zod → JSON Schema (draft-7) at the MCP/LLM tool-palette boundary.
//
// Every place that turns a Zod input schema into the JSON Schema an MCP
// client or the Anthropic tool API consumes funnels through here, so the
// emitted shape stays identical across the whole surface and the single
// unavoidable type bridge to the SDK's zod-compat type lives in one spot.
//
// We use the SDK's `toJsonSchemaCompat` (typed) instead of the previous
// `(z as any).toJSONSchema` cast. Two behaviours of the SDK helper differ
// from the prior native exporter and MUST be reconciled — the Anthropic
// palette shape is a frozen contract (its conformance lint pins
// `additionalProperties:false` and full `required` arrays):
//
//   1. `pipeStrategy: "output"` — the SDK hardcodes `io:'input'` by
//      default, which drops `additionalProperties:false` on plain objects
//      and omits defaulted fields from `required`. Zod's native exporter
//      used `io:'output'` (its default). Routing `pipeStrategy:"output"`
//      restores that.
//   2. `normalizeToNativeShape` — the SDK helper (via zod/v4-mini) emits a
//      top-level `$schema` dialect marker and annotates record key schemas
//      as `propertyNames`. The native exporter emitted neither (it
//      collapsed record keys to a bare `additionalProperties`). We strip
//      both so the byte output matches what shipped before.
//
// Verified byte-identical to the prior native output across all 125
// zod-schema tools in the live registry.

import { toJsonSchemaCompat } from "@modelcontextprotocol/sdk/server/zod-json-schema-compat.js";
import type { ZodType } from "zod";

function normalizeToNativeShape(node: unknown): void {
  if (Array.isArray(node)) {
    for (const el of node) normalizeToNativeShape(el);
    return;
  }
  if (!node || typeof node !== "object") return;
  const obj = node as Record<string, unknown>;
  // Dialect marker the native exporter never emitted.
  delete obj.$schema;
  // Record types: zod/v4-mini annotates the key schema as `propertyNames`.
  // The native exporter collapsed record keys to a bare
  // `additionalProperties`, so strip `propertyNames` whenever it
  // accompanies an `additionalProperties` on an object node — the record
  // signature.
  if ("propertyNames" in obj && "additionalProperties" in obj && obj.type === "object") {
    delete obj.propertyNames;
  }
  for (const v of Object.values(obj)) normalizeToNativeShape(v);
}

/**
 * Convert a Zod schema to a draft-7 JSON Schema with the exact shape the
 * Anthropic tool API and MCP clients expect. The single type bridge here
 * (`as never`) exists because the SDK's `toJsonSchemaCompat` takes its own
 * `zod-compat` `AnyObjectSchema`, which is structurally compatible with
 * subkit's `zod` `ZodType` but is a distinct nominal type. Confining the
 * bridge to this helper removes the `(z as any)` cast from every call site.
 */
export function zodToJsonSchema7(schema: ZodType): Record<string, unknown> {
  const out = toJsonSchemaCompat(schema as never, {
    target: "jsonSchema7",
    pipeStrategy: "output",
  });
  normalizeToNativeShape(out);
  return out;
}
