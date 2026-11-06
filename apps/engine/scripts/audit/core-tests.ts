const CORE_TEST = /(?:^|\/)core\.test\.ts$|\/core\/(?:.+\/)?[^/]+\.test\.ts$/;
const SHARED_TEST = /^packages\/shared\/src\/.+\.test\.ts$/;
const EXCLUDED = ["apps/engine/src/llm/core/"];

export function selectCoreTests(paths: readonly string[]): string[] {
  const selected = paths.filter(
    (p) =>
      !p.includes("/node_modules/") &&
      !EXCLUDED.some((prefix) => p.startsWith(prefix)) &&
      (SHARED_TEST.test(p) || (p.startsWith("apps/engine/src/") && CORE_TEST.test(p))),
  );
  return [...new Set(selected)].sort();
}
