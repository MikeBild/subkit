import { describe, expect, test } from "bun:test";
import fc from "fast-check";
import {
  buildReverseGraph,
  colocatedTests,
  diffArgs,
  isTestFile,
  parseAffectedArgs,
  parseTsconfigPaths,
  pathVariants,
  runPool,
  selectAffected,
  summarize,
} from "../audit/import-graph.ts";

const ROOT = parseTsconfigPaths(
  "",
  `{
    // comments are allowed in tsconfig
    "compilerOptions": { "paths": { "@engine/*": ["./apps/engine/src/*"], "@shared/*": ["./packages/shared/src/*"], "bad": "x", "@exact": ["./packages/exact/index.ts"] } }
  }`,
);
const COCKPIT = parseTsconfigPaths(
  "apps/cockpit",
  JSON.stringify({
    compilerOptions: {
      paths: {
        "@/*": ["./src/*"],
        "@engine/http/llms/*": ["../../apps/engine/src/http/llms/*"],
        "@engine/*": ["./missing/*", "../../apps/engine/src/*"],
        "@multi/*.js": ["./multi/*.ts"],
      },
    },
  }),
);
const SCOPES = [ROOT, COCKPIT];

const FILES: Record<string, string> = {
  "apps/engine/src/a/service.ts": `import { x } from "./core.ts";`,
  "apps/engine/src/a/core.ts": `export const x = 1;`,
  "apps/engine/src/a/core.test.ts": `import { x } from "./core";`,
  "apps/engine/src/a/tests/service.int.test.ts": `import "../service.ts";`,
  "apps/engine/src/a/tests/other.test.ts": `import { s } from "@engine/a/service.ts";`,
  "apps/engine/src/b/index.ts": `export * from "../a/service";`,
  "apps/engine/src/b/deep.test.ts": `import "../b";`,
  "apps/cockpit/src/page.tsx": `import "@engine/http/llms/catalog.ts"; import "@/lib/util";`,
  "apps/cockpit/src/lib/util.ts": `export const u = 1;`,
  "apps/cockpit/src/page.test.tsx": `import "./page";`,
  "apps/engine/src/http/llms/catalog.ts": `export const c = 1;`,
  "packages/shared/src/s.spec.ts": `import "@shared/gone"; import "zod";`,
};

const exists = (p: string) => p in FILES;
const readText = (p: string) => FILES[p] ?? null;
const files = [...Object.keys(FILES), "apps/engine/src/unreadable.test.ts"];
const testFiles = files.filter(isTestFile);
const reverse = buildReverseGraph(files, readText, SCOPES, exists);
const select = (changed: string[], depth = 2) =>
  selectAffected({ changed, testFiles, reverse, depth });

describe("parseTsconfigPaths", () => {
  test("reads string targets and skips malformed entries", () => {
    expect(ROOT.rules.map((r) => r.pattern)).toEqual(["@engine/*", "@shared/*", "@exact"]);
    expect(parseTsconfigPaths("", "{}").rules).toEqual([]);
    expect(parseTsconfigPaths("", "not json").rules).toEqual([]);
  });
});

