import { describe, expect, it } from "bun:test";
import type { z } from "zod";
import { listTools } from "./index.ts";

interface ZodNode {
  readonly _zod?: { readonly def?: ZodDef };
}
type ZodDef = { readonly type?: string } & Record<string, unknown>;

function defOf(schema: unknown): ZodDef | undefined {
  return (schema as ZodNode | null)?._zod?.def;
}

function isNode(value: unknown): boolean {
  return defOf(value) !== undefined;
}

function childrenOf(def: ZodDef): unknown[] {
  const out: unknown[] = [];
  const push = (v: unknown) => {
    if (isNode(v)) out.push(v);
  };
  const pushAll = (v: unknown) => {
    if (Array.isArray(v)) for (const item of v) push(item);
  };

  push(def.innerType);
  push(def.element);
  push(def.left);
  push(def.right);
  push(def.keyType);
  push(def.valueType);
  push(def.in);
  push(def.out);
  push(def.rest);
  pushAll(def.options);
  pushAll(def.items);

  const shape = def.shape;
  if (shape && typeof shape === "object") {
    for (const v of Object.values(shape as Record<string, unknown>)) push(v);
  }
  if (def.type === "lazy" && typeof def.getter === "function") {
    push((def.getter as () => unknown)());
  }
  return out;
}

function transformPaths(schema: unknown): string[] {
  const found: string[] = [];
  const seen = new Set<unknown>();

  const walk = (node: unknown, path: string): void => {
    if (!isNode(node) || seen.has(node)) return;
    seen.add(node);
    const def = defOf(node);
    if (!def) return;
    if (def.type === "transform") {
      found.push(path || "<root>");
      return;
    }
    const shape = def.shape;
    const keys =
      shape && typeof shape === "object"
        ? new Set(Object.keys(shape as object))
        : new Set<string>();
    for (const child of childrenOf(def)) {
      let childPath = path;
      if (keys.size > 0) {
        for (const k of keys) {
          if ((shape as Record<string, unknown>)[k] === child) {
            childPath = path ? `${path}.${k}` : k;
            break;
          }
        }
      }
      walk(child, childPath);
    }
  };

  walk(schema, "");
  return found;
}

const TRANSFORM_FIXTURES: Readonly<Record<string, readonly unknown[]>> = {
  run_workflow: [
    { workflow: "daily-report" },
    { workflow: "daily-report", input: { city: "Berlin" } },
    { workflow: "daily-report", input: '{"city":"Berlin"}' },
    { workflow: "daily-report", input: "" },
  ],
  save_connector_draft: [
    {},
    { credential: { mode: "bearer", token: "t" } },
    { credential: '{"mode":"bearer","token":"t"}' },
  ],
};

const tools = listTools();

describe("registry inputSchema parse-idempotence", () => {
  it("registry is non-empty", () => {
    expect(tools.length).toBeGreaterThan(50);
  });

  it("only tools with a declared fixture carry a schema transform", () => {
    const transforming = tools
      .filter((t) => transformPaths(t.inputSchema).length > 0)
      .map((t) => t.name)
      .sort();
    expect(transforming).toEqual(Object.keys(TRANSFORM_FIXTURES).sort());
  });

  it("no fixture outlives the transform it covers", () => {
    for (const name of Object.keys(TRANSFORM_FIXTURES)) {
      const tool = tools.find((t) => t.name === name);
      expect(tool).toBeDefined();
      expect(
        transformPaths((tool as { inputSchema: z.ZodTypeAny }).inputSchema).length,
      ).toBeGreaterThan(0);
    }
  });

  for (const [name, inputs] of Object.entries(TRANSFORM_FIXTURES)) {
    it(`${name}: parse(parse(x)) deep-equals parse(x)`, () => {
      const tool = tools.find((t) => t.name === name);
      if (!tool) throw new Error(`unknown tool in TRANSFORM_FIXTURES: ${name}`);
      for (const raw of inputs) {
        const once = tool.inputSchema.parse(raw);
        const twice = tool.inputSchema.parse(once);
        expect(twice).toEqual(once);
      }
    });
  }

  const withExample = tools.filter((t) => t.example_input !== undefined);

  it("every declared example_input parses", () => {
    expect(withExample.length).toBeGreaterThan(0);
    for (const tool of withExample) {
      const parsed = tool.inputSchema.safeParse(tool.example_input);
      if (!parsed.success) {
        throw new Error(
          `${tool.name}.example_input does not satisfy its own inputSchema: ${parsed.error.issues
            .map((i) => `${i.path.join(".")}: ${i.message}`)
            .join("; ")}`,
        );
      }
    }
  });

  for (const tool of withExample) {
    it(`${tool.name}: example_input round-trips unchanged`, () => {
      const once = tool.inputSchema.parse(tool.example_input);
      const twice = tool.inputSchema.parse(once);
      expect(twice).toEqual(once);
    });
  }
});
