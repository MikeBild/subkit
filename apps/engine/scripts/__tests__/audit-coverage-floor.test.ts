import { describe, expect, test } from "bun:test";
import {
  aggregateByPrefix,
  judgeFile,
  parseCoverageTable,
  parseFloorFile,
  relatedTests,
  resolveFileFloors,
  testCandidates,
} from "../audit/coverage-floor.ts";

describe("parseFloorFile", () => {
  test("accepts subsystems, files and a core default", () => {
    const parsed = parseFloorFile({
      subsystems: { "apps/engine/src/rbac": { line_min: 90, branch_min: 85 } },
      files: {
        "packages/shared/src/a.ts": { line_min: 100, branch_min: 100, tests: ["x.test.ts"] },
      },
      core_default: { line_min: 100, branch_min: 100, exclude: ["apps/engine/src/llm/core/"] },
    });
    expect("floors" in parsed && parsed.floors.core_default?.exclude).toEqual([
      "apps/engine/src/llm/core/",
    ]);
  });

  test("defaults exclude to empty and allows files without subsystems", () => {
    const parsed = parseFloorFile({
      files: { "a.ts": { line_min: 100, branch_min: 100 } },
      core_default: { line_min: 100, branch_min: 100 },
    });
    expect("floors" in parsed && parsed.floors).toEqual({
      subsystems: {},
      files: { "a.ts": { line_min: 100, branch_min: 100 } },
      core_default: { line_min: 100, branch_min: 100, exclude: [] },
    });
  });

  test("reports every malformed section", () => {
    expect(
      parseFloorFile({
        subsystems: { a: { line_min: 1 } },
        files: [],
        core_default: { line_min: 100, branch_min: 100, exclude: "x" },
      }),
    ).toEqual({
      errors: [
        "subsystems.a: needs numeric line_min and branch_min (tests: string[])",
        "`files` must be an object",
        "core_default: needs numeric line_min and branch_min (exclude: string[])",
      ],
    });
    expect(parseFloorFile({ files: { b: { line_min: 1, branch_min: 1, tests: [1] } } })).toEqual({
      errors: ["files.b: needs numeric line_min and branch_min (tests: string[])"],
    });
  });

  test("rejects an empty declaration and non-objects", () => {
    expect(parseFloorFile({})).toEqual({ errors: ["no subsystems or files declared"] });
    expect(parseFloorFile(null)).toEqual({ errors: ["no subsystems or files declared"] });
  });
});

describe("resolveFileFloors", () => {
  test("applies the core default to discovered cores, skips excludes, explicit entries win", () => {
    const floors = resolveFileFloors(
      {
        subsystems: {},
        files: {
          "apps/engine/src/execution/core.ts": { line_min: 95, branch_min: 90 },
          "packages/shared/src/approval-choice.ts": { line_min: 100, branch_min: 100 },
        },
        core_default: { line_min: 100, branch_min: 100, exclude: ["apps/engine/src/llm/core/"] },
      },
      [
        "apps/engine/src/workflows/core/workflow.ts",
        "apps/engine/src/execution/core.ts",
        "apps/engine/src/llm/core/invoke.ts",
        "apps/engine/src/workflows/service.ts",
      ],
    );
    expect([...floors.entries()]).toEqual([
      ["apps/engine/src/execution/core.ts", { line_min: 95, branch_min: 90 }],
      [
        "apps/engine/src/workflows/core/workflow.ts",
        { line_min: 100, branch_min: 100, rationale: "core_default" },
      ],
      ["packages/shared/src/approval-choice.ts", { line_min: 100, branch_min: 100 }],
    ]);
  });

  test("without a core default only explicit files are checked", () => {
    expect(
      resolveFileFloors({ subsystems: {}, files: {}, core_default: null }, [
        "apps/engine/src/execution/core.ts",
      ]).size,
    ).toBe(0);
  });
});

describe("testCandidates", () => {
  test("lists sibling, __tests__ and tests locations", () => {
    expect(testCandidates("apps/engine/src/execution/core.ts")).toEqual([
      "apps/engine/src/execution/core.test.ts",
      "apps/engine/src/execution/core.test.tsx",
      "apps/engine/src/execution/__tests__/core.test.ts",
      "apps/engine/src/execution/tests/core.test.ts",
    ]);
  });
});

