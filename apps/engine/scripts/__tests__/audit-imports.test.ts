import { describe, expect, test } from "bun:test";
import { collectImports, resolveImport } from "../audit/imports.ts";

describe("collectImports", () => {
  test("finds static, re-export, type-only, dynamic and import-type references", () => {
    const source = [
      'import { a } from "./a.ts";',
      'import type { B } from "./b.ts";',
      'import { type C, type D } from "./c.ts";',
      'import { type E, f } from "./e.ts";',
      'export { g } from "./g.ts";',
      'export type { H } from "./h.ts";',
      'const m = await import("./m.ts");',
      'type T = typeof import("./t.ts");',
      'import x = require("./x");',
      'import "./side-effect.ts";',
    ].join("\n");
    expect(collectImports("a.ts", source)).toEqual([
      { specifier: "./a.ts", typeOnly: false, line: 1 },
      { specifier: "./b.ts", typeOnly: true, line: 2 },
      { specifier: "./c.ts", typeOnly: true, line: 3 },
      { specifier: "./e.ts", typeOnly: false, line: 4 },
      { specifier: "./g.ts", typeOnly: false, line: 5 },
      { specifier: "./h.ts", typeOnly: true, line: 6 },
      { specifier: "./m.ts", typeOnly: false, line: 7 },
      { specifier: "./t.ts", typeOnly: true, line: 8 },
      { specifier: "./x", typeOnly: false, line: 9 },
      { specifier: "./side-effect.ts", typeOnly: false, line: 10 },
    ]);
  });

  test("ignores import-like text in strings", () => {
    expect(collectImports("a.ts", 'const s = "import x from \\"./y.ts\\"";')).toEqual([]);
  });
});

describe("resolveImport", () => {
  const files = new Set([
    "apps/engine/src/conversations/tools/index.ts",
    "apps/engine/src/db/schema.ts",
    "apps/engine/src/llm/x.ts",
  ]);
  const exists = (p: string) => files.has(p);

  test("keeps bare specifiers", () => {
    expect(resolveImport("apps/engine/src/a.ts", "drizzle-orm", exists)).toBe("drizzle-orm");
  });

  test("resolves a directory import to its index.ts", () => {
    expect(resolveImport("apps/engine/src/mcp/server.ts", "../conversations/tools", exists)).toBe(
      "apps/engine/src/conversations/tools/index.ts",
    );
  });

  test("adds the .ts extension and maps .js to .ts when the .ts exists", () => {
    expect(resolveImport("apps/engine/src/http/a.ts", "../db/schema", exists)).toBe(
      "apps/engine/src/db/schema.ts",
    );
    expect(resolveImport("apps/engine/src/http/a.ts", "../llm/x.js", exists)).toBe(
      "apps/engine/src/llm/x.ts",
    );
    expect(resolveImport("apps/engine/src/http/a.ts", "../llm/y.js", exists)).toBe(
      "apps/engine/src/llm/y.js",
    );
  });

  test("returns the normalized path when nothing exists", () => {
    expect(resolveImport("apps/engine/src/http/a.ts", "./missing", exists)).toBe(
      "apps/engine/src/http/missing",
    );
  });
});
