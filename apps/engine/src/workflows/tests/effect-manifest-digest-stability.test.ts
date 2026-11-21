import { describe, expect, test } from "bun:test";
import { readFileSync } from "node:fs";
import { projectBoundaryGrowth } from "../core/authority-inheritance.ts";
import { compileWorkflowEffectManifest, type WorkflowEffectManifest } from "../effect-manifest.ts";

interface Corpus {
  manifests: { input: unknown; digest: string }[];
  growth: {
    granted: WorkflowEffectManifest;
    next: WorkflowEffectManifest;
    growth: unknown[];
    relaxed: [string, string[]][];
  }[];
}

const corpus = JSON.parse(
  readFileSync(
    new URL("./digest-fixtures/effect-manifest-digest-corpus.json", import.meta.url),
    "utf8",
  ),
) as Corpus;

describe("every approved manifest shape keeps its digest byte for byte", () => {
  test("the corpus holds the manifests the existing compiler tests produce", () => {
    expect(corpus.manifests.length).toBe(229);
    expect(corpus.growth.length).toBe(64);
    const drivers = new Set(
      corpus.manifests.flatMap(({ input }) =>
        ((input as { bindings?: { driver: string }[] }).bindings ?? []).map((b) => b.driver),
      ),
    );
    expect([...drivers].sort()).toEqual(["graphql", "http", "mcp", "postgres", "s3"]);
  });

  test("recompiling each recorded input yields the recorded digest", () => {
    const moved = corpus.manifests.filter(
      ({ input, digest }) => compileWorkflowEffectManifest(input).digest !== digest,
    );
    expect(moved.map(({ digest }) => digest)).toEqual([]);
  });

  test("no recorded manifest names a device", () => {
    for (const { input } of corpus.manifests) {
      const compiled = compileWorkflowEffectManifest(input).manifest;
      expect(compiled.effects.some((effect) => "device" in effect)).toBe(false);
    }
  });

  test("growth between recorded manifests stays the same", () => {
    for (const pair of corpus.growth) {
      const projected = projectBoundaryGrowth(pair.granted, pair.next);
      expect(JSON.parse(JSON.stringify(projected.growth))).toEqual(pair.growth);
      expect([...projected.relaxed]).toEqual(pair.relaxed);
    }
  });
});
