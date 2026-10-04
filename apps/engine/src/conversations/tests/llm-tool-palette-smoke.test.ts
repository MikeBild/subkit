import { describe, expect, test } from "bun:test";
import type { ZodType } from "zod";
import { zodToJsonSchema7 } from "../../mcp/json-schema.ts";
import { listTools } from "../tools/index.ts";

interface AnthropicToolDef {
  name: string;
  description: string;
  input_schema: {
    type: "object";
    properties?: Record<string, unknown>;
    required?: string[];
    additionalProperties?: unknown;
    $ref?: unknown;
    definitions?: unknown;
    $defs?: unknown;
  };
}

function buildAnthropicToolDef(tool: ReturnType<typeof listTools>[number]): AnthropicToolDef {
  const json = zodToJsonSchema7(tool.inputSchema as ZodType) as AnthropicToolDef["input_schema"];
  return {
    name: tool.name,
    description: tool.description,
    input_schema: json,
  };
}

describe("llm tool palette · Anthropic provider shape", () => {
  const tools = listTools();
  const defs = tools.map(buildAnthropicToolDef);

  test("every tool has a top-level `name` (string, non-empty)", () => {
    for (const d of defs) {
      expect(typeof d.name).toBe("string");
      expect(d.name.length).toBeGreaterThan(0);
    }
  });

  test("every tool has a top-level `description` (string, non-empty)", () => {
    for (const d of defs) {
      expect(typeof d.description).toBe("string");
      expect(d.description.length).toBeGreaterThan(0);
    }
  });

  test("every tool has `input_schema.type === 'object'` (Anthropic requirement)", () => {
    for (const d of defs) {
      if (d.input_schema?.type !== "object") {
        throw new Error(
          `tool ${d.name} input_schema.type is ${JSON.stringify(d.input_schema?.type)} — must be "object"`,
        );
      }
    }
  });

  test("no tool emits a $ref / $defs / definitions at the root (Anthropic doesn't deref)", () => {
    for (const d of defs) {
      if (d.input_schema.$ref !== undefined) {
        throw new Error(`tool ${d.name} input_schema has $ref at root`);
      }
      if (d.input_schema.$defs !== undefined) {
        throw new Error(`tool ${d.name} input_schema has $defs at root`);
      }
      if (d.input_schema.definitions !== undefined) {
        throw new Error(`tool ${d.name} input_schema has definitions at root`);
      }
    }
  });

  test("`required` is always a string array referencing real properties", () => {
    for (const d of defs) {
      const req = d.input_schema.required;
      if (req === undefined) continue;
      expect(Array.isArray(req)).toBe(true);
      const props = (d.input_schema.properties ?? {}) as Record<string, unknown>;
      const propKeys = new Set(Object.keys(props));
      for (const r of req) {
        expect(typeof r).toBe("string");
        if (!propKeys.has(r)) {
          throw new Error(
            `tool ${d.name} required[${r}] is not a property — keys=${[...propKeys].join(",")}`,
          );
        }
      }
    }
  });

  test("entire tool palette JSON.stringify round-trips", () => {
    const serialised = JSON.stringify(defs);
    expect(serialised.length).toBeGreaterThan(0);
    const parsed = JSON.parse(serialised);
    expect(Array.isArray(parsed)).toBe(true);
    expect(parsed.length).toBe(defs.length);
  });

  test("number of tools is in a plausible range", () => {
    expect(defs.length).toBeGreaterThan(80);
    expect(defs.length).toBeLessThan(200);
  });

  test("tool names are unique (registry collision detector)", () => {
    const seen = new Set<string>();
    const dupes: string[] = [];
    for (const d of defs) {
      if (seen.has(d.name)) dupes.push(d.name);
      seen.add(d.name);
    }
    expect(dupes).toEqual([]);
  });
});