describe("buildReverseGraph", () => {
  test("resolves relative, alias, directory-index and nearest-scope imports", () => {
    expect([...(reverse.get("apps/engine/src/a/core.ts") ?? [])].sort()).toEqual([
      "apps/engine/src/a/core.test.ts",
      "apps/engine/src/a/service.ts",
    ]);
    expect([...(reverse.get("apps/engine/src/a/service.ts") ?? [])].sort()).toEqual([
      "apps/engine/src/a/tests/other.test.ts",
      "apps/engine/src/a/tests/service.int.test.ts",
      "apps/engine/src/b/index.ts",
    ]);
    expect([...(reverse.get("apps/engine/src/b/index.ts") ?? [])]).toEqual([
      "apps/engine/src/b/deep.test.ts",
    ]);
    expect([...(reverse.get("apps/engine/src/http/llms/catalog.ts") ?? [])]).toEqual([
      "apps/cockpit/src/page.tsx",
    ]);
    expect(reverse.has("apps/cockpit/src/lib/util.ts")).toBe(true);
    expect(reverse.has("packages/shared/src/gone")).toBe(true);
    expect(reverse.has("zod")).toBe(true);
  });

  test("picks the first existing alias target, the exact pattern and suffix patterns", () => {
    const graph = buildReverseGraph(
      ["apps/cockpit/src/x.ts", "apps/other/y.ts", "z.ts"],
      (p) =>
        p === "apps/cockpit/src/x.ts"
          ? `import "@engine/a/core"; import "@multi/m.js"; import "@multi/.j";`
          : p === "z.ts"
            ? `import "@exact"; import "@nope/x";`
            : `import "@shared/s.spec.ts";`,
      SCOPES,
      exists,
    );
    expect(graph.has("apps/engine/src/a/core.ts")).toBe(true);
    expect(graph.has("apps/cockpit/multi/m.ts")).toBe(true);
    expect(graph.has("@multi/.j")).toBe(true);
    expect(graph.has("packages/exact/index.ts")).toBe(true);
    expect(graph.has("@nope/x")).toBe(true);
    expect(graph.has("packages/shared/src/s.spec.ts")).toBe(true);
  });

  test("leaves non-relative imports untouched without a scope", () => {
    const graph = buildReverseGraph(["a.ts"], () => `import "@engine/x";`, [COCKPIT], exists);
    expect(graph.has("@engine/x")).toBe(true);
  });
});

describe("pathVariants", () => {
  test("adds the extensionless path and the directory of an index module", () => {
    expect(pathVariants("a/b/index.ts")).toEqual(["a/b/index.ts", "a/b/index", "a/b"]);
    expect(pathVariants("a/c.tsx")).toEqual(["a/c.tsx", "a/c"]);
    expect(pathVariants("a/d.json")).toEqual(["a/d.json"]);
  });
});

describe("colocatedTests", () => {
  test("matches stem-prefixed tests next to the module and in tests dirs", () => {
    expect(colocatedTests("apps/engine/src/a/service.ts", testFiles)).toEqual([
      "apps/engine/src/a/tests/service.int.test.ts",
    ]);
    expect(colocatedTests("apps/engine/src/a/core.ts", testFiles)).toEqual([
      "apps/engine/src/a/core.test.ts",
    ]);
  });
});

describe("selectAffected", () => {
  test("selects changed tests, colocated tests and importers up to the depth", () => {
    const result = select(["apps/engine/src/a/core.ts"]);
    expect(result.tests).toEqual([
      "apps/engine/src/a/core.test.ts",
      "apps/engine/src/a/tests/other.test.ts",
      "apps/engine/src/a/tests/service.int.test.ts",
    ]);
    expect(result.reasons.get("apps/engine/src/a/core.test.ts")).toBe(
      "colocated with apps/engine/src/a/core.ts",
    );
    expect(result.reasons.get("apps/engine/src/a/tests/other.test.ts")).toBe(
      "imports apps/engine/src/a/core.ts (depth 2)",
    );
  });

  test("depth bounds the transitive walk", () => {
    expect(select(["apps/engine/src/a/core.ts"], 1).tests).toEqual([
      "apps/engine/src/a/core.test.ts",
    ]);
    expect(select(["apps/engine/src/a/core.ts"], 3).tests).toContain(
      "apps/engine/src/b/deep.test.ts",
    );
    expect(select(["apps/engine/src/a/service.ts"], 0).tests).toEqual([
      "apps/engine/src/a/tests/service.int.test.ts",
    ]);
  });

  test("keeps changed test files, drops deleted ones and finds importers of deleted modules", () => {
    expect(select(["packages/shared/src/s.spec.ts", "gone.test.ts"]).tests).toEqual([
      "packages/shared/src/s.spec.ts",
    ]);
    expect(select(["packages/shared/src/gone.ts"]).tests).toEqual([
      "packages/shared/src/s.spec.ts",
    ]);
    expect(select(["apps/engine/src/b/index.ts"]).tests).toEqual([
      "apps/engine/src/b/deep.test.ts",
    ]);
  });

  test("follows cockpit aliases into engine modules", () => {
    expect(select(["apps/engine/src/http/llms/catalog.ts"]).tests).toEqual([
      "apps/cockpit/src/page.test.tsx",
    ]);
    expect(select(["apps/cockpit/src/lib/util.ts"]).tests).toEqual([
      "apps/cockpit/src/page.test.tsx",
    ]);
  });

  test("every selected test is a known test file and a deeper walk never selects less", () => {
    const paths = fc.constantFrom(...files, "packages/shared/src/gone.ts", "x/unknown.ts");
    fc.assert(
      fc.property(fc.array(paths, { maxLength: 6 }), fc.nat(4), (changed, depth) => {
        const shallow = select(changed, depth).tests;
        const deep = new Set(select(changed, depth + 1).tests);
        return (
          shallow.every((t) => testFiles.includes(t) && deep.has(t)) &&
          shallow.join() === [...new Set(shallow)].sort().join()
        );
      }),
      { seed: 20261106, numRuns: 200 },
    );
  });
});

