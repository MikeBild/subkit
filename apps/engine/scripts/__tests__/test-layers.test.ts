import { describe, expect, test } from "bun:test";
import fc from "fast-check";
import {
  classify,
  dbBoundSupport,
  groupByRoot,
  isLayer,
  isSupportModule,
  LAYERS,
  type LayerSource,
  layerByPath,
  partition,
  RUNNERS,
} from "../audit/test-layers.ts";

const sourceOf = (
  texts: Record<string, string>,
  imports: Record<string, string[]> = {},
): LayerSource => ({
  text: (p) => texts[p] ?? null,
  imports: (p) => imports[p] ?? [],
});

describe("layerByPath", () => {
  test("routes by location and suffix", () => {
    expect(layerByPath("tests/docker/a.docker.test.ts")).toBe("docker");
    expect(layerByPath("tests/e2e/a.e2e.test.ts")).toBe("e2e");
    expect(layerByPath("apps/engine/src/tests/journeys/01-a.journey.test.ts")).toBe("journey");
    expect(layerByPath("apps/engine/src/x/a.journey.test.ts")).toBe("journey");
    expect(layerByPath("apps/sk/src/a.regression.test.tsx")).toBe("regression");
    expect(layerByPath("apps/engine/src/a.int.test.ts")).toBe("integration");
    expect(layerByPath("apps/engine/src/a.integration.test.ts")).toBe("integration");
    expect(layerByPath("apps/engine/src/a-regression.test.ts")).toBeNull();
    expect(layerByPath("apps/engine/src/a.test.ts")).toBeNull();
  });
});

describe("isSupportModule and isLayer", () => {
  test("recognises test support modules", () => {
    expect(isSupportModule("apps/engine/src/db/tests/setup.ts")).toBe(true);
    expect(isSupportModule("apps/engine/src/test-helpers/seed.ts")).toBe(true);
    expect(isSupportModule("apps/engine/src/tools/tests/_helpers.ts")).toBe(true);
    expect(isSupportModule("apps/engine/src/auth/oauth/mcp-oauth-test-helpers.ts")).toBe(true);
    expect(isSupportModule("apps/engine/src/tests/object-store-fixture.ts")).toBe(true);
    expect(isSupportModule("apps/engine/src/env.ts")).toBe(false);
  });

  test("accepts only known layers", () => {
    expect(LAYERS.every(isLayer)).toBe(true);
    expect(isLayer("smoke")).toBe(false);
  });
});

describe("dbBoundSupport and classify", () => {
  const source = sourceOf(
    {
      "db/tests/setup.ts": "export async function createTestDb() {}",
      "x/tests/setup.ts": "import { createTestDb } from '../../db/tests/setup.ts';",
      "y/tests/deep.ts": "import '../../x/tests/setup.ts';",
      "z/tests/pure.ts": "export const a = 1;",
      "a.test.ts": "import '../z/tests/pure.ts';",
      "b.test.ts": "const skip = process.env.SKIP_DOCKER === '1';",
      "c.test.ts": "import '../y/tests/deep.ts';",
    },
    {
      "x/tests/setup.ts": ["db/tests/setup.ts"],
      "y/tests/deep.ts": ["x/tests/setup.ts"],
      "a.test.ts": ["z/tests/pure.ts"],
      "c.test.ts": ["y/tests/deep.ts"],
    },
  );
  const support = [
    "db/tests/setup.ts",
    "x/tests/setup.ts",
    "y/tests/deep.ts",
    "z/tests/pure.ts",
    "gone.ts",
  ];

  test("propagates DB markers through support imports", () => {
    expect([...dbBoundSupport(source, support)].sort()).toEqual([
      "db/tests/setup.ts",
      "x/tests/setup.ts",
      "y/tests/deep.ts",
    ]);
  });

  test("classifies by path first, then markers, then bound imports", () => {
    const bound = dbBoundSupport(source, support);
    expect(classify("a.test.ts", source, bound)).toBe("unit");
    expect(classify("b.test.ts", source, bound)).toBe("integration");
    expect(classify("c.test.ts", source, bound)).toBe("integration");
    expect(classify("missing.test.ts", source, bound)).toBe("unit");
    expect(classify("tests/e2e/b.e2e.test.ts", source, bound)).toBe("e2e");
  });

  test("partition places every test in exactly one layer", () => {
    const paths = fc.constantFrom(
      "a.test.ts",
      "b.test.ts",
      "c.test.ts",
      "tests/docker/d.docker.test.ts",
      "tests/e2e/e.e2e.test.ts",
      "j/journeys/x.journey.test.ts",
      "r.regression.test.ts",
      "i.int.test.ts",
    );
    fc.assert(
      fc.property(fc.array(paths, { maxLength: 12 }), (tests) => {
        const layers = partition(tests, support, source);
        const placed = LAYERS.flatMap((layer) => layers[layer]);
        return (
          placed.length === new Set(tests).size &&
          new Set(placed).size === placed.length &&
          [...new Set(tests)].every((t) => placed.includes(t))
        );
      }),
      { seed: 20261106, numRuns: 200 },
    );
  });
});

describe("RUNNERS and groupByRoot", () => {
  test("every layer has a runner", () => {
    expect(Object.keys(RUNNERS).sort()).toEqual([...LAYERS].sort());
  });

  test("groups by app or package root, sorted", () => {
    expect(
      groupByRoot([
        "scripts/__tests__/a.test.ts",
        "apps/sk/src/b.test.ts",
        "apps/engine/src/c.test.ts",
        "packages/shared/src/d.test.ts",
        "apps/engine/scripts/e.test.ts",
      ]),
    ).toEqual([
      {
        root: "apps/engine",
        files: ["apps/engine/src/c.test.ts", "apps/engine/scripts/e.test.ts"],
      },
      { root: "apps/sk", files: ["apps/sk/src/b.test.ts"] },
      { root: "packages/shared", files: ["packages/shared/src/d.test.ts"] },
      { root: "scripts", files: ["scripts/__tests__/a.test.ts"] },
    ]);
  });
});
