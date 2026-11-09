import { describe, expect, test } from "bun:test";
import {
  aggregateByPrefix,
  judgeFile,
  parseCoverageTable,
  parseFloorFile,
  readCoverageRun,
  relatedTests,
  resolveFileFloors,
  testCandidates,
} from "../audit/coverage-floor.ts";

describe("parseFloorFile", () => {
  test("accepts subsystems, files and a core default", () => {
    const parsed = parseFloorFile({
      subsystems: { "apps/engine/src/rbac": { line_min: 90, function_min: 85 } },
      files: {
        "packages/shared/src/a.ts": { line_min: 100, function_min: 100, tests: ["x.test.ts"] },
      },
      core_default: { line_min: 100, function_min: 100, exclude: ["apps/engine/src/llm/core/"] },
    });
    expect("floors" in parsed && parsed.floors.core_default?.exclude).toEqual([
      "apps/engine/src/llm/core/",
    ]);
  });

  test("defaults exclude to empty and allows files without subsystems", () => {
    const parsed = parseFloorFile({
      files: { "a.ts": { line_min: 100, function_min: 100 } },
      core_default: { line_min: 100, function_min: 100 },
    });
    expect("floors" in parsed && parsed.floors).toEqual({
      subsystems: {},
      files: { "a.ts": { line_min: 100, function_min: 100 } },
      core_default: { line_min: 100, function_min: 100, exclude: [] },
    });
  });

  test("reports every malformed section", () => {
    expect(
      parseFloorFile({
        subsystems: { a: { line_min: 1 } },
        files: [],
        core_default: { line_min: 100, function_min: 100, exclude: "x" },
      }),
    ).toEqual({
      errors: [
        "subsystems.a: needs numeric line_min and function_min; branch_min is unsupported (tests: string[])",
        "`files` must be an object",
        "core_default: needs numeric line_min and function_min; branch_min is unsupported (exclude: string[])",
      ],
    });
    expect(parseFloorFile({ files: { b: { line_min: 1, function_min: 1, tests: [1] } } })).toEqual({
      errors: [
        "files.b: needs numeric line_min and function_min; branch_min is unsupported (tests: string[])",
      ],
    });
  });

  test("rejects unsafe or empty declared test paths", () => {
    for (const tests of [[""], ["/absolute.test.ts"], ["../outside.test.ts"]]) {
      expect(
        parseFloorFile({ files: { "a.ts": { line_min: 1, function_min: 1, tests } } }),
      ).toEqual({
        errors: [
          "files.a.ts: needs numeric line_min and function_min; branch_min is unsupported (tests: string[])",
        ],
      });
    }
  });

  test("rejects unsupported branch floors fail-closed", () => {
    expect(
      parseFloorFile({ files: { a: { line_min: 1, function_min: 1, branch_min: 1 } } }),
    ).toEqual({
      errors: [
        "files.a: needs numeric line_min and function_min; branch_min is unsupported (tests: string[])",
      ],
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
          "apps/engine/src/execution/core.ts": { line_min: 95, function_min: 90 },
          "packages/shared/src/approval-choice.ts": { line_min: 100, function_min: 100 },
        },
        core_default: { line_min: 100, function_min: 100, exclude: ["apps/engine/src/llm/core/"] },
      },
      [
        "apps/engine/src/workflows/core/workflow.ts",
        "apps/engine/src/execution/core.ts",
        "apps/engine/src/llm/core/invoke.ts",
        "apps/engine/src/workflows/service.ts",
      ],
    );
    expect([...floors.entries()]).toEqual([
      ["apps/engine/src/execution/core.ts", { line_min: 95, function_min: 90 }],
      [
        "apps/engine/src/workflows/core/workflow.ts",
        { line_min: 100, function_min: 100, rationale: "core_default" },
      ],
      ["packages/shared/src/approval-choice.ts", { line_min: 100, function_min: 100 }],
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
      {
        file: "apps/engine/src/a/x.ts",
        funcs: 100,
        lines: 80,
      },
      {
        file: "apps/engine/src/a/y.ts",
        funcs: 50,
        lines: 40,
      },
      {
        file: "packages/shared/src/approval-choice.ts",
        funcs: 100,
        lines: 100,
      },
    ]);
  });
});

