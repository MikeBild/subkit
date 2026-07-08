// Parse-idempotence is a SECURITY invariant, not a style rule.
//
// `tools/dispatcher.ts#canonicalizeArgs` parses an invocation through the
// tool's `inputSchema`, and `tools/approval.ts#requestApproval` persists that
// OUTPUT as the payload the operator approves. The approved replay hands the
// stored value back to the executor, which — on every path that is reachable
// outside the dispatcher (`conversations/direct-invoke.ts`, the connector
// import route, the AI SDK's own tool boundary) — parses it again.
//
// So the canonical value passes through the schema at least twice. That is
// only safe while `parse(parse(x))` deep-equals `parse(x)`. A schema transform
// is not required to be idempotent: the first one that is not would silently
// rewrite a payload after the operator approved it.
//
// Validation, defaults, coercions and `.catch()` are all idempotent by
// construction — feeding a parsed value back through them is a no-op. The only
// way to break the property is a user-supplied `transform` (which `.transform`,
// `z.preprocess` and `.pipe` into a transform all produce). This suite
// therefore proves the invariant two ways:
//
//   1. Every registry tool whose `inputSchema` tree carries no transform node
//      is idempotent by construction — and any tool that GROWS one fails here
//      until an author adds a fixture below and proves it.
//   2. Every transforming tool, plus every tool that ships an `example_input`,
//      is checked directly: `parse(parse(x))` must deep-equal `parse(x)`.

import { describe, expect, it } from "bun:test";
import type { z } from "zod";
import { listTools } from "./index.ts";

/** Zod v4 keeps the node's structure on `_zod.def`; there is no public
 *  reflection API for walking a schema tree. */
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

/** Child schemas of a Zod node, across every container v4 emits. `lazy` is
 *  resolved through its getter; `seen` breaks the resulting cycles. */
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

/** Dotted paths of every `transform` node reachable from `schema`. */
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

/**
 * Representative inputs for every tool whose `inputSchema` carries a
 * transform. One entry per transform BRANCH — the point is to exercise the
 * rewrite, then feed its own output back in.
 *
 * Adding a transform to a tool without adding it here fails the structural
 * test below. That is the intent: a transform is the only thing that can make
 * an approved payload differ from the payload that runs.
 */
const TRANSFORM_FIXTURES: Readonly<Record<string, readonly unknown[]>> = {
  // `input` accepts the workflow's `$input` map, or a JSON-encoded object.
  run_workflow: [
    { workflow: "daily-report" },
    { workflow: "daily-report", input: { city: "Berlin" } },
    { workflow: "daily-report", input: '{"city":"Berlin"}' },
    { workflow: "daily-report", input: "" },
  ],
  // `credential` accepts the discriminated union, or a JSON-encoded object.
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

  // Broad sampling: `example_input` is the input the model is shown, so it is
  // the input most likely to be replayed through an approval.
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
