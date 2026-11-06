import { basename, dirname, join, normalize } from "node:path/posix";
import ts from "typescript";
import { collectImports, resolveImport, resolveRepoPath } from "./imports.ts";

export interface AliasRule {
  pattern: string;
  targets: readonly string[];
}

export interface AliasScope {
  dir: string;
  rules: readonly AliasRule[];
}

const TEST_FILE = /\.(?:test|spec)\.(?:ts|tsx|js|jsx)$/;

export function isTestFile(path: string): boolean {
  return TEST_FILE.test(path);
}

export function parseTsconfigPaths(dir: string, text: string): AliasScope {
  const parsed = ts.parseConfigFileTextToJson("tsconfig.json", text);
  const paths = (parsed.config as { compilerOptions?: { paths?: unknown } } | undefined)
    ?.compilerOptions?.paths;
  const rules: AliasRule[] = [];
  if (paths && typeof paths === "object") {
    for (const [pattern, targets] of Object.entries(paths as Record<string, unknown>)) {
      if (!Array.isArray(targets)) continue;
      rules.push({
        pattern,
        targets: targets.filter((t): t is string => typeof t === "string"),
      });
    }
  }
  return { dir, rules };
}

function scopeFor(from: string, scopes: readonly AliasScope[]): AliasScope | undefined {
  let best: AliasScope | undefined;
  for (const scope of scopes) {
    const inside = scope.dir === "" || from.startsWith(`${scope.dir}/`);
    if (inside && (!best || scope.dir.length > best.dir.length)) best = scope;
  }
  return best;
}

function matchRule(specifier: string, rule: AliasRule): string | null {
  const star = rule.pattern.indexOf("*");
  if (star === -1) return specifier === rule.pattern ? "" : null;
  const prefix = rule.pattern.slice(0, star);
  const suffix = rule.pattern.slice(star + 1);
  if (!specifier.startsWith(prefix) || !specifier.endsWith(suffix)) return null;
  if (specifier.length < prefix.length + suffix.length) return null;
  return specifier.slice(prefix.length, specifier.length - suffix.length);
}

export function resolveSpecifier(
  from: string,
  specifier: string,
  scopes: readonly AliasScope[],
  exists: (repoPath: string) => boolean,
): string {
  if (specifier.startsWith(".")) return resolveImport(from, specifier, exists);
  const scope = scopeFor(from, scopes);
  if (!scope) return specifier;
  let best: { rule: AliasRule; rest: string } | undefined;
  for (const rule of scope.rules) {
    const rest = matchRule(specifier, rule);
    if (rest === null) continue;
    if (!best || rule.pattern.length > best.rule.pattern.length) best = { rule, rest };
  }
  if (!best) return specifier;
  const candidates = best.rule.targets.map((target) =>
    resolveRepoPath(normalize(join(scope.dir, target.replace("*", best.rest))), exists),
  );
  return candidates.find((c) => exists(c)) ?? candidates[0] ?? specifier;
}

type ReverseGraph = ReadonlyMap<string, ReadonlySet<string>>;

export function buildReverseGraph(
  files: readonly string[],
  readText: (repoPath: string) => string | null,
  scopes: readonly AliasScope[],
  exists: (repoPath: string) => boolean,
): ReverseGraph {
  const out = new Map<string, Set<string>>();
  for (const file of files) {
    const text = readText(file);
    if (text === null) continue;
    for (const ref of collectImports(file, text)) {
      const target = resolveSpecifier(file, ref.specifier, scopes, exists);
      let importers = out.get(target);
      if (!importers) {
        importers = new Set();
        out.set(target, importers);
      }
      importers.add(file);
    }
  }
  return out;
}

const SOURCE_EXTENSION = /\.(?:ts|tsx|mts|cts|js|jsx|mjs|cjs)$/;

export function pathVariants(path: string): string[] {
  const out = new Set([path]);
  if (SOURCE_EXTENSION.test(path)) {
    const bare = path.replace(SOURCE_EXTENSION, "");
    out.add(bare);
    if (basename(bare) === "index") out.add(dirname(bare));
  }
  return [...out];
}

function stemOf(path: string): string {
  return basename(path).replace(/\.[^.]+$/, "");
}

export function colocatedTests(module: string, testFiles: readonly string[]): string[] {
  const dir = dirname(module);
  const stem = stemOf(module);
  const dirs = new Set([dir, `${dir}/tests`, `${dir}/__tests__`]);
  return testFiles.filter(
    (t) => t !== module && dirs.has(dirname(t)) && basename(t).startsWith(`${stem}.`),
  );
}

