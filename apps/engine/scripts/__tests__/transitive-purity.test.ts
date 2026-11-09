import { describe, expect, test } from "bun:test";
import { parseTsconfigPaths } from "../audit/import-graph.ts";
import { findTransitivePurityHits } from "../audit/transitive-purity.ts";

const scopes = [
  parseTsconfigPaths(
    "",
    JSON.stringify({ compilerOptions: { paths: { "@shared/*": ["packages/shared/src/*"] } } }),
  ),
];

describe("transitive pure-target inspection", () => {
  test("follows an alias through a literal dynamic import to an effect", () => {
    const files = ["apps/engine/src/core.ts", "packages/shared/src/helper.ts"];
    const source: Record<string, string> = {
      "apps/engine/src/core.ts": 'void import("@shared/helper");',
      "packages/shared/src/helper.ts": "export const now = () => Date.now();",
    };
    const hits = findTransitivePurityHits({
      target: "apps/engine/src/core.ts",
      files,
      readText: (path) => source[path] ?? null,
      scopes,
    });
    expect(hits).toEqual([
      {
        target: "apps/engine/src/core.ts",
        chain: ["apps/engine/src/core.ts", "packages/shared/src/helper.ts"],
        line: 1,
        what: "Date.now",
      },
    ]);
  });

  test("does not traverse type-only imports and reports unresolved dynamic import", () => {
    const files = ["apps/engine/src/core.ts", "packages/shared/src/helper.ts"];
    const source: Record<string, string> = {
      "apps/engine/src/core.ts": 'import type { Value } from "@shared/helper"; import(name);',
      "packages/shared/src/helper.ts": "export const now = () => Date.now();",
    };
    const hits = findTransitivePurityHits({
      target: "apps/engine/src/core.ts",
      files,
      readText: (path) => source[path] ?? null,
      scopes,
    });
    expect(hits.map((hit) => hit.what)).toEqual(["computed dynamic import"]);
  });
});
