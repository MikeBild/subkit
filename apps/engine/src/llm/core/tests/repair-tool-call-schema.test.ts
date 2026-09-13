// Repair-loop schema preparation. The repair pass used to feed
// `tool.inputSchema` directly through `jsonSchema(...)`, but the AI
// SDK tools in this repo are registered with Zod schemas — so the
// raw cast produced a JSON Schema without `additionalProperties:
// false`, which Anthropic SDK 6 strict mode rejects with
// `output_config.format.schema: For 'object' type,
// 'additionalProperties' must be explicitly set to false`. The
// healthy `generateObject` path in `ai-sdk-model.ts:264` normalises
// the schema first; the repair path now matches.
//
// These tests pin the Zod→JSON-Schema→normalize pipeline directly so
// the contract cannot regress without flagging it before any LLM call.

import { describe, expect, it } from "bun:test";
import { z, type ZodType } from "zod";

import { zodToJsonSchema7 } from "../../../mcp/json-schema.ts";
import { normalizeSchema } from "../schema-normalizer.ts";

const toJson = (s: unknown) => zodToJsonSchema7(s as ZodType);

describe("repair-tool-call — schema preparation", () => {
  it("seals top-level objects with additionalProperties=false", () => {
    const zodSchema = z.object({
      foo: z.string(),
      bar: z.number().optional(),
    });
    const json = toJson(zodSchema);
    const { schema: normalized } = normalizeSchema(json);
    expect(normalized.additionalProperties).toBe(false);
  });

  it("seals nested objects inside discriminated unions (credential shape)", () => {
    // Mirrors the save_connector_draft credential union — the shape
    // that broke under Anthropic strict mode in trace cli-eff8d7d79d724c56.
    const zodSchema = z.object({
      credential: z
        .discriminatedUnion("mode", [
          z.object({ mode: z.literal("bearer"), token: z.string() }),
          z.object({
            mode: z.literal("oauth2"),
            client_id: z.string(),
            client_secret: z.string().optional(),
          }),
        ])
        .optional(),
    });
    const json = toJson(zodSchema);
    const { schema: normalized } = normalizeSchema(json);
    expect(normalized.additionalProperties).toBe(false);
    // Walk all nested object schemas; every one must seal.
    const stack: unknown[] = [normalized];
    let seen = 0;
    while (stack.length > 0) {
      const node = stack.pop();
      if (!node || typeof node !== "object") continue;
      const obj = node as Record<string, unknown>;
      if (obj.type === "object") {
        expect(obj.additionalProperties).toBe(false);
        seen += 1;
      }
      for (const value of Object.values(obj)) {
        if (Array.isArray(value)) {
          for (const v of value) stack.push(v);
        } else if (value && typeof value === "object") {
          stack.push(value);
        }
      }
    }
    expect(seen).toBeGreaterThan(1);
  });
});
