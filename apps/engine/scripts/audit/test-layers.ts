export const LAYERS = ["unit", "integration", "regression", "journey", "e2e", "docker"] as const;

export type Layer = (typeof LAYERS)[number];

export interface LayerRunner {
  mode: "grouped" | "isolated";
  timeoutMs: number;
  skipDocker: boolean;
  solo?: RegExp;
}

export const MODULE_MOCK = /\bmock\.module\(/;

export const RUNNERS: Readonly<Record<Layer, LayerRunner>> = {
  unit: { mode: "grouped", timeoutMs: 120_000, skipDocker: true, solo: MODULE_MOCK },
  integration: { mode: "isolated", timeoutMs: 120_000, skipDocker: false },
  regression: { mode: "grouped", timeoutMs: 120_000, skipDocker: true, solo: MODULE_MOCK },
  journey: { mode: "isolated", timeoutMs: 120_000, skipDocker: false },
  e2e: { mode: "isolated", timeoutMs: 120_000, skipDocker: false },
  docker: { mode: "isolated", timeoutMs: 600_000, skipDocker: false },
};

export const DB_MARKER =
  /\b(?:createTestDb|createHttpTestServer|SKIP_DOCKER|REQUIRES_PG|testcontainers)\b/;

const INTEGRATION_NAME = /\.(?:int|integration)\.test\.[jt]sx?$/;
const SUPPORT_PATH =
  /(?:^|\/)(?:tests|__tests__|test-helpers|journeys|_helpers)\/|(?:test-helpers?|_helpers|fixtures?|-fixture)\.[jt]sx?$/;

export function isLayer(value: string): value is Layer {
  return (LAYERS as readonly string[]).includes(value);
}

export function isSupportModule(path: string): boolean {
  return SUPPORT_PATH.test(path);
}

export function layerByPath(path: string): Layer | null {
  if (path.startsWith("tests/docker/")) return "docker";
  if (path.startsWith("tests/e2e/")) return "e2e";
  if (/(?:^|\/)journeys\//.test(path) || /\.journey\.test\.[jt]sx?$/.test(path)) return "journey";
  if (/\.regression\.test\.[jt]sx?$/.test(path)) return "regression";
  if (INTEGRATION_NAME.test(path)) return "integration";
  return null;
}

export interface LayerSource {
  text(path: string): string | null;
  imports(path: string): readonly string[];
}

export function dbBoundSupport(source: LayerSource, support: readonly string[]): Set<string> {
  const bound = new Set(support.filter((p) => DB_MARKER.test(source.text(p) ?? "")));
  const candidates = new Set(support);
  let grew = true;
  while (grew) {
    grew = false;
    for (const path of candidates) {
      if (bound.has(path)) continue;
      if (source.imports(path).some((target) => bound.has(target))) {
        bound.add(path);
        grew = true;
      }
    }
  }
  return bound;
}

export function classify(path: string, source: LayerSource, bound: ReadonlySet<string>): Layer {
  const byPath = layerByPath(path);
  if (byPath) return byPath;
  if (DB_MARKER.test(source.text(path) ?? "")) return "integration";
  if (source.imports(path).some((target) => bound.has(target))) return "integration";
  return "unit";
}

export function partition(
  tests: readonly string[],
  support: readonly string[],
  source: LayerSource,
): Record<Layer, string[]> {
  const bound = dbBoundSupport(source, support);
  const out = Object.fromEntries(LAYERS.map((layer) => [layer, [] as string[]])) as Record<
    Layer,
    string[]
  >;
  for (const path of [...new Set(tests)].sort()) out[classify(path, source, bound)].push(path);
  return out;
}

export function groupByRoot(files: readonly string[]): Array<{ root: string; files: string[] }> {
  const groups = new Map<string, string[]>();
  for (const file of files) {
    const parts = file.split("/");
    const root =
      parts[0] === "apps" || parts[0] === "packages"
        ? parts.slice(0, 2).join("/")
        : (parts[0] as string);
    const list = groups.get(root) ?? [];
    list.push(file);
    groups.set(root, list);
  }
  return [...groups.entries()]
    .sort(([a], [b]) => a.localeCompare(b))
    .map(([root, list]) => ({ root, files: list }));
}

export interface RunPlan {
  groups: Array<{ root: string; files: string[] }>;
  solo: string[];
}

export function planRuns(
  files: readonly string[],
  runner: LayerRunner,
  text: (path: string) => string | null,
): RunPlan {
  if (runner.mode === "isolated") return { groups: [], solo: [...files] };
  const pattern = runner.solo;
  const solo = pattern ? files.filter((file) => pattern.test(text(file) ?? "")) : [];
  const alone = new Set(solo);
  return { groups: groupByRoot(files.filter((file) => !alone.has(file))), solo };
}
