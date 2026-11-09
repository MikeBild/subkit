import {
  type MutationEquivalentManifest,
  scoreFiles,
  validateMutationEquivalents,
} from "./mutation-floor.ts";

export function inspectMutationShardScore(input: {
  report: unknown;
  exitCode: number;
  manifest: MutationEquivalentManifest;
  repo: string;
  expectedScope: readonly string[];
  sourceSha256ForFile: (file: string) => string | null;
}) {
  const errors: string[] = [];
  const report = input.report as { error?: unknown; errors?: unknown } | null;
  if (
    !report ||
    report.error !== undefined ||
    (report.errors !== undefined && (!Array.isArray(report.errors) || report.errors.length > 0))
  )
    errors.push("mutation report has nonterminal errors");
  const equivalents = validateMutationEquivalents(input);
  errors.push(...equivalents.errors);
  const scores = scoreFiles(
    input.report,
    input.repo,
    equivalents.matches.map((match) => match.mutant),
  );
  if ("error" in scores) return { errors: [...errors, scores.error], scores: [] };
  const actual = scores.map((score) => score.file).sort();
  if (JSON.stringify(actual) !== JSON.stringify([...input.expectedScope].sort()))
    errors.push("mutation score scope does not match shard targets");
  for (const score of scores)
    if (score.score !== 100) errors.push(`score below 100: ${score.file}`);
  const equivalentSurvivors = equivalents.matches.filter(
    (match) => (match.mutant as { status?: unknown }).status === "Survived",
  ).length;
  const rawUndetected = scores.reduce((sum, score) => sum + score.raw_undetected, 0);
  const expectedExit = rawUndetected > 0 ? 1 : 0;
  if (
    input.exitCode !== expectedExit ||
    (input.exitCode === 1 && (equivalentSurvivors === 0 || equivalentSurvivors !== rawUndetected))
  )
    errors.push(`nonzero exit or raw score/exit mismatch: ${input.exitCode}`);
  return { errors, scores };
}

export function summarizeMutationScores(
  scores: readonly {
    detected: number;
    undetected: number;
    raw_detected: number;
    raw_undetected: number;
    equivalent_excluded?: number;
  }[],
) {
  const sum = (key: "detected" | "undetected" | "raw_detected" | "raw_undetected") =>
    scores.reduce((total, score) => total + score[key], 0);
  const ratio = (detected: number, undetected: number) =>
    detected + undetected === 0 ? 100 : (100 * detected) / (detected + undetected);
  return {
    raw_score: ratio(sum("raw_detected"), sum("raw_undetected")),
    adjusted_score: ratio(sum("detected"), sum("undetected")),
    raw_detected: sum("raw_detected"),
    raw_undetected: sum("raw_undetected"),
    detected: sum("detected"),
    undetected: sum("undetected"),
    equivalent_excluded: scores.reduce(
      (total, score) => total + (score.equivalent_excluded ?? 0),
      0,
    ),
  };
}
