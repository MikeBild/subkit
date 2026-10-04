import { describe, expect, it } from "bun:test";
import type { ZodType } from "zod";
import { getTool, listTools } from "../conversations/tools/index.ts";
import { zodToJsonSchema7 } from "./json-schema.ts";

function schema(toolName: string): Record<string, unknown> {
  const tool = getTool(toolName);
  if (!tool) throw new Error(`tool not registered: ${toolName}`);
  return zodToJsonSchema7(tool.inputSchema as ZodType);
}

describe("sdk helper — global palette invariants", () => {
  const tools = listTools();

  it("no tool emits a top-level $schema dialect marker (WS2 fix #2)", () => {
    for (const t of tools) {
      const s = zodToJsonSchema7(t.inputSchema as ZodType);
      if ("$schema" in s) {
        throw new Error(`tool ${t.name} emitted a $schema key — normalizeToNativeShape missed it`);
      }
    }
  });

  it("every tool root has additionalProperties:false (WS2 fix #1 — pipeStrategy:output)", () => {
    for (const t of tools) {
      const s = zodToJsonSchema7(t.inputSchema as ZodType);
      if (s.additionalProperties !== false) {
        throw new Error(
          `tool ${t.name} root additionalProperties=${JSON.stringify(s.additionalProperties)} — expected false`,
        );
      }
    }
  });

  it("no tool emits $ref / $defs / definitions at the root (Anthropic does not deref)", () => {
    for (const t of tools) {
      const s = zodToJsonSchema7(t.inputSchema as ZodType);
      if ("$ref" in s) throw new Error(`tool ${t.name} root has $ref`);
      if ("$defs" in s) throw new Error(`tool ${t.name} root has $defs`);
      if ("definitions" in s) throw new Error(`tool ${t.name} root has definitions`);
    }
  });

  it("every tool root type is 'object'", () => {
    for (const t of tools) {
      const s = zodToJsonSchema7(t.inputSchema as ZodType);
      if (s.type !== "object") {
        throw new Error(`tool ${t.name} root type=${JSON.stringify(s.type)} — expected 'object'`);
      }
    }
  });
});

describe("sdk helper parity — cannot_help (flat object)", () => {
  it("emits the expected frozen shape", () => {
    const s = schema("cannot_help");

    expect(s.type).toBe("object");
    expect(s.additionalProperties).toBe(false);
    expect(s.required).toEqual(["reason"]);

    expect(s.$schema).toBeUndefined();
    expect(s.$ref).toBeUndefined();
    expect(s.$defs).toBeUndefined();

    const props = s.properties as Record<string, Record<string, unknown>>;
    expect(typeof props).toBe("object");
    expect(props.reason?.type).toBe("string");
    expect(props.missing_capability?.type).toBe("string");
    expect(props.suggest_alternative?.type).toBe("string");

    const req = s.required as string[];
    expect(req).not.toContain("missing_capability");
    expect(req).not.toContain("suggest_alternative");
  });
});

describe("sdk helper parity — find_workflow (defaulted field in required)", () => {
  it("limit with .default(15) is still present in required (pipeStrategy:output)", () => {
    const s = schema("find_workflow");

    expect(s.type).toBe("object");
    expect(s.additionalProperties).toBe(false);

    expect(s.required).toContain("limit");

    const req = s.required as string[];
    expect(req).not.toContain("query");
    expect(req).not.toContain("id");

    const props = s.properties as Record<string, Record<string, unknown>>;
    expect(props.limit?.type).toBe("integer");
    expect(typeof props.limit?.minimum).toBe("number");
    expect(typeof props.limit?.maximum).toBe("number");
  });
});

describe("sdk helper parity — run_workflow (input map + inherited environment)", () => {
  it("input is no longer the empty schema `{}`", () => {
    const s = schema("run_workflow");
    const props = s.properties as Record<string, Record<string, unknown>>;
    const input = props.input;
    expect(input).toBeDefined();
    expect(Object.keys(input ?? {}).length).toBeGreaterThan(0);
    expect(input).not.toEqual({});
  });

  it("environment stays optional so the saved schedule selects the runtime environment", () => {
    const s = schema("run_workflow");
    expect(s.required ?? []).not.toContain("environment");
    const props = s.properties as Record<string, Record<string, unknown>>;
    expect(props.environment?.enum).toEqual(["dev", "prod"]);
    expect(props.environment?.default).toBeUndefined();
  });

  it("root seals with additionalProperties:false and no $ref/$defs", () => {
    const s = schema("run_workflow");
    expect(s.type).toBe("object");
    expect(s.additionalProperties).toBe(false);
    expect(s.$ref).toBeUndefined();
    expect(s.$defs).toBeUndefined();
  });
});

describe("sdk helper parity — edit_workflow_patch (discriminated union)", () => {
  it("root is type:object, patches is type:array", () => {
    const s = schema("edit_workflow_patch");
    expect(s.type).toBe("object");
    expect(s.additionalProperties).toBe(false);
    const props = s.properties as Record<string, Record<string, unknown>>;
    expect(props.patches?.type).toBe("array");
  });

  it("no $ref / $defs in the discriminated union output", () => {
    const s = schema("edit_workflow_patch");
    expect(s.$ref).toBeUndefined();
    expect(s.$defs).toBeUndefined();
    expect(s.definitions).toBeUndefined();
  });

  it("every oneOf branch inside patches.items seals with additionalProperties:false", () => {
    const s = schema("edit_workflow_patch");
    const props = s.properties as Record<string, { items?: { oneOf?: unknown[] } }>;
    const branches = props.patches?.items?.oneOf;
    expect(Array.isArray(branches)).toBe(true);
    expect((branches as unknown[]).length).toBeGreaterThan(0);
    for (const branch of branches as Record<string, unknown>[]) {
      expect(branch.type).toBe("object");
      expect(branch.additionalProperties).toBe(false);
    }
  });
});
