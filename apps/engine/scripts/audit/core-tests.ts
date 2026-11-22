import { isTestFile, pathVariants } from "./import-graph.ts";

const CORE_TEST = /(?:^|\/)core\.test\.ts$|\/core\/(?:.+\/)?[^/]+\.test\.ts$/;
const SHARED_TEST = /^packages\/shared\/src\/.+\.test\.ts$/;
const EXPLICIT_PURE_TESTS = new Set([
  "apps/cockpit/src/features/audit/model/audit-filter-state.test.ts",
  "apps/cockpit/src/features/audit/model/audit-labels.test.ts",
  "apps/cockpit/src/features/knowledge/api/knowledge-source-request.test.ts",
  "apps/engine/src/workflows/draft-projection.test.ts",
  "apps/subkit/src/domain/agent/agent-file.test.ts",
  "apps/subkit/src/commands/workflow-file-model.test.ts",
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

export interface ShardTestHistoryEntry {
  kills: number;
  runs: number;
  totalMs: number;
}

export type ShardTestHistory = ReadonlyMap<string, ShardTestHistoryEntry>;

const MIN_HISTORY_DURATION_MS = 200;

export interface MutantTestDeadlinePolicy {
  factor: number;
  floor_ms: number;
}

export type TestBaselines = ReadonlyMap<string, number>;

export function parseTestBaselines(text: string): Map<string, number> {
  const baselines = new Map<string, number>();
  for (const line of text.split("\n")) {
    if (line === "") continue;
    let value: unknown;
    try {
      value = JSON.parse(line);
    } catch {
      continue;
    }
    if (!value || typeof value !== "object") continue;
    const { t, ms, f } = value as { t?: unknown; ms?: unknown; f?: unknown };
    if (typeof t !== "string" || !Number.isSafeInteger(ms) || (ms as number) < 0 || f !== 0)
      continue;
    baselines.set(t, Math.max(baselines.get(t) ?? 0, ms as number));
  }
  return baselines;
}

export function mutantTestDeadlineMs(
  baselineMs: number | undefined,
  policy: MutantTestDeadlinePolicy | undefined,
): number | undefined {
  if (baselineMs === undefined || policy === undefined) return undefined;
  return Math.max(policy.floor_ms, baselineMs * policy.factor);
}

export function formatDeadlineKill(kill: {
  mutant: string;
  test: string;
  deadlineMs: number;
  baselineMs: number;
}): string {
  return `${JSON.stringify({
    mutant: kill.mutant,
    test: kill.test,
    deadline_ms: kill.deadlineMs,
    baseline_ms: kill.baselineMs,
  })}\n`;
}

export function countDeadlineKills(text: string): number {
  const mutants = new Set<string>();
  for (const line of text.split("\n")) {
    if (line === "") continue;
    const value = JSON.parse(line) as { mutant?: unknown };
    if (typeof value.mutant !== "string" || !/^\d+$/.test(value.mutant))
      throw new Error("deadline kill ledger entry is malformed");
    mutants.add(value.mutant);
  }
  return mutants.size;
}

export function formatShardTestObservation(observation: {
  test: string;
  durationMs: number;
  failed: boolean;
}): string {
  return `${JSON.stringify({
    t: observation.test,
    ms: Math.max(0, Math.round(observation.durationMs)),
    f: observation.failed ? 1 : 0,
  })}\n`;
}

export function parseShardTestHistory(text: string): Map<string, ShardTestHistoryEntry> {
  const history = new Map<string, ShardTestHistoryEntry>();
  for (const line of text.split("\n")) {
    if (line === "") continue;
    let value: unknown;
    try {
      value = JSON.parse(line);
    } catch {
      continue;
    }
    if (!value || typeof value !== "object") continue;
    const { t, ms, f } = value as { t?: unknown; ms?: unknown; f?: unknown };
    if (typeof t !== "string" || !Number.isSafeInteger(ms) || (ms as number) < 0) continue;
    if (f !== 0 && f !== 1) continue;
    const entry = history.get(t) ?? { kills: 0, runs: 0, totalMs: 0 };
    entry.kills += f;
    entry.runs += 1;
    entry.totalMs += ms as number;
    history.set(t, entry);
  }
  return history;
}

function killRate(entry: ShardTestHistoryEntry | undefined): number {
  if (!entry || entry.kills === 0) return 0;
  return entry.kills / Math.max(entry.totalMs / entry.runs, MIN_HISTORY_DURATION_MS);
}

export type ShardTestDistances = ReadonlyMap<string, number>;

const UNKNOWN_IMPORT_DISTANCE = Number.MAX_SAFE_INTEGER;

export function shardTestImportDistance(rationale: string): number | undefined {
  const match = /\(depth (\d+)\)$/.exec(rationale);
  if (!match) return undefined;
  const distance = Number(match[1]);
  return Number.isSafeInteger(distance) ? distance : undefined;
}

export function selectShardMutationTests<
  T extends { path: string; kind: string; rationale: string },
>(tests: readonly T[], radius: number | undefined): T[] {
  if (radius === undefined) return [...tests];
  if (!Number.isSafeInteger(radius) || radius < 1)
    throw new Error("Mutation test radius must be a positive safe integer");
  return tests.filter((test) => {
    if (test.kind !== "reverse_import") return true;
    const distance = shardTestImportDistance(test.rationale);
    return distance === undefined || distance <= radius;
  });
}

export const ACTIVE_MUTANT_ENV = "__STRYKER_ACTIVE_MUTANT__";

export function activeMutantTarget(
  targets: readonly string[],
  readText: (path: string) => string | null,
  mutantId: string | undefined,
): string | undefined {
  if (mutantId === undefined || !/^\d+$/.test(mutantId)) return undefined;
  const marker = new RegExp(`stryMutAct_[0-9a-z]+\\("${mutantId}"\\)`);
  const owners = targets.filter((target) => marker.test(readText(target) ?? ""));
  return owners.length === 1 ? owners[0] : undefined;
}

export function orderShardTests(
  paths: readonly string[],
  directTests: readonly string[] = [],
  history: ShardTestHistory = new Map(),
  distances: ShardTestDistances = new Map(),
  targetHistory: ShardTestHistory = new Map(),
): string[] {
  const direct = new Set(directTests);
  const distance = (path: string) => distances.get(path) ?? UNKNOWN_IMPORT_DISTANCE;
  return [...new Set(paths)].sort(
    (left, right) =>
      killRate(targetHistory.get(right)) - killRate(targetHistory.get(left)) ||
      killRate(history.get(right)) - killRate(history.get(left)) ||
      Number(direct.has(right)) - Number(direct.has(left)) ||
      distance(left) - distance(right) ||
      left.localeCompare(right),
  );
}

export async function runShardTests(
  paths: readonly string[],
  run: (path: string) => Promise<void>,
  fullClosure: boolean,
  directTests: readonly string[] = [],
  history: ShardTestHistory = new Map(),
  distances: ShardTestDistances = new Map(),
  targetHistory: ShardTestHistory = new Map(),
): Promise<void> {
  let first: Error | undefined;
  for (const path of orderShardTests(paths, directTests, history, distances, targetHistory)) {
    try {
      await run(path);
    } catch (error) {
      first ??= error instanceof Error ? error : new Error(String(error));
      if (!fullClosure) break;
    }
  }
  if (first) throw first;
}