interface Selection {
  tests: string[];
  reasons: Map<string, string>;
}

export function sourceReferenceKey(path: string): string {
  const parts = path.split("/");
  const base = parts.at(-1) ?? path;
  return base === "index.ts" || base === "index.tsx" ? parts.slice(-2).join("/") : base;
}

export function referencesSource(testText: string, path: string): boolean {
  const key = sourceReferenceKey(path).replace(/[.*+?^${}()|[\]\\]/g, "\\$&");
  return new RegExp(`["'\`/]${key}["'\`]`).test(testText);
}

export function selectAffected(input: {
  changed: readonly string[];
  testFiles: readonly string[];
  reverse: ReverseGraph;
  depth: number;
  testText?: (test: string) => string;
}): Selection {
  const tests = new Set(input.testFiles);
  const reasons = new Map<string, string>();
  const add = (test: string, reason: string) => {
    if (tests.has(test) && !reasons.has(test)) reasons.set(test, reason);
  };
  for (const path of input.changed) {
    if (isTestFile(path)) add(path, "changed");
    else for (const t of colocatedTests(path, input.testFiles)) add(t, `colocated with ${path}`);
  }
  if (input.testText) {
    const sources = input.changed.filter((path) => !isTestFile(path));
    for (const test of input.testFiles) {
      const text = input.testText(test);
      for (const path of sources)
        if (referencesSource(text, path)) add(test, `reads ${path} as text`);
    }
  }
  let frontier = new Map<string, string>();
  for (const path of input.changed) for (const v of pathVariants(path)) frontier.set(v, path);
  const seen = new Set(frontier.keys());
  for (let level = 1; level <= input.depth && frontier.size > 0; level += 1) {
    const next = new Map<string, string>();
    for (const [target, origin] of frontier) {
      for (const importer of input.reverse.get(target) ?? []) {
        add(importer, `imports ${origin} (depth ${level})`);
        for (const v of pathVariants(importer)) {
          if (seen.has(v)) continue;
          seen.add(v);
          next.set(v, origin);
        }
      }
    }
    frontier = next;
  }
  return { tests: [...reasons.keys()].sort(), reasons };
}

export interface RunOutcome {
  file: string;
  exitCode: number;
  output: string;
}

export async function runPool<T, R>(
  items: readonly T[],
  workers: number,
  run: (item: T) => Promise<R>,
): Promise<R[]> {
  const results: R[] = new Array(items.length);
  let next = 0;
  const lane = async () => {
    while (next < items.length) {
      const index = next;
      next += 1;
      results[index] = await run(items[index] as T);
    }
  };
  await Promise.all(Array.from({ length: Math.max(1, Math.min(workers, items.length)) }, lane));
  return results;
}

interface AffectedArgs {
  list: boolean;
  depth: number;
  workers: number;
  range: string | null;
}

export function parseAffectedArgs(
  argv: readonly string[],
  env: Readonly<Record<string, string | undefined>>,
): AffectedArgs | { error: string } {
  const workersRaw = env.SUBKIT_TEST_WORKERS ?? "4";
  const out: AffectedArgs = { list: false, depth: 2, workers: Number(workersRaw), range: null };
  for (let i = 0; i < argv.length; i += 1) {
    const arg = argv[i] as string;
    if (arg === "--list") out.list = true;
    else if (arg === "--depth" || arg === "--workers") {
      const value = Number(argv[i + 1]);
      if (!Number.isInteger(value) || value < (arg === "--depth" ? 0 : 1)) {
        return {
          error: `${arg} needs ${arg === "--depth" ? "a non-negative" : "a positive"} integer`,
        };
      }
      if (arg === "--depth") out.depth = value;
      else out.workers = value;
      i += 1;
    } else if (arg.startsWith("--")) return { error: `unknown option: ${arg}` };
    else if (out.range === null) out.range = arg;
    else return { error: `unexpected argument: ${arg}` };
  }
  if (!Number.isInteger(out.workers) || out.workers < 1) {
    return { error: "SUBKIT_TEST_WORKERS must be a positive integer" };
  }
  return out;
}

export function diffArgs(range: string | null): string[] {
  return range === null ? ["diff", "--name-only", "HEAD"] : ["diff", "--name-only", range];
}

export function summarize(outcomes: readonly RunOutcome[]): { text: string; failed: number } {
  const failed = outcomes.filter((o) => o.exitCode !== 0);
  const lines = [`${outcomes.length - failed.length} passed, ${failed.length} failed`];
  for (const f of failed) lines.push(`  FAIL ${f.file} (exit ${f.exitCode})`);
  return { text: lines.join("\n"), failed: failed.length };
}
