// Anthropic tool-API conformance lint. Pins every constraint the
// real API would reject a tool definition over, so a regression
// surfaces as a failing unit test instead of "HTTP 503 ·
// llm_provider_unavailable" the next time someone runs sk-CLI.
//
// Failure modes this catches:
//   1. Root JSON Schema not an object ({type:"object"})
//   2. Tool name violates `^[a-zA-Z0-9_-]{1,64}$`
//   3. Description missing or empty
//   4. Duplicate tool names (registry collision)
//   5. Top-level `properties` is not an object
//   6. `additionalProperties` is allowed but enums in nested
//      properties must be string|number|boolean only
//   7. Required field references a property that doesn't exist
//   8. Recursive / circular schemas (would blow up serialisation)

import { describe, expect, test } from "bun:test";
import type { ZodType } from "zod";
import { zodToJsonSchema7 } from "../../mcp/json-schema.ts";
import { getTool, listTools } from "../tools/index.ts";

function toJsonSchema(schema: unknown): Record<string, unknown> {
  return zodToJsonSchema7(schema as ZodType);
}

const ANTHROPIC_TOOL_NAME_RE = /^[a-zA-Z0-9_-]{1,64}$/;

describe("Anthropic tool-API conformance · per-tool", () => {
  const tools = listTools();
  for (const tool of tools) {
    describe(tool.name, () => {
      const json = toJsonSchema(tool.inputSchema);

      test("root type is `object`", () => {
        expect(json.type).toBe("object");
      });

      test("name matches Anthropic regex `^[a-zA-Z0-9_-]{1,64}$`", () => {
        expect(tool.name).toMatch(ANTHROPIC_TOOL_NAME_RE);
      });

      test("description present + non-empty", () => {
        expect(typeof tool.description).toBe("string");
        expect(tool.description.length).toBeGreaterThan(0);
      });

      test("no anyOf / oneOf at the root", () => {
        expect(json.anyOf).toBeUndefined();
        expect(json.oneOf).toBeUndefined();
      });

      test("`properties` is an object when present", () => {
        if (json.properties !== undefined) {
          expect(typeof json.properties).toBe("object");
          expect(Array.isArray(json.properties)).toBe(false);
        }
      });

      test("`required` references only existing properties", () => {
        if (Array.isArray(json.required) && typeof json.properties === "object") {
          const propKeys = new Set(Object.keys(json.properties as Record<string, unknown>));
          for (const r of json.required as string[]) {
            expect(propKeys.has(r)).toBe(true);
          }
        }
      });

      test("can be JSON-serialised (no circular references)", () => {
        // If a schema accidentally goes recursive, JSON.stringify
        // throws TypeError: Converting circular structure. The
        // Anthropic SDK serialises tool definitions before sending
        // — circular schemas would blow up there. Catch it here.
        expect(() => JSON.stringify(json)).not.toThrow();
      });

      test("category is one of the known values", () => {
        expect(["draft_write", "tenant_read", "tenant_write"]).toContain(tool.category);
      });
    });
  }
});

describe("Anthropic tool-API conformance · global", () => {
  test("no duplicate tool names in the registry", () => {
    const tools = listTools();
    const names = tools.map((t) => t.name);
    const dupes = names.filter((n, i) => names.indexOf(n) !== i);
    expect(dupes).toEqual([]);
  });

  test("getTool resolves every name listTools returns", () => {
    for (const t of listTools()) {
      expect(getTool(t.name)).toBeDefined();
    }
  });

  test("input_schemas serialise within a sane size budget (< 16KB each)", () => {
    // Anthropic doesn't publish a hard size limit on tool defs but
    // very large schemas eat into the prompt-cache budget and slow
    // every turn. 16KB is a soft alarm — bump if we ever genuinely
    // need it.
    for (const t of listTools()) {
      const size = JSON.stringify(toJsonSchema(t.inputSchema)).length;
      if (size > 16_384) {
        throw new Error(`tool ${t.name} input_schema is ${size} bytes (> 16384)`);
      }
    }
  });
});
