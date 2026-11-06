import { describe, expect, test } from "bun:test";
import fc from "fast-check";
import {
  judgeScores,
  normalizeReportPath,
  readBreakThreshold,
  readReportPath,
  renderScore,
  scoreFiles,
} from "../audit/mutation-floor.ts";

const REPO = "/repo";

const report = (files: Record<string, string[]>) => ({
  files: Object.fromEntries(
    Object.entries(files).map(([file, statuses]) => [
      file,
      { mutants: statuses.map((status, id) => ({ id: String(id), status })) },
    ]),
  ),
});

describe("readBreakThreshold", () => {
  test("reads thresholds.break", () => {
    expect(readBreakThreshold({ thresholds: { break: 99 } })).toBe(99);
  });

  test("rejects missing or non-numeric thresholds", () => {
    expect(readBreakThreshold(null)).toBeNull();
    expect(readBreakThreshold("x")).toBeNull();
    expect(readBreakThreshold({})).toBeNull();
    expect(readBreakThreshold({ thresholds: null })).toBeNull();
    expect(readBreakThreshold({ thresholds: { break: "99" } })).toBeNull();
    expect(readBreakThreshold({ thresholds: { break: Number.NaN } })).toBeNull();
  });
});

describe("readReportPath", () => {
  test("reads jsonReporter.fileName and falls back otherwise", () => {
    expect(readReportPath({ jsonReporter: { fileName: "out/m.json" } }, "d.json")).toBe(
      "out/m.json",
    );
    expect(readReportPath(null, "d.json")).toBe("d.json");
    expect(readReportPath({}, "d.json")).toBe("d.json");
    expect(readReportPath({ jsonReporter: null }, "d.json")).toBe("d.json");
    expect(readReportPath({ jsonReporter: { fileName: "" } }, "d.json")).toBe("d.json");
    expect(readReportPath({ jsonReporter: { fileName: 3 } }, "d.json")).toBe("d.json");
  });
});

describe("normalizeReportPath", () => {
  test("makes absolute and dot-relative keys repo-relative", () => {
    expect(normalizeReportPath(REPO, "/repo/apps/a/core.ts")).toBe("apps/a/core.ts");
    expect(normalizeReportPath(REPO, "./apps/a/core.ts")).toBe("apps/a/core.ts");
    expect(normalizeReportPath(REPO, "apps/a/core.ts")).toBe("apps/a/core.ts");
  });
});

describe("scoreFiles", () => {
  test("counts killed and timeout as detected, survived and no coverage as undetected", () => {
    const scores = scoreFiles(
      report({
        "/repo/b/core.ts": ["Killed", "Timeout", "Survived", "NoCoverage"],
        "a/core.ts": ["Killed", "Ignored", "CompileError", "RuntimeError", "Pending"],
      }),
      REPO,
    );
    expect(scores).toEqual([
      { file: "a/core.ts", detected: 1, undetected: 0, score: 100 },
      { file: "b/core.ts", detected: 2, undetected: 2, score: 50 },
    ]);
  });

  test("a file without valid mutants scores 100", () => {
    expect(scoreFiles(report({ "a.ts": ["Ignored"] }), REPO)).toEqual([
      { file: "a.ts", detected: 0, undetected: 0, score: 100 },
    ]);
  });

  test("skips mutants without a status", () => {
    expect(
      scoreFiles({ files: { "a.ts": { mutants: [null, {}, { status: "Killed" }] } } }, REPO),
    ).toEqual([{ file: "a.ts", detected: 1, undetected: 0, score: 100 }]);
  });

  test("rejects malformed reports", () => {
    expect(scoreFiles(null, REPO)).toEqual({ error: "report is not an object" });
    expect(scoreFiles({}, REPO)).toEqual({ error: "report has no files map" });
    expect(scoreFiles({ files: { "a.ts": {} } }, REPO)).toEqual({
      error: "a.ts has no mutants array",
    });
    expect(scoreFiles({ files: { "a.ts": null } }, REPO)).toEqual({
      error: "a.ts has no mutants array",
    });
  });

  test("score stays within 0..100 and matches detected / valid", () => {
    const status = fc.constantFrom(
      "Killed",
      "Timeout",
      "Survived",
      "NoCoverage",
      "Ignored",
      "CompileError",
    );
    fc.assert(
      fc.property(fc.array(status, { maxLength: 40 }), (statuses) => {
        const result = scoreFiles(report({ "a.ts": statuses }), REPO);
        if ("error" in result) return false;
        const [score] = result;
        if (!score) return false;
        const valid = score.detected + score.undetected;
        const expected = valid === 0 ? 100 : (score.detected / valid) * 100;
        return score.score === expected && score.score >= 0 && score.score <= 100;
      }),
      { seed: 20261106, numRuns: 200 },
    );
  });
});

describe("judgeScores", () => {
  test("fails strictly below the threshold without rounding", () => {
    const at = { file: "a.ts", detected: 99, undetected: 1, score: 99 };
    const below = { file: "b.ts", detected: 989, undetected: 11, score: 98.9 };
    expect(judgeScores([at, below], 99)).toEqual({ passed: [at], failed: [below] });
  });

  test("every score lands in exactly one bucket", () => {
    fc.assert(
      fc.property(
        fc.array(fc.double({ min: 0, max: 100, noNaN: true }), { maxLength: 20 }),
        fc.double({ min: 0, max: 100, noNaN: true }),
        (values, threshold) => {
          const scores = values.map((score, i) => ({
            file: `f${i}.ts`,
            detected: 0,
            undetected: 0,
            score,
          }));
          const verdict = judgeScores(scores, threshold);
          return (
            verdict.passed.length + verdict.failed.length === scores.length &&
            verdict.passed.every((s) => s.score >= threshold) &&
            verdict.failed.every((s) => s.score < threshold)
          );
        },
      ),
      { seed: 20261106, numRuns: 200 },
    );
  });
});

describe("renderScore", () => {
  test("prints path, score and counts", () => {
    expect(renderScore({ file: "a.ts", detected: 3, undetected: 1, score: 75 })).toBe(
      "a.ts  75.00 % (3 detected, 1 survived)",
    );
  });
});
