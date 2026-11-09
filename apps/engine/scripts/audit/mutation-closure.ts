import {
  buildReverseGraph,
  isTestFile,
  parseTsconfigPaths,
  pathVariants,
  selectAffected,
} from "./import-graph.ts";
import type { WaveConsumer, WaveTest } from "./mutation-wave.ts";

export interface ReviewedClosure {
  tests: WaveTest[];
  consumers: WaveConsumer[];
}

export interface ClosureAnalysis {
  files: readonly string[];
  testFiles: readonly string[];
  readText: (path: string) => string | null;
  reverse: ReturnType<typeof buildReverseGraph>;
}

export function createClosureAnalysis(input: {
  files: readonly string[];
  readText: (path: string) => string | null;
  tsconfig: string;
  cockpitTsconfig: string;
  onGraphBuilt?: () => void;
}): ClosureAnalysis {
  const cache = new Map<string, string | null>();
  const readText = (path: string) => {
    if (!cache.has(path)) cache.set(path, input.readText(path));
    return cache.get(path) ?? null;
  };
  const testFiles = input.files.filter(isTestFile);
  const files = new Set(input.files);
  const reverse = buildReverseGraph(
    input.files,
    readText,
    [
      parseTsconfigPaths("", input.tsconfig),
      parseTsconfigPaths("apps/cockpit", input.cockpitTsconfig),
    ],
    (path) => files.has(path),
    { includeTypeOnly: false },
  );
  input.onGraphBuilt?.();
  return { files: input.files, testFiles, readText, reverse };
}

export function reviewedClosurePlanFromAnalysis(
  analysis: ClosureAnalysis,
  input: { targets: readonly string[]; declared: readonly WaveTest[] },
): ReviewedClosure {
  const inferred = new Map<string, WaveTest>();
  for (const target of input.targets) {
    const selected = selectAffected({
      changed: [target],
      testFiles: analysis.testFiles,
      reverse: analysis.reverse,
      depth: Number.POSITIVE_INFINITY,
      testText: (path) => analysis.readText(path) ?? "",
    });
    for (const path of selected.tests) {
      const previous = inferred.get(path);
      const direct = pathVariants(target).some((variant) =>
        analysis.reverse.get(variant)?.has(path),
      );
      const kind = direct || previous?.kind === "direct" ? "direct" : "reverse_import";
      const covered =
        kind === "direct"
          ? [
              ...(previous?.kind === "direct" ? previous.covers_targets : []),
              ...(direct ? [target] : []),
            ]
          : [...(previous?.covers_targets ?? []), target];
      inferred.set(path, {
        path,
        kind,
        covers_targets: [...new Set(covered)].sort(),
        rationale: selected.reasons.get(path) ?? "reverse import closure",
      });
    }
  }
  for (const declared of input.declared) {
    const previous = inferred.get(declared.path);
    inferred.set(
      declared.path,
      previous
        ? {
            ...declared,
            covers_targets: [
              ...new Set([...previous.covers_targets, ...declared.covers_targets]),
            ].sort(),
          }
        : declared,
    );
  }
  const tests = [...inferred.values()].sort((left, right) => left.path.localeCompare(right.path));
  const consumers = new Set<string>();
  const frontier = input.targets.flatMap(pathVariants);
  const seen = new Set(frontier);
  while (frontier.length > 0) {
    const current = frontier.shift()!;
    for (const importer of analysis.reverse.get(current) ?? []) {
      if (!isTestFile(importer) && !importer.startsWith("tests/")) consumers.add(importer);
      for (const variant of pathVariants(importer))
        if (!seen.has(variant)) {
          seen.add(variant);
          frontier.push(variant);
        }
    }
  }
  return {
    tests,
    consumers: [...consumers].sort().map((path) => {
      const reachable = new Set(pathVariants(path));
      const pending = [...reachable];
      const witnesses = new Set<string>();
      while (pending.length > 0) {
        for (const importer of analysis.reverse.get(pending.pop()!) ?? []) {
          if (isTestFile(importer)) witnesses.add(importer);
          for (const variant of pathVariants(importer)) {
            if (reachable.has(variant)) continue;
            reachable.add(variant);
            pending.push(variant);
          }
        }
      }
      return { path, witnesses: [...witnesses].sort() };
    }),
  };
}

export function reviewedClosurePlan(input: {
  targets: readonly string[];
  files: readonly string[];
  readText: (path: string) => string | null;
  tsconfig: string;
  cockpitTsconfig: string;
  declared: readonly WaveTest[];
}): ReviewedClosure {
  return reviewedClosurePlanFromAnalysis(createClosureAnalysis(input), {
    targets: input.targets,
    declared: input.declared,
  });
}

export function reviewedClosure(input: Parameters<typeof reviewedClosurePlan>[0]): WaveTest[] {
  return reviewedClosurePlan(input).tests;
}
