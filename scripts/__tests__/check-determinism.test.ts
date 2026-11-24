import { afterEach, describe, expect, test } from "bun:test";
import { mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { dirname, join } from "node:path";
import {
  checkSource,
  isScannedPath,
  listTestFiles,
  propertySeedViolations,
} from "../check-determinism.ts";

const FILE = "apps/engine/src/x/core.test.ts";
const rules = (src: string) => checkSource(FILE, src).map((v) => `${v.line}:${v.rule}`);

describe("fast-check seeds", () => {
  test("accepts a literal seed in the options, also across lines", () => {
    const src = [
      'import fc from "fast-check";',
      "fc.assert(fc.property(fc.integer(), (n) => n === n), { seed: 20261106, numRuns: 200 });",
      "fc.assert(",
      "  fc.property(fc.string(), (s) => {",
      "    return s.length >= 0;",
      "  }),",
      "  {",
      "    seed: 20261106,",
      "    numRuns: 200,",
      "  },",
      ");",
    ].join("\n");
    expect(rules(src)).toEqual([]);
  });

  test("accepts options held in a seeded constant, direct or spread", () => {
    const src = [
      "const FC = { seed: 20261106, numRuns: 200 } as const;",
      "const PROPS: fc.Parameters<unknown> = { numRuns: 50, seed: 7 };",
      "fc.assert(fc.property(fc.nat(), (n) => n >= 0), FC);",
      "fc.assert(fc.property(fc.nat(), (n) => n >= 0), { ...FC, numRuns: 10 });",
      "fc.check(fc.property(fc.nat(), (n) => n >= 0), PROPS);",
    ].join("\n");
    expect(rules(src)).toEqual([]);
  });

  test("accepts a seed taken from the deterministic-seed env with a fixed fallback", () => {
    const src =
      "fc.assert(p, { seed: Number(process.env.SUBKIT_DETERMINISTIC_SEED ?? 20261106) });";
    expect(rules(src)).toEqual([]);
  });

  test("rejects runs without options, without a seed, or seeded from the clock", () => {
    const src = [
      "fc.assert(fc.property(fc.nat(), (n) => n >= 0));",
      "fc.assert(fc.property(fc.nat(), (n) => n >= 0), { numRuns: 200 });",
      "fc.assert(p, { seed: Date.now() });",
      "const LOOSE = { numRuns: 5 };",
      "fc.assert(p, LOOSE);",
      "fc.assert(p, OTHER_FC);",
    ].join("\n");
    expect(propertySeedViolations(FILE, src).map((v) => v.line)).toEqual([1, 2, 3, 5, 6]);
  });

  test("a seed field inside the property body does not count", () => {
    const src =
      "fc.assert(fc.property(fc.record({ seed: fc.nat() }), (r) => r.seed >= 0), { numRuns: 1 });";
    expect(propertySeedViolations(FILE, src)).toHaveLength(1);
  });

  test("a seed name inside a string or a longer identifier does not count", () => {
    const src = [
      "const FC = { seed: 1 };",
      'fc.assert(fc.property(fc.nat(), () => true), { examples: [["FC)"]] });',
      "fc.assert(p, FC_LOOSE);",
      "fc.assert(p, cfg.FC);",
      'fc.assert(p, { examples: ["seed: 1"] });',
    ].join("\n");
    expect(propertySeedViolations(FILE, src).map((v) => v.line)).toEqual([2, 3, 4, 5]);
  });

  test("skips commented-out runs and reports the rule as an error", () => {
    const src = ["// fc.assert(p);", "fc.assert(p);"].join("\n");
    expect(checkSource(FILE, src)).toEqual([
      {
        file: FILE,
        line: 2,
        col: 1,
        rule: "fc-assert-requires-seed",
        severity: "error",
        snippet: "fc.assert(p);",
        reason:
          "Pass a fixed seed to every fast-check run: fc.assert(fc.property(...), { seed: 20261106, numRuns: 200 }).",
      },
    ]);
  });

  test("an unterminated call is still checked", () => {
    expect(propertySeedViolations(FILE, "fc.assert(p, { seed: 3 }")).toEqual([]);
  });
});

describe("existing rules stay line-based", () => {
  test("schedule occurrence merge fixtures remain deterministic", () => {
    const file = "apps/engine/src/scheduler/tests/schedule-occurrence-merge.test.ts";
    const source = readFileSync(new URL(`../../${file}`, import.meta.url), "utf8");
    expect(checkSource(file, source)).toEqual([]);
  });

  test("flags clock and randomness next to a seeded property without double counting", () => {
    const src = [
      "fc.assert(fc.property(fc.nat(), (n) => n >= 0), { seed: 1 });",
      "const id = randomUUID();",
      "const t = Date.now(); // allow-wall-clock",
      "test.only('x', () => {});",
    ].join("\n");
    expect(rules(src)).toEqual(["2:no-random-uuid-in-tests", "4:no-only-in-tests"]);
  });
});

describe("scan scope", () => {
  let root: string | null = null;

  afterEach(() => {
    if (root) rmSync(root, { recursive: true, force: true });
    root = null;
  });

  test("skips every node_modules folder", () => {
    expect(isScannedPath("apps/desktop/node_modules/zod/src/v4/core.test.ts")).toBe(false);
    expect(isScannedPath("packages/ui/node_modules/x/src/a.test.tsx")).toBe(false);
    expect(isScannedPath("apps/desktop/src/shell/views.test.tsx")).toBe(true);
  });

  test("lists app tests but not tests vendored under an app's node_modules", async () => {
    root = mkdtempSync(join(tmpdir(), "check-determinism-"));
    const files = [
      "apps/desktop/src/shell/views.test.tsx",
      "apps/desktop/node_modules/zod/src/v4/core.test.ts",
      "apps/engine/src/node_modules/inner/src/a.test.ts",
    ];
    for (const file of files) {
      mkdirSync(dirname(join(root, file)), { recursive: true });
      writeFileSync(join(root, file), "");
    }
    expect(await listTestFiles(root)).toEqual(["apps/desktop/src/shell/views.test.tsx"]);
  });
});
