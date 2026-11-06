const CORE_TEST = /(?:^|\/)core\.test\.ts$|\/core\/(?:.+\/)?[^/]+\.test\.ts$/;
const SHARED_TEST = /^packages\/shared\/src\/.+\.test\.ts$/;

export function selectCoreTests(paths: readonly string[]): string[] {
  const selected = paths.filter(
    (p) =>
      !p.includes("/node_modules/") &&
      (SHARED_TEST.test(p) || (p.startsWith("apps/engine/src/") && CORE_TEST.test(p))),
  );
  return [...new Set(selected)].sort();
}
