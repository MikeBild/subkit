import { describe, expect, test } from "bun:test";
import { createHash } from "node:crypto";
import fc from "fast-check";
import {
  judgeScores,
  normalizeReportPath,
  readBreakThreshold,
  readMutationEquivalentManifest,
  readReportPath,
  renderScore,
  scoreFiles,
  validateMutationEquivalents,
  validateMutationProvenance,
  validateMutationRunConfig,
  validateMutationThresholds,
} from "../audit/mutation-floor.ts";

const REPO = "/repo";

const sha256 = (value: string) => createHash("sha256").update(value).digest("hex");

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

describe("validateMutationThresholds", () => {
  test("requires the quality contract to pin every Stryker threshold at 100", () => {
    expect(validateMutationThresholds({ thresholds: { break: 100, high: 100, low: 100 } })).toEqual(
      [],
    );
    expect(validateMutationThresholds({ thresholds: { break: 0, high: 100, low: 100 } })).toEqual([
      "stryker.config.json thresholds.break must equal 100",
    ]);
    expect(validateMutationThresholds({ thresholds: { break: 100, high: 99, low: 0 } })).toEqual([
      "stryker.config.json thresholds.high must equal 100",
      "stryker.config.json thresholds.low must equal 100",
    ]);
  });
});

describe("validateMutationRunConfig", () => {
  const canonical = {
    thresholds: { break: 100, high: 100, low: 100 },
    testRunner: "command",
    commandRunner: { command: "bun run apps/engine/scripts/run-core-tests.ts" },
    incremental: false,
    coverageAnalysis: "off",
    mutator: { plugins: null, excludedMutations: [] },
  };

  test("requires matching, full-scope runner settings in both config and report", () => {
    expect(validateMutationRunConfig({ config: canonical, report: { config: canonical } })).toEqual(
      [],
    );
    expect(
      validateMutationRunConfig({
        config: {
          ...canonical,
          mutator: { plugins: null, excludedMutations: ["BlockStatement"] },
        },
        report: { config: canonical },
      }),
    ).toContain("stryker.config.json mutator.excludedMutations must be absent or []");
    expect(
      validateMutationRunConfig({
        config: canonical,
        report: {
          config: {
            ...canonical,
            mutator: { plugins: null, excludedMutations: ["BlockStatement"] },
          },
        },
      }),
    ).toContain("mutation report config mutator.excludedMutations must be absent or []");
    expect(
      validateMutationRunConfig({
        config: { ...canonical, excludedMutations: ["BlockStatement"] },
        report: { config: canonical },
      }),
    ).toContain("stryker.config.json top-level excludedMutations must be absent or []");
    expect(
      validateMutationRunConfig({
        config: { ...canonical, ignoreStatic: true },
        report: { config: canonical },
      }),
    ).toContain("stryker.config.json ignoreStatic must be absent or false");
  });

  test("rejects lowered thresholds and runner, command, incremental, or coverage overrides", () => {
    expect(
      validateMutationRunConfig({
        config: { ...canonical, thresholds: { ...canonical.thresholds, break: 0 } },
        report: { config: canonical },
      }),
    ).toContain("stryker.config.json thresholds.break must equal 100");
    const invalidReport = {
      ...canonical,
      testRunner: "vitest",
      commandRunner: { command: "bun test" },
      incremental: true,
      coverageAnalysis: "perTest",
    };
    expect(
      validateMutationRunConfig({ config: canonical, report: { config: invalidReport } }),
    ).toEqual([
      "mutation report config testRunner must equal command",
      "mutation report config commandRunner.command must equal the canonical core test command",
      "mutation report config incremental must equal false",
      "mutation report config coverageAnalysis must equal off",
    ]);
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
        "a/core.ts": ["Killed"],
      }),
      REPO,
    );
    expect(scores).toEqual([
      { file: "a/core.ts", detected: 1, undetected: 0, score: 100 },
      { file: "b/core.ts", detected: 2, undetected: 2, score: 50 },
    ]);
  });

  test("fails closed for ignored, broken or missing mutant states", () => {
    expect(scoreFiles(report({ "a.ts": ["Ignored"] }), REPO)).toEqual({
      error: "a.ts has non-terminal mutant status Ignored",
    });
    expect(scoreFiles({ files: { "a.ts": { mutants: [null] } } }, REPO)).toEqual({
      error: "a.ts has a mutant without a status",
    });
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
    const status = fc.constantFrom("Killed", "Timeout", "Survived", "NoCoverage");
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

describe("reviewed mutation equivalents", () => {
  const file = "apps/engine/src/example/core.ts";
  const source = "before\n{\n  return null;\n}\nafter\n";
  const location = {
    start: { line: 2, column: 1 },
    end: { line: 4, column: 2 },
  };
  const mutant = {
    status: "Ignored",
    mutatorName: "BlockStatement",
    replacement: "{}",
    statusReason: "reviewed equivalent",
    location,
  };
  const reportWith = (next = mutant, reportSource = source) => ({
    files: { [`${REPO}/${file}`]: { source: reportSource, mutants: [next] } },
  });
  const entry = (overrides: Record<string, unknown> = {}) => ({
    file,
    source_sha256: sha256(source),
    location,
    mutatorName: "BlockStatement",
    replacement: "{}",
    original: "{\n  return null;\n}",
    statusReason: "reviewed equivalent",
    reason: "The catch body only feeds a private fail-closed normalizer.",
    independent_review: "Reviewed against the public classifier output.",
    ...overrides,
  });
  const manifest = (entries: unknown[]) =>
    readMutationEquivalentManifest({ version: 1, equivalents: entries }, REPO);
  const validate = (
    entries: unknown[],
    next = mutant,
    currentHash = sha256(source),
    reportSource = source,
  ) => {
    const parsed = manifest(entries);
    if ("error" in parsed) throw new Error(parsed.error);
    return validateMutationEquivalents({
      report: reportWith(next, reportSource),
      manifest: parsed,
      repo: REPO,
      expectedScope: [file],
      sourceSha256ForFile: () => currentHash,
    });
  };

  test("accepts exactly one hash-bound ignored mutant and excludes it transparently", () => {
    const result = validate([entry()]);
    expect(result.errors).toEqual([]);
    expect(result.matches).toHaveLength(1);
    expect(
      scoreFiles(
        reportWith(),
        REPO,
        result.matches.map((match) => match.mutant),
      ),
    ).toEqual([{ file, detected: 0, undetected: 0, score: 100, equivalent_excluded: 1 }]);
  });

  test("fails closed for mismatched hashes, ranges, replacement, reason, status, and original", () => {
    expect(validate([entry()], mutant, "0".repeat(64)).errors).toContain(
      `equivalence manifest source hash does not match current file: ${file}`,
    );
    expect(validate([entry({ source_sha256: "1".repeat(64) })]).errors).toContain(
      `equivalence manifest source hash does not match current file: ${file}`,
    );
    expect(validate([entry()], mutant, sha256(source), `${source}// changed\n`).errors).toContain(
      `equivalence manifest source hash does not match report source: ${file}`,
    );
    expect(
      validate([
        entry({ location: { start: { line: 2, column: 2 }, end: { line: 4, column: 2 } } }),
      ]).errors,
    ).toContain(`equivalence manifest original does not match report source range: ${file}`);
    expect(validate([entry({ original: "return null" })]).errors).toContain(
      `equivalence manifest original does not match report source range: ${file}`,
    );
    expect(validate([entry({ replacement: "return {}" })]).errors).toContain(
      `equivalence manifest entry is not matched exactly once: ${file}`,
    );
    expect(validate([entry({ statusReason: "other" })]).errors).toContain(
      `equivalence manifest entry is not matched exactly once: ${file}`,
    );
    expect(validate([entry()], { ...mutant, status: "Killed" }).errors).toContain(
      `equivalence manifest entry is not matched exactly once: ${file}`,
    );
  });

  test("rejects unregistered ignored mutants, duplicates, unconsumed entries, and ordinary survivors", () => {
    expect(validate([]).errors).toEqual([`ignored mutant is not registered exactly: ${file}`]);
    expect(validate([entry(), entry()]).errors).toContain(
      `equivalence manifest has duplicate entry for ${file}`,
    );
    expect(validate([entry({ file: "packages/shared/src/outside.ts" })]).errors).toContain(
      "equivalence manifest file is outside the declared pure scope: packages/shared/src/outside.ts",
    );
    expect(validate([entry()], { ...mutant, status: "Survived" }).errors).toContain(
      `equivalence manifest entry is not matched exactly once: ${file}`,
    );
    const survivor = scoreFiles(reportWith({ ...mutant, status: "Survived" }), REPO);
    expect(survivor).toEqual([{ file, detected: 0, undetected: 1, score: 0 }]);
  });

  test("rejects whitespace-only proofs and non-canonical POSIX paths", () => {
    for (const file of [
      "./apps/engine/src/example/core.ts",
      "apps//engine/core.ts",
      "apps/a/../core.ts",
      "apps\\engine\\core.ts",
    ])
      expect(manifest([entry({ file })])).toEqual({
        error: "equivalence manifest entry 0 has a non-canonical file",
      });
    expect(manifest([entry({ reason: " \n\t", independent_review: "review" })])).toEqual({
      error: "equivalence manifest entry 0 is malformed",
    });
    expect(manifest([entry({ reason: "proof", independent_review: "  " })])).toEqual({
      error: "equivalence manifest entry 0 is malformed",
    });
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

describe("validateMutationProvenance", () => {
  const scope = ["apps/engine/src/example/core.ts"];
  const base = {
    report: {
      config: { mutate: ["apps/engine/src/**/core.ts"] },
      files: { "/repo/apps/engine/src/example/core.ts": { mutants: [] } },
    },
    receipt: {
      version: 1,
      created_at: "2026-11-08T00:00:00.000Z",
      config_sha256: "config",
      source_sha256: "source",
      test_sha256: "tests",
      canonical_target_count: 1,
      canonical_target_sha256: "canonical",
      scope,
    },
    expectedScope: scope,
    expectedMutate: ["apps/engine/src/**/core.ts"],
    configSha256: "config",
    sourceSha256: "source",
    testSha256: "tests",
    canonicalTargetCount: 1,
    canonicalTargetSha256: "canonical",
    repo: REPO,
  };

  test("accepts a report and receipt for the exact current source scope", () => {
    expect(validateMutationProvenance(base)).toEqual([]);
  });

  test("requires an explicit type-only audit scope when classification is supplied", () => {
    expect(
      validateMutationProvenance({
        ...base,
        expectedTypeOnlyScope: ["apps/engine/src/self-healing/core/patch-proposal.ts"],
      }).join("\n"),
    ).toContain("type-only scope");
  });

  test("rejects stale scope and changed config or source", () => {
    expect(
      validateMutationProvenance({
        ...base,
        report: { ...base.report, files: {} },
        receipt: {
          ...base.receipt,
          config_sha256: "old",
          source_sha256: "old",
          test_sha256: "old",
        },
      }),
    ).toEqual([
      "mutation report scope does not match the declared pure scope",
      "mutation receipt was prepared with a different Stryker config",
      "mutation source changed after the receipt was prepared",
      "mutation tests, runner or lockfile changed after the receipt was prepared",
    ]);
  });

  test("rejects a changed canonical target registry even when source paths remain the same", () => {
    expect(
      validateMutationProvenance({
        ...base,
        receipt: { ...base.receipt, canonical_target_count: 0, canonical_target_sha256: "old" },
      }),
    ).toEqual([
      "mutation canonical target count changed after the receipt was prepared",
      "mutation canonical target metadata changed after the receipt was prepared",
    ]);
  });

  test("rejects report-level errors instead of trusting a partial result", () => {
    expect(
      validateMutationProvenance({
        ...base,
        report: { ...base.report, errors: ["runner crashed"] },
      }),
    ).toEqual(["mutation report error: runner crashed"]);
  });

  test("rejects every defined top-level error field, including empty or malformed values", () => {
    for (const value of [{}, null, ""]) {
      expect(
        validateMutationProvenance({
          ...base,
          report: { ...base.report, error: value },
        }),
      ).not.toEqual([]);
    }
    expect(validateMutationProvenance({ ...base, report: { ...base.report, error: {} } })).toEqual([
      "mutation report error: mutation report error field is malformed",
    ]);
    expect(
      validateMutationProvenance({ ...base, report: { ...base.report, error: null } }),
    ).toEqual(["mutation report error: mutation report error field is malformed"]);
    expect(validateMutationProvenance({ ...base, report: { ...base.report, error: "" } })).toEqual([
      "mutation report error: ",
    ]);
  });
});
