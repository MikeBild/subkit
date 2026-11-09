import {
  EXPLICIT_PURE_TARGET_PATHS,
  pureTargetPaths,
  reviewedExplicitPureTargetPaths,
} from "./pure-targets.ts";

export const PURE_MUTATION_TARGETS = EXPLICIT_PURE_TARGET_PATHS;

export const MUTATION_GLOBS = [
  "apps/engine/src/**/core.ts",
  "apps/engine/src/**/core/**/*.ts",
  ...reviewedExplicitPureTargetPaths(),
  "!**/*.test.ts",
  "!**/tests/**",
  "!**/__tests__/**",
  "!**/*.d.ts",
] as const;

export function expectedMutationScope(files: readonly string[]): string[] {
  return pureTargetPaths(files);
}

export function mutationGlobsMatch(value: unknown): boolean {
  return (
    Array.isArray(value) &&
    value.length === MUTATION_GLOBS.length &&
    value.every((entry, index) => entry === MUTATION_GLOBS[index])
  );
}
