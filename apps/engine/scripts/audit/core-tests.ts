import { isTestFile, pathVariants } from "./import-graph.ts";

const CORE_TEST = /(?:^|\/)core\.test\.ts$|\/core\/(?:.+\/)?[^/]+\.test\.ts$/;
const SHARED_TEST = /^packages\/shared\/src\/.+\.test\.ts$/;
const EXPLICIT_PURE_TESTS = new Set([
  "apps/cockpit/src/pages/audit-filter-state.test.ts",
  "apps/cockpit/src/pages/audit-labels.test.ts",
  "apps/cockpit/src/pages/knowledge-sources-url.test.ts",
  "apps/engine/src/workflows/draft-projection.test.ts",
  "apps/sk/src/domain/agent/agent-file.test.ts",
  "apps/sk/src/commands/workflow-file-model.test.ts",
  "packages/cli-core/src/errors-classification.test.ts",
  "packages/cli-core/src/format-render.test.ts",
  "packages/cli-core/src/pure-facades.public-contract.test.ts",
]);

export function selectCoreTests(paths: readonly string[]): string[] {
  const selected = paths.filter(
    (p) =>
      !p.includes("/node_modules/") &&
      (SHARED_TEST.test(p) ||
        (p.startsWith("apps/engine/src/") && CORE_TEST.test(p)) ||
        EXPLICIT_PURE_TESTS.has(p)),
  );
  return [...new Set(selected)].sort();
}

export function selectCanonicalCoreTests(
  candidates: readonly string[],
  targets: readonly string[],
  reverse: ReadonlyMap<string, ReadonlySet<string>>,
): string[] {
  const available = new Set(candidates);
  const selected = new Set(selectCoreTests(candidates));
  for (const target of targets) {
    for (const variant of pathVariants(target)) {
      for (const importer of reverse.get(variant) ?? []) {
        if (available.has(importer) && isTestFile(importer)) selected.add(importer);
      }
    }
  }
  return [...selected].sort();
}

export function parseShardArgs(
  argv: readonly string[],
):
  | { mode: "global"; passthrough: string[] }
  | { mode: "shard"; manifest: string; shard: string; passthrough: string[] }
  | { error: string } {
  const manifestIndex = argv.indexOf("--shard-manifest");
  if (manifestIndex === -1) return { mode: "global", passthrough: [...argv] };
  const manifest = argv[manifestIndex + 1];
  const shardIndex = argv.indexOf("--shard");
  const shard = shardIndex === -1 ? undefined : argv[shardIndex + 1];
  if (!manifest || !shard)
    return { error: "--shard-manifest requires --shard and both require values" };
  const passthrough = argv.filter(
    (_, index) =>
      index !== manifestIndex &&
      index !== manifestIndex + 1 &&
      index !== shardIndex &&
      index !== shardIndex + 1,
  );
  return { mode: "shard", manifest, shard, passthrough };
}

export function orderShardTests(
  paths: readonly string[],
  directTests: readonly string[] = [],
): string[] {
  const direct = new Set(directTests);
  return [...new Set(paths)].sort(
    (left, right) =>
      Number(direct.has(right)) - Number(direct.has(left)) || left.localeCompare(right),
  );
}

export async function runShardTests(
  paths: readonly string[],
  run: (path: string) => Promise<void>,
  fullClosure: boolean,
  directTests: readonly string[] = [],
): Promise<void> {
  let first: Error | undefined;
  for (const path of orderShardTests(paths, directTests)) {
    try {
      await run(path);
    } catch (error) {
      first ??= error instanceof Error ? error : new Error(String(error));
      if (!fullClosure) break;
    }
  }
  if (first) throw first;
}
