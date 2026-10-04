import { describe, expect, test } from "bun:test";
import type { ZodType } from "zod";
import { zodToJsonSchema7 } from "../../mcp/json-schema.ts";
import { listTools } from "../tools/index.ts";

function toJsonSchema(schema: unknown): Record<string, unknown> {
  return zodToJsonSchema7(schema as ZodType);
}

describe("conversation tools — input schema shape", () => {
  const tools = listTools();
  for (const tool of tools) {
    test(`${tool.name} → input_schema.type === "object"`, () => {
      const json = toJsonSchema(tool.inputSchema);
      expect(json.type).toBe("object");
      expect(json.anyOf).toBeUndefined();
      expect(json.oneOf).toBeUndefined();
    });
  }
});