describe("runPool", () => {
  test("keeps order and never exceeds the worker count", async () => {
    let active = 0;
    let peak = 0;
    const out = await runPool([5, 1, 3, 2, 4], 2, async (n) => {
      active += 1;
      peak = Math.max(peak, active);
      await Bun.sleep(n);
      active -= 1;
      return n * 10;
    });
    expect(out).toEqual([50, 10, 30, 20, 40]);
    expect(peak).toBe(2);
    expect(await runPool([], 4, async (n: number) => n)).toEqual([]);
  });
});

describe("parseAffectedArgs", () => {
  test("defaults to depth 2, four workers and the working tree", () => {
    expect(parseAffectedArgs([], {})).toEqual({ list: false, depth: 2, workers: 4, range: null });
  });

  test("reads options, the range and SUBKIT_TEST_WORKERS", () => {
    expect(
      parseAffectedArgs(["--list", "--depth", "0", "main..HEAD"], { SUBKIT_TEST_WORKERS: "2" }),
    ).toEqual({ list: true, depth: 0, workers: 2, range: "main..HEAD" });
    expect(parseAffectedArgs(["--workers", "8"], {})).toEqual({
      list: false,
      depth: 2,
      workers: 8,
      range: null,
    });
  });

  test("rejects bad input", () => {
    expect(parseAffectedArgs(["--depth", "-1"], {})).toEqual({
      error: "--depth needs a non-negative integer",
    });
    expect(parseAffectedArgs(["--workers", "0"], {})).toEqual({
      error: "--workers needs a positive integer",
    });
    expect(parseAffectedArgs(["--depth"], {})).toEqual({
      error: "--depth needs a non-negative integer",
    });
    expect(parseAffectedArgs(["--nope"], {})).toEqual({ error: "unknown option: --nope" });
    expect(parseAffectedArgs(["a", "b"], {})).toEqual({ error: "unexpected argument: b" });
    expect(parseAffectedArgs([], { SUBKIT_TEST_WORKERS: "x" })).toEqual({
      error: "SUBKIT_TEST_WORKERS must be a positive integer",
    });
  });
});

describe("diffArgs and summarize", () => {
  test("diffs against HEAD or the given range", () => {
    expect(diffArgs(null)).toEqual(["diff", "--name-only", "HEAD"]);
    expect(diffArgs("main..HEAD")).toEqual(["diff", "--name-only", "main..HEAD"]);
  });

  test("counts failures and lists them", () => {
    expect(
      summarize([
        { file: "a.test.ts", exitCode: 0, output: "" },
        { file: "b.test.ts", exitCode: 1, output: "boom" },
      ]),
    ).toEqual({ text: "1 passed, 1 failed\n  FAIL b.test.ts (exit 1)", failed: 1 });
  });
});
