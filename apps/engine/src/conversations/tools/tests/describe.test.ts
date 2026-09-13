// compileDescription tests.

import { describe, expect, test } from "bun:test";

import { compileDescription } from "../describe.ts";
import type { ConversationTool } from "../index.ts";

function mkTool(overrides: Partial<ConversationTool> = {}): ConversationTool {
  return {
    name: "x",
    description: "Base description.",
    inputSchema: { parse: (v: unknown) => v } as unknown as ConversationTool["inputSchema"],
    category: "tenant_read",
    async execute() {
      return { ok: true, data: null };
    },
    ...overrides,
  };
}

describe("compileDescription — empty metadata is a no-op", () => {
  test("returns just the base description when no metadata is set", () => {
    const out = compileDescription(mkTool());
    expect(out).toBe("Base description.");
  });

  test("empty arrays/strings are treated as absent", () => {
    const out = compileDescription(
      mkTool({
        use_case: "   ",
        important_notes: [],
        requires_skill: "",
        example_input: {},
      }),
    );
    expect(out).toBe("Base description.");
  });
});

describe("compileDescription — renders each section", () => {
  test("use_case alone is wrapped in <use_case>", () => {
    const out = compileDescription(mkTool({ use_case: "Call to list X." }));
    expect(out).toContain("Base description.");
    expect(out).toContain("<use_case>Call to list X.</use_case>");
  });

  test("important_notes become markdown bullets inside <important_notes>", () => {
    const out = compileDescription(mkTool({ important_notes: ["note one", "note two"] }));
    expect(out).toContain("<important_notes>");
    expect(out).toContain("- note one");
    expect(out).toContain("- note two");
    expect(out).toContain("</important_notes>");
  });

  test("requires_skill is wrapped in <requires_skill>", () => {
    const out = compileDescription(mkTool({ requires_skill: "self-healing" }));
    expect(out).toContain("<requires_skill>self-healing</requires_skill>");
  });

  test("example_input renders as single-line JSON inside <example>", () => {
    const out = compileDescription(mkTool({ example_input: { id: "abc", limit: 10 } }));
    expect(out).toContain("<example>");
    expect(out).toContain('{"id":"abc","limit":10}');
    expect(out).toContain("</example>");
  });

  test("all four channels render in a stable order", () => {
    const out = compileDescription(
      mkTool({
        use_case: "UC",
        important_notes: ["N1"],
        requires_skill: "S1",
        example_input: { x: 1 },
      }),
    );
    const uc = out.indexOf("<use_case>");
    const in_ = out.indexOf("<important_notes>");
    const rs = out.indexOf("<requires_skill>");
    const ex = out.indexOf("<example>");
    expect(uc).toBeGreaterThan(0);
    expect(in_).toBeGreaterThan(uc);
    expect(rs).toBeGreaterThan(in_);
    expect(ex).toBeGreaterThan(rs);
  });
});

describe("compileDescription — idempotent shape", () => {
  test("two calls with the same tool produce identical strings", () => {
    const tool = mkTool({
      use_case: "repeatable",
      important_notes: ["a", "b"],
      requires_skill: "http-connectors",
      example_input: { a: 1 },
    });
    expect(compileDescription(tool)).toBe(compileDescription(tool));
  });
});
