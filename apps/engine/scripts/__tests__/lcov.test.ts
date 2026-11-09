import { describe, expect, test } from "bun:test";
import { coverageRows, mergeLcov, parseLcov, renderLcov } from "../audit/lcov.ts";

const FIRST = `SF:/repo/apps/engine/src/a/core.ts
FN:2,decide
FNDA:0,decide
DA:1,1
DA:2,0
end_of_record
`;
const SECOND = `SF:apps/engine/src/a/core.ts
FN:2,decide
FNDA:3,decide
DA:1,0
DA:2,1
DA:3,1
end_of_record
`;
const SUMMARY_FIRST = `SF:apps/engine/src/a/functions.ts
FNF:2
FNH:1
DA:1,1
end_of_record
`;
const SUMMARY_SECOND = `SF:apps/engine/src/a/functions.ts
FNF:2
FNH:1
DA:1,1
end_of_record
`;

describe("LCOV union", () => {
  test("unions per-line and per-function hits from isolated test processes", () => {
    const first = parseLcov(FIRST, "/repo");
    const second = parseLcov(SECOND, "/repo");
    if ("error" in first || "error" in second) throw new Error("fixture must parse");
    const merged = mergeLcov([...first, ...second]);
    expect(coverageRows(merged)).toEqual([
      {
        file: "apps/engine/src/a/core.ts",
        funcs: 100,
        lines: 100,
        functions_covered: 1,
        functions_total: 1,
        lines_covered: 3,
        lines_total: 3,
      },
    ]);
    expect(renderLcov(merged)).toContain("DA:2,1");
    expect(renderLcov(merged)).toContain("FNDA:3,decide");
  });

  test("rejects malformed line and function records", () => {
    expect(parseLcov("SF:x.ts\nDA:no,1\n", "/repo")).toEqual({
      error: "invalid LCOV DA record: DA:no,1",
    });
    expect(parseLcov("SF:x.ts\nFN:1,\n", "/repo")).toEqual({
      error: "invalid LCOV FN record: FN:1,",
    });
    expect(parseLcov("SF:x.ts\nFNF:1\nFNH:2\n", "/repo")).toEqual({
      error: "invalid LCOV function summary: FNH exceeds FNF (2>1)",
    });
  });

  test("keeps Bun FNF/FNH function summaries and uses a conservative union", () => {
    const first = parseLcov(SUMMARY_FIRST, "/repo");
    const second = parseLcov(SUMMARY_SECOND, "/repo");
    if ("error" in first || "error" in second) throw new Error("fixture must parse");
    expect(coverageRows(mergeLcov([...first, ...second]))).toEqual([
      {
        file: "apps/engine/src/a/functions.ts",
        funcs: 50,
        lines: 100,
        functions_covered: 1,
        functions_total: 2,
        lines_covered: 1,
        lines_total: 1,
      },
    ]);
  });

  test("does not claim function coverage without an FNF/FNH pair", () => {
    const parsed = parseLcov("SF:apps/x.ts\nDA:1,1\nend_of_record\n", "/repo");
    if ("error" in parsed) throw new Error("fixture must parse");
    expect(coverageRows(parsed)[0]).toMatchObject({
      funcs: 0,
      functions_covered: null,
      functions_total: null,
    });
  });

  test("keeps an aggregate FNF/FNH denominator when IDs are partial", () => {
    const parsed = parseLcov(
      `SF:apps/x.ts
FN:2,one
FNDA:1,one
FNF:10
FNH:5
DA:1,1
end_of_record
`,
      "/repo",
    );
    if ("error" in parsed) throw new Error("fixture must parse");
    expect(coverageRows(parsed)[0]).toMatchObject({
      funcs: 50,
      functions_covered: 5,
      functions_total: 10,
    });
  });

  test("uses exact identity union only where every input has complete named IDs", () => {
    const first = parseLcov(
      `SF:apps/x.ts
FN:2,one
FN:3,two
FNDA:1,one
FNDA:0,two
FNF:2
FNH:1
DA:1,1
end_of_record
`,
      "/repo",
    );
    const second = parseLcov(
      `SF:apps/x.ts
FN:2,one
FN:3,two
FNDA:0,one
FNDA:1,two
FNF:2
FNH:1
DA:1,1
end_of_record
`,
      "/repo",
    );
    if ("error" in first || "error" in second) throw new Error("fixture must parse");
    expect(coverageRows(mergeLcov([...first, ...second]))[0]).toMatchObject({
      funcs: 100,
      functions_covered: 2,
      functions_total: 2,
    });
  });

  test("rejects incomplete function summaries and does not let FNDA-only records measure functions", () => {
    expect(parseLcov("SF:apps/x.ts\nFNF:1\nDA:1,1\nend_of_record\n", "/repo")).toEqual({
      error: "invalid LCOV function summary: FNF and FNH must appear together",
    });
    const fndaOnly = parseLcov("SF:apps/x.ts\nFNDA:1,anonymous\nDA:1,1\nend_of_record\n", "/repo");
    if ("error" in fndaOnly) throw new Error("fixture must parse");
    expect(coverageRows(fndaOnly)[0]).toMatchObject({
      funcs: 0,
      functions_covered: null,
      functions_total: null,
    });
  });

  test("keeps empty dependency records for target-level validation", () => {
    expect(parseLcov("SF:apps/x.ts\nend_of_record\n", "/repo")).toHaveLength(1);
  });
});