describe("readCoverageRun", () => {
  test("never parses a table from a failed coverage command", () => {
    expect(
      readCoverageRun({ status: 1, signal: null, stdout: TABLE, stderr: "test failure" }),
    ).toEqual({ error: "coverage command exited with status 1" });
  });

  test("fails closed when spawning fails or the test process is signalled", () => {
    expect(readCoverageRun({ status: null, signal: "SIGTERM" })).toEqual({
      error: "coverage command terminated by signal SIGTERM",
    });
    expect(readCoverageRun({ status: null, signal: null, error: new Error("ENOENT") })).toEqual({
      error: "could not start coverage command: ENOENT",
    });
  });

  test("parses coverage only after a successful command", () => {
    expect(readCoverageRun({ status: 0, signal: null, stdout: TABLE })).toEqual({
      rows: parseCoverageTable(TABLE),
    });
  });
});

describe("aggregateByPrefix", () => {
  const rows = parseCoverageTable(TABLE).map((row) => ({
    ...row,
    lines_total: 10,
    lines_covered: row.file.endsWith("x.ts") ? 8 : row.file.endsWith("y.ts") ? 4 : 10,
    functions_total: 2,
    functions_covered: row.file.endsWith("y.ts") ? 1 : 2,
  }));

  test("weights by file length", () => {
    expect(aggregateByPrefix(rows, "apps/engine/src/a", "lines")).toBeCloseTo(60, 10);
    expect(aggregateByPrefix(rows, "apps/engine/src/a", "functions")).toBeCloseTo(75, 10);
  });

  test("counts an unreadable file as one line and returns null without matches", () => {
    expect(aggregateByPrefix(rows, "apps/engine/src/a/", "lines")).toBeCloseTo(60, 10);
    expect(aggregateByPrefix(rows, "apps/engine/src/b", "lines")).toBeNull();
  });

  test("leaves test helpers and fixtures out of the subsystem number", () => {
    const withHelpers = [
      ...rows,
      { file: "apps/engine/src/a/x-fixtures.ts", funcs: 100, lines: 100 },
      { file: "apps/engine/src/a/tests/fixture.ts", funcs: 100, lines: 100 },
      { file: "apps/engine/src/a/x.test.ts", funcs: 100, lines: 100 },
    ];
    expect(aggregateByPrefix(withHelpers, "apps/engine/src/a", "lines")).toBeCloseTo(60, 10);
    expect(
      aggregateByPrefix(withHelpers.slice(rows.length), "apps/engine/src/a", "lines"),
    ).toBeNull();
  });
});

describe("judgeFile", () => {
  const rows = parseCoverageTable(TABLE).map((row) => ({
    ...row,
    lines_total: 1,
    lines_covered: row.lines === 100 ? 1 : 0,
    functions_total: 1,
    functions_covered: row.funcs === 100 ? 1 : 0,
  }));
  const floor = { line_min: 100, function_min: 100 };

  test("passes a fully covered file and says branch coverage is unmeasured", () => {
    const verdict = judgeFile("packages/shared/src/approval-choice.ts", floor, rows);
    expect(verdict.status).toBe("PASS");
    expect(verdict.message).toContain("funcs");
  });

  test("fails a file below its floor or missing from the table", () => {
    expect(judgeFile("apps/engine/src/a/x.ts", floor, rows).status).toBe("FAIL");
    expect(judgeFile("apps/engine/src/missing.ts", floor, rows)).toEqual({
      status: "FAIL",
      message: "file missing from the coverage table; no test loads it",
    });
  });

  test("fails closed when function coverage is unmeasured", () => {
    expect(
      judgeFile("packages/shared/src/approval-choice.ts", floor, [
        {
          ...rows[2]!,
          functions_total: null,
          functions_covered: null,
        },
      ]),
    ).toEqual({
      status: "FAIL",
      message: "file has no LCOV function mappings; coverage is unmeasured",
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
