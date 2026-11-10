import { expect, test } from "bun:test";
import { createHash } from "node:crypto";
import { type MutationEquivalent, nativeExactIgnoredMutant } from "../audit/mutation-floor.ts";
import {
  inspectMutationShardScore,
  summarizeMutationScores,
} from "../audit/mutation-shard-score.ts";

const source = "true;\nfalse;\n";
const file = "apps/engine/src/example/core.ts";
const digest = createHash("sha256").update(source).digest("hex");
const entries: MutationEquivalent[] = ["true", "false"].map((original, i) => ({
  file,
  source_sha256: digest,
  location: {
    start: { line: i + 1, column: 1 },
    end: { line: i + 1, column: original.length + 1 },
  },
  mutatorName: "BooleanLiteral",
  replacement: i === 0 ? "false" : "true",
  original,
  status: "Survived",
  statusReason: "",
  reason: "Fixture exact equivalence proof",
  independent_review: "Fixture independent equivalence review",
}));

function inspect(
  statuses: Array<"Ignored" | "Survived">,
  exitCode: number,
  tamperReason = false,
  nativeConfig = true,
) {
  const mutants = statuses.map((status, i) => ({
    ...nativeExactIgnoredMutant(entries[i]!),
    status,
    statusReason:
      status === "Survived"
        ? undefined
        : tamperReason
          ? "unreviewed"
          : nativeExactIgnoredMutant(entries[i]!).statusReason,
  }));
  return inspectMutationShardScore({
    report: {
      config: {
        mutator: { exactIgnoredMutants: nativeConfig ? entries.map(nativeExactIgnoredMutant) : [] },
      },
      files: { [file]: { source, mutants } },
    },
    exitCode,
    manifest: { version: 1, equivalents: entries },
    repo: "/repo",
    expectedScope: [file],
    sourceSha256ForFile: () => digest,
  });
}

test("native ignored exact equivalents retain conservative raw score and native zero exit", () => {
  const result = inspect(["Ignored", "Ignored"], 0);
  expect(result.errors).toEqual([]);
  expect(summarizeMutationScores(result.scores)).toMatchObject({
    raw_score: 0,
    adjusted_score: 100,
    raw_undetected: 2,
    equivalent_excluded: 2,
  });
  expect(inspect(["Ignored", "Ignored"], 1).errors.length).toBeGreaterThan(0);
  expect(inspect(["Ignored", "Ignored"], 0, false, false).errors.length).toBeGreaterThan(0);
  expect(inspect(["Survived", "Survived"], 1, false, false).errors).toEqual([]);
});

test("mixed reviewed survivors and native ignores retain native failure exit", () => {
  const result = inspect(["Survived", "Ignored"], 1);
  expect(result.errors).toEqual([]);
  expect(summarizeMutationScores(result.scores)).toMatchObject({
    raw_score: 0,
    adjusted_score: 100,
    raw_undetected: 2,
    equivalent_excluded: 2,
  });
  expect(inspect(["Survived", "Ignored"], 0).errors.length).toBeGreaterThan(0);
});

test("derived native ignore reason binds exact reviewed identity and rejects substituted reasons", () => {
  expect(inspect(["Ignored", "Ignored"], 0, true).errors.length).toBeGreaterThan(0);
  const original = nativeExactIgnoredMutant(entries[0]!);
  expect(original.statusReason).toMatch(/^subkit-reviewed-equivalence:[a-f0-9]{64}$/);
  expect(
    nativeExactIgnoredMutant({ ...entries[0]!, independent_review: "different proof" })
      .statusReason,
  ).not.toBe(original.statusReason);
  expect(entries[0]!.status).toBe("Survived");
});