const TABLE = [
  "File                                   | % Funcs | % Lines | Uncovered Line #s",
  "---------------------------------------|---------|---------|-------------------",
  "All files                              |   70.77 |   65.59 |",
  " apps/engine/src/a/x.ts                |  100.00 |   80.00 | 3-4",
  " apps/engine/src/a/y.ts                |   50.00 |   40.00 | 1",
  " packages/shared/src/approval-choice.ts |  100.00 |  100.00 | ",
  " node_modules/z.ts                     |  100.00 |  100.00 | ",
  " apps/broken.ts                        |     n/a |  100.00 | ",
].join("\n");

describe("parseCoverageTable", () => {
  test("keeps apps/ and packages/ rows with numeric columns", () => {
    expect(parseCoverageTable(TABLE)).toEqual([
      { file: "apps/engine/src/a/x.ts", funcs: 100, lines: 80 },
      { file: "apps/engine/src/a/y.ts", funcs: 50, lines: 40 },
      { file: "packages/shared/src/approval-choice.ts", funcs: 100, lines: 100 },
    ]);
  });
});

describe("aggregateByPrefix", () => {
  const rows = parseCoverageTable(TABLE);

  test("weights by file length", () => {
    const sizes: Record<string, number> = {
      "apps/engine/src/a/x.ts": 30,
      "apps/engine/src/a/y.ts": 10,
    };
    expect(aggregateByPrefix(rows, "apps/engine/src/a", (f) => sizes[f] ?? 0)).toBeCloseTo(70, 10);
  });

  test("counts an unreadable file as one line and returns null without matches", () => {
    expect(aggregateByPrefix(rows, "apps/engine/src/a/", () => 0)).toBeCloseTo(60, 10);
    expect(aggregateByPrefix(rows, "apps/engine/src/b", () => 10)).toBeNull();
  });

  test("leaves test helpers and fixtures out of the subsystem number", () => {
    const withHelpers = [
      ...rows,
      { file: "apps/engine/src/a/x-fixtures.ts", funcs: 100, lines: 100 },
      { file: "apps/engine/src/a/tests/fixture.ts", funcs: 100, lines: 100 },
      { file: "apps/engine/src/a/x.test.ts", funcs: 100, lines: 100 },
    ];
    const sizes: Record<string, number> = {
      "apps/engine/src/a/x.ts": 30,
      "apps/engine/src/a/y.ts": 10,
    };
    expect(aggregateByPrefix(withHelpers, "apps/engine/src/a", (f) => sizes[f] ?? 500)).toBeCloseTo(
      70,
      10,
    );
    expect(
      aggregateByPrefix(withHelpers.slice(rows.length), "apps/engine/src/a", () => 10),
    ).toBeNull();
  });
});

describe("judgeFile", () => {
  const rows = parseCoverageTable(TABLE);
  const floor = { line_min: 100, branch_min: 100 };

  test("passes a fully covered file and says branch coverage is unmeasured", () => {
    const verdict = judgeFile("packages/shared/src/approval-choice.ts", floor, rows);
    expect(verdict.status).toBe("PASS");
    expect(verdict.message).toContain("branch=unmeasured");
  });

  test("fails a file below its floor or missing from the table", () => {
    expect(judgeFile("apps/engine/src/a/x.ts", floor, rows).status).toBe("FAIL");
    expect(judgeFile("apps/engine/src/missing.ts", floor, rows)).toEqual({
      status: "FAIL",
      message: "file missing from the coverage table; no test loads it",
    });
  });
});

describe("relatedTests", () => {
  test("finds topic and dash-suffixed test files of the same core", () => {
    expect(
      relatedTests("apps/engine/src/execution/core/run.ts", [
        "run.ts",
        "run.test.ts",
        "run-entry.test.ts",
        "run.properties.test.ts",
        "runner.test.ts",
        "status.test.ts",
        "run-fixtures.ts",
      ]),
    ).toEqual([
      "apps/engine/src/execution/core/run-entry.test.ts",
      "apps/engine/src/execution/core/run.properties.test.ts",
    ]);
  });
});
