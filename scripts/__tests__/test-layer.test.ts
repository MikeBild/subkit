import { describe, expect, test } from "bun:test";
import { execFileSync } from "node:child_process";
import { existsSync } from "node:fs";
import path from "node:path";
import { loadTestLayers, readRepoText } from "../../apps/engine/scripts/audit/test-layer-source.ts";
import {
  LAYERS,
  MODULE_MOCK,
  planRuns,
  RUNNERS,
} from "../../apps/engine/scripts/audit/test-layers.ts";

const REPO = path.resolve(import.meta.dir, "..", "..");
const PATTERNS = ["test", "spec"].flatMap((kind) =>
  ["ts", "tsx", "js", "jsx"].map((ext) => new Bun.Glob(`**/*.${kind}.${ext}`)),
);

function universe(): string[] {
  return execFileSync("git", ["ls-files", "--cached", "--others", "--exclude-standard"], {
    cwd: REPO,
    encoding: "utf8",
    maxBuffer: 64 * 1024 * 1024,
  })
    .split("\n")
    .filter(
      (f) =>
        f &&
        !/(?:^|\/)(?:node_modules|dist)\//.test(f) &&
        PATTERNS.some((g) => g.match(f)) &&
        existsSync(path.join(REPO, f)),
    )
    .sort();
}

describe("test layers on the repository", () => {
  const layers = loadTestLayers(REPO);
  const all = universe();

  test("every test file lands in exactly one layer (no orphans, no overlaps)", () => {
    const placed = LAYERS.flatMap((layer) => layers[layer]);
    const counts = new Map<string, number>();
    for (const file of placed) counts.set(file, (counts.get(file) ?? 0) + 1);
    expect(all.filter((f) => counts.get(f) !== 1)).toEqual([]);
    expect(placed.filter((f) => !all.includes(f))).toEqual([]);
  });

  test("unit and integration cover every test outside the dedicated layers", () => {
    const dedicated = new Set([
      ...layers.regression,
      ...layers.journey,
      ...layers.e2e,
      ...layers.docker,
    ]);
    const inner = new Set([...layers.unit, ...layers.integration]);
    expect(all.filter((f) => !dedicated.has(f) && !inner.has(f))).toEqual([]);
  });

  test("the unit layer holds no regression, integration-named or DB-backed tests", () => {
    expect(
      layers.unit.filter((f) => /\.(?:regression|int|integration|journey)\.test\./.test(f)),
    ).toEqual([]);
    expect(layers.unit).not.toContain("apps/engine/src/db/tests/setup.ts");
  });
});

describe("run plan", () => {
  const texts: Record<string, string> = {
    "apps/engine/a.test.ts": 'mock.module("pg", () => ({}));',
    "apps/engine/b.test.ts": "expect(1).toBe(1);",
    "apps/sk/c.test.ts": "const mocked = mock(() => 1);",
    "scripts/d.test.ts": "mock.module('./x', () => ({}));",
  };
  const files = Object.keys(texts);
  const text = (file: string) => texts[file] ?? null;

  test("grouped layers run module-mocking files alone and group the rest by root", () => {
    expect(planRuns(files, RUNNERS.unit, text)).toEqual({
      groups: [
        { root: "apps/engine", files: ["apps/engine/b.test.ts"] },
        { root: "apps/sk", files: ["apps/sk/c.test.ts"] },
      ],
      solo: ["apps/engine/a.test.ts", "scripts/d.test.ts"],
    });
  });

  test("a grouped layer without a solo pattern groups every file", () => {
    const runner = { mode: "grouped" as const, timeoutMs: 1, skipDocker: true };
    const plan = planRuns(files, runner, () => null);
    expect(plan.solo).toEqual([]);
    expect(plan.groups.flatMap((group) => group.files).sort()).toEqual([...files].sort());
  });

  test("isolated layers run every file alone", () => {
    expect(planRuns(files, RUNNERS.integration, text)).toEqual({ groups: [], solo: files });
  });

  test("an unreadable file stays grouped", () => {
    expect(planRuns(["apps/engine/gone.test.ts"], RUNNERS.unit, () => null).solo).toEqual([]);
  });

  test("every unit file that swaps a module runs in its own process", () => {
    const unit = loadTestLayers(REPO).unit;
    const read = (file: string) => readRepoText(REPO, file);
    const plan = planRuns(unit, RUNNERS.unit, read);
    const mocking = unit.filter((file) => MODULE_MOCK.test(read(file) ?? ""));
    expect(mocking.length).toBeGreaterThan(0);
    expect(plan.solo).toEqual(mocking);
    const grouped = plan.groups.flatMap((group) => group.files);
    expect(grouped.filter((file) => MODULE_MOCK.test(read(file) ?? ""))).toEqual([]);
    expect([...grouped, ...plan.solo].sort()).toEqual([...unit].sort());
  });
});
