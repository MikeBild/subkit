import { describe, expect, it } from "bun:test";
import { type ZodType, z } from "zod";
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
