import { describe, expect, test } from "bun:test";
import {
  createClosureAnalysis,
  directTestPaths,
  reviewedClosure,
  reviewedClosurePlan,
  reviewedClosurePlanFromAnalysis,
} from "../audit/mutation-closure.ts";

describe("reviewed mutation closure", () => {
  test("coverage and mutation agree on runtime direct tests across names and facades", () => {
    const source: Record<string, string> = {
      "src/core.ts": "export const core = 1; export type Shape = number;",
      "src/facade.ts": 'export { core } from "./core.ts";',
      "src/behavior-contract.test.ts": 'import { core } from "./core";',
      "src/facade.test.ts": 'import { core } from "./facade.ts";',
      "src/types.test.ts": 'import type { Shape } from "./core.ts";',
      "src/core.test.ts": "const unrelated = true;",
    };
    const analysis = createClosureAnalysis({
      files: Object.keys(source),
      readText: (path) => source[path] ?? null,
      tsconfig: "{}",
      cockpitTsconfig: "{}",
    });
    const direct = directTestPaths(analysis, "src/core.ts");
    expect(direct).toEqual(["src/behavior-contract.test.ts"]);
    const closure = reviewedClosurePlanFromAnalysis(analysis, {
      targets: ["src/core.ts"],
      declared: [],
    });
    expect(
      closure.tests.filter((entry) => entry.kind === "direct").map((entry) => entry.path),
    ).toEqual(direct);
    expect(closure.tests.find((entry) => entry.path === "src/facade.test.ts")?.kind).toBe(
      "reverse_import",
    );
  });
  test("reuses one cached reverse graph and source reads across independent shard plans", () => {
    const source: Record<string, string> = {
      "src/a.ts": "export const a = 1;",
      "src/b.ts": "export const b = 2;",
      "src/a.test.ts": 'import { a } from "./a.ts";',
      "src/b.test.ts": 'import { b } from "./b.ts";',
    };
    const reads = new Map<string, number>();
    let builds = 0;
    const analysis = createClosureAnalysis({
      files: Object.keys(source),
      readText: (path) => {
        reads.set(path, (reads.get(path) ?? 0) + 1);
        return source[path] ?? null;
      },
      tsconfig: "{}",
      cockpitTsconfig: "{}",
      onGraphBuilt: () => (builds += 1),
    });
    const first = reviewedClosurePlanFromAnalysis(analysis, {
      targets: ["src/a.ts"],
      declared: [],
    });
    const second = reviewedClosurePlanFromAnalysis(analysis, {
      targets: ["src/b.ts"],
      declared: [],
    });
    expect(builds).toBe(1);
    expect([...reads.values()].every((count) => count === 1)).toBe(true);
    expect(first.tests.map((item) => item.path)).toEqual(["src/a.test.ts"]);
    expect(second.tests.map((item) => item.path)).toEqual(["src/b.test.ts"]);
  });
  test("retains tests through root test harnesses without classifying harnesses as product consumers", () => {
    const source: Record<string, string> = {
      "src/core.ts": "export const core = 1;",
      "tests/harness.ts": 'export { core } from "../src/core.ts";',
      "tests/contract.test.ts": 'import { core } from "./harness.ts";',
    };
    const plan = reviewedClosurePlan({
      targets: ["src/core.ts"],
      files: Object.keys(source),
      readText: (path) => source[path] ?? null,
      tsconfig: "{}",
      cockpitTsconfig: "{}",
      declared: [],
    });
    expect(plan.tests.map((test) => test.path)).toContain("tests/contract.test.ts");
    expect(plan.consumers).toEqual([]);
  });
  test("does not treat a matching filename without a runtime import as direct evidence", () => {
    const source: Record<string, string> = {
      "src/core.ts": "export const core = 1;",
      "src/core.test.ts": "const unrelated = true;",
    };
    const plan = reviewedClosurePlan({
      targets: ["src/core.ts"],
      files: Object.keys(source),
      readText: (path) => source[path] ?? null,
      tsconfig: "{}",
      cockpitTsconfig: "{}",
      declared: [],
    });
    expect(plan.tests.find((item) => item.path === "src/core.test.ts")?.kind).not.toBe("direct");
  });
  test("preserves direct proof ownership when another target is only reached transitively", () => {
    const source: Record<string, string> = {
      "src/a.ts": 'import { b } from "./b.ts"; export const a = b;',
      "src/b.ts": "export const b = 1;",
      "src/named-contract.test.ts": 'import { a } from "./a.ts";',
    };
    for (const targets of [
      ["src/a.ts", "src/b.ts"],
      ["src/b.ts", "src/a.ts"],
    ]) {
      const plan = reviewedClosurePlan({
        targets,
        files: Object.keys(source),
        readText: (path) => source[path] ?? null,
        tsconfig: "{}",
        cockpitTsconfig: "{}",
        declared: [],
      });
      expect(plan.tests.find((item) => item.path === "src/named-contract.test.ts")).toMatchObject({
        kind: "direct",
        covers_targets: ["src/a.ts"],
      });
    }
  });
  test("binds each production consumer only to tests that reach that consumer", () => {
    const source: Record<string, string> = {
      "src/core.ts": "export const core = 1;",
      "src/core.test.ts": 'import { core } from "./core.ts";',
      "src/consumer.ts": 'import { core } from "./core.ts"; export const value = core;',
      "src/consumer.test.ts": 'import { value } from "./consumer.ts";',
      "src/untested.ts": 'import { core } from "./core.ts"; export const value = core;',
    };
    const plan = reviewedClosurePlan({
      targets: ["src/core.ts"],
      files: Object.keys(source),
      readText: (path) => source[path] ?? null,
      tsconfig: "{}",
      cockpitTsconfig: "{}",
      declared: [],
    });
    expect(plan.consumers.find((item) => item.path === "src/consumer.ts")?.witnesses).toEqual([
      "src/consumer.test.ts",
    ]);
    expect(plan.consumers.find((item) => item.path === "src/untested.ts")?.witnesses).toEqual([]);
  });
  test("combines reverse-import discovery with reviewed declared witnesses", () => {
    const files = [
      "apps/engine/src/x/core.ts",
      "apps/engine/src/x/core.test.ts",
      "apps/engine/src/x/consumer.ts",
      "apps/engine/src/x/consumer.test.ts",
    ];
    const source: Record<string, string> = {
      "apps/engine/src/x/core.ts": "export const core = 1;",
      "apps/engine/src/x/core.test.ts": 'import { core } from "./core.ts";',
      "apps/engine/src/x/consumer.ts":
        'import { core } from "./core.ts"; export const consumer = core;',
      "apps/engine/src/x/consumer.test.ts": 'import { consumer } from "./consumer.ts";',
    };
    expect(
      reviewedClosure({
        targets: ["apps/engine/src/x/core.ts"],
        files,
        readText: (path) => source[path] ?? null,
        tsconfig: "{}",
        cockpitTsconfig: "{}",
        declared: [
          {
            path: "apps/engine/src/x/consumer.test.ts",
            kind: "consumer_contract",
            covers_targets: ["apps/engine/src/x/core.ts"],
            rationale: "contract",
          },
        ],
      }).map((entry) => entry.path),
    ).toEqual(["apps/engine/src/x/consumer.test.ts", "apps/engine/src/x/core.test.ts"]);
  });
  test("records the nearest import distance when several targets reach the same test", () => {
    const source: Record<string, string> = {
      "src/a.ts": "export const a = 1;",
      "src/b.ts": "export const b = 1;",
      "src/mid.ts": 'export { a } from "./a.ts";',
      "src/far.ts": 'export { a } from "./mid.ts";',
      "src/shared.test.ts": 'import { a } from "./far.ts"; import { b } from "./b.ts";',
    };
    for (const targets of [
      ["src/a.ts", "src/b.ts"],
      ["src/b.ts", "src/a.ts"],
    ]) {
      const closure = reviewedClosurePlan({
        targets,
        files: Object.keys(source),
        readText: (path) => source[path] ?? null,
        tsconfig: "{}",
        cockpitTsconfig: "{}",
        declared: [],
      });
      const rationale = closure.tests.find(
        (entry) => entry.path === "src/shared.test.ts",
      )?.rationale;
      expect(rationale).toContain("src/b.ts");
      expect(rationale).not.toContain("depth 3");
    }
  });
});
