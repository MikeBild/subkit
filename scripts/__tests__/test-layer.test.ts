import { describe, expect, test } from "bun:test";
import { execFileSync } from "node:child_process";
import { existsSync } from "node:fs";
import path from "node:path";
import { loadTestLayers } from "../../apps/engine/scripts/audit/test-layer-source.ts";
import { LAYERS } from "../../apps/engine/scripts/audit/test-layers.ts";

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
