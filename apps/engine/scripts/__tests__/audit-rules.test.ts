import { describe, expect, test } from "bun:test";
import { collectImports, parseSource } from "../audit/imports.ts";
import {
  conversationsLeafHits,
  dbImportHits,
  effectHits,
  getDbFallbackHits,
  isCorePath,
  isGetDbFallbackScope,
  isTestPath,
  lineCount,
  pureCoreImportHits,
  type ResolvedImport,
} from "../audit/rules.ts";

const imp = (specifier: string, resolved = specifier, typeOnly = false): ResolvedImport => ({
  specifier,
  resolved,
  typeOnly,
  line: 1,
});

describe("path classification", () => {
  test("isTestPath covers test files and test directories", () => {
    expect(isTestPath("apps/engine/src/a.test.ts")).toBe(true);
    expect(isTestPath("apps/sk/src/a.test.tsx")).toBe(true);
    expect(isTestPath("apps/engine/src/x/tests/setup.ts")).toBe(true);
    expect(isTestPath("apps/engine/src/db/vault-maintenance-fixtures.ts")).toBe(true);
    expect(isTestPath("apps/engine/src/db/vault-fixtures-loader.ts")).toBe(false);
    expect(isTestPath("apps/engine/src/x/__tests__/h.ts")).toBe(true);
    expect(isTestPath("apps/engine/src/test-helpers/seed.ts")).toBe(true);
    expect(isTestPath("apps/engine/src/x/service.ts")).toBe(false);
  });

  test("isCorePath matches core.ts and files below a core/ directory, never tests", () => {
    expect(isCorePath("apps/engine/src/execution/core.ts")).toBe(true);
    expect(isCorePath("apps/engine/src/workflows/core/workflow.ts")).toBe(true);
    expect(isCorePath("apps/engine/src/llm/core/context-assembler/loaders.ts")).toBe(true);
    expect(isCorePath("apps/engine/src/execution/core.test.ts")).toBe(false);
    expect(isCorePath("apps/engine/src/workflows/core/types.d.ts")).toBe(false);
    expect(isCorePath("packages/cli-core/src/index.ts")).toBe(false);
    expect(isCorePath("apps/engine/src/score.ts")).toBe(false);
    expect(isCorePath("apps/engine/src/core.json")).toBe(false);
  });

  test("lineCount matches the split-based count used by every size check", () => {
    expect(lineCount("a\nb\n")).toBe(3);
    expect(lineCount("")).toBe(1);
  });
});

describe("dbImportHits", () => {
  test("flags runtime drizzle-orm and db/schema imports", () => {
    const hits = dbImportHits([
      imp("drizzle-orm"),
      imp("drizzle-orm/pg-core"),
      imp("../../db/schema", "apps/engine/src/db/schema.ts"),
      imp("../../db/schema/workflows.ts", "apps/engine/src/db/schema/workflows.ts"),
    ]);
    expect(hits.map((h) => h.what)).toEqual([
      "drizzle-orm",
      "drizzle-orm/pg-core",
      "../../db/schema",
      "../../db/schema/workflows.ts",
    ]);
  });

  test("ignores type-only imports, db/client and look-alike packages", () => {
    expect(
      dbImportHits([
        imp("drizzle-orm", "drizzle-orm", true),
        imp("../../db/client.ts", "apps/engine/src/db/client.ts"),
        imp("drizzle-orm-extra"),
        imp("../schema.ts", "apps/engine/src/http/schema.ts"),
      ]),
    ).toEqual([]);
  });
});

describe("pureCoreImportHits", () => {
  test("flags db/, llm/, audit/, queue/ and drizzle-orm, including type-only imports", () => {
    const hits = pureCoreImportHits([
      imp("../db/client.ts", "apps/engine/src/db/client.ts", true),
      imp("../llm/index.ts", "apps/engine/src/llm/index.ts"),
      imp("../audit/index.ts", "apps/engine/src/audit/index.ts"),
      imp("../queue/index.ts", "apps/engine/src/queue/index.ts"),
      imp("drizzle-orm"),
      imp("../../db", "apps/engine/src/db"),
    ]);
    expect(hits).toHaveLength(6);
  });

  test("flags a sibling import inside an impure subsystem as well", () => {
    expect(
      pureCoreImportHits([imp("../core/invoke.ts", "apps/engine/src/llm/core/invoke.ts")]),
    ).toEqual([{ line: 1, what: "import ../core/invoke.ts" }]);
  });

  test("allows other subsystems, top-level engine files and packages", () => {
    expect(
      pureCoreImportHits([
        imp("../../workflows/types.ts", "apps/engine/src/workflows/types.ts"),
        imp("../config.ts", "apps/engine/src/config.ts"),
        imp("zod"),
        imp("@subkit/shared", "@subkit/shared"),
      ]),
    ).toEqual([]);
  });
});

describe("effectHits", () => {
  const hits = (source: string) => effectHits(parseSource("core.ts", source)).map((h) => h.what);

  test("flags clock, randomness and environment reads", () => {
    expect(
      hits(
        [
          "const a = Date.now();",
          "const b = new Date();",
          "const c = Math.random();",
          "const d = crypto.randomUUID();",
          "const e = process.env.X;",
          'import { randomUUID } from "node:crypto";',
          "const f = randomUUID();",
          "const g = Date.now;",
        ].join("\n"),
      ),
    ).toEqual([
      "Date.now",
      "new Date()",
      "Math.random",
      "randomUUID",
      "process.env",
      "randomUUID",
      "randomUUID",
      "Date.now",
    ]);
  });

  test("flags direct runtime effects and unresolved module loading", () => {
    expect(
      hits(
        [
          'import { readFileSync } from "node:fs";',
          "fetch('/api');",
          "process.stdout.write('x');",
          "process.exit(1);",
          "crypto.randomBytes(4);",
          "import(name);",
          "require(name);",
        ].join("\n"),
      ),
    ).toEqual([
      "fetch",
      "process.stdout",
      "process.exit",
      "randomBytes",
      "computed dynamic import",
      "require",
    ]);
    expect(pureCoreImportHits([imp("node:fs")])).toEqual([{ line: 1, what: "import node:fs" }]);
  });

  test("allows dates from parameters and text that only mentions the APIs", () => {
    expect(
      hits(
        [
          "export const at = (ms: number) => new Date(ms);",
          'const prompt = "call Date.now() or Math.random()";',
          "const t = `process.env and Date.now()`;",
          "const now = (clock: { now(): number }) => clock.now();",
        ].join("\n"),
      ),
    ).toEqual([]);
  });
});

describe("getDbFallbackHits", () => {
  const hits = (source: string) => getDbFallbackHits(parseSource("service.ts", source));

  test("flags `?? getDb()` with or without parentheses", () => {
    expect(hits("const db = exec ?? getDb();\nconst d = exec ?? (getDb());")).toEqual([
      { line: 1, what: "?? getDb()" },
      { line: 2, what: "?? getDb()" },
    ]);
  });

  test("ignores explicit calls, other fallbacks and getDb with arguments", () => {
    expect(
      hits(
        "const a = getDb();\nconst b = x ?? y;\nconst c = x || getDb();\nconst d = x ?? getDb(tx);",
      ),
    ).toEqual([]);
  });
});

describe("isGetDbFallbackScope", () => {
  test("covers services, the egress guard and the engine client", () => {
    for (const path of [
      "apps/engine/src/identity/service.ts",
      "apps/engine/src/connectors/egress-guard.ts",
      "apps/engine/src/engine-client/index.ts",
    ])
      expect(isGetDbFallbackScope(path)).toBe(true);
  });

  test("leaves other engine files, tests and other apps out", () => {
    for (const path of [
      "apps/engine/src/connectors/robots-cache.ts",
      "apps/engine/src/connectors/egress-guard.test.ts",
      "apps/engine/src/identity/tests/service.ts",
      "apps/sk/src/engine-client/index.ts",
    ])
      expect(isGetDbFallbackScope(path)).toBe(false);
  });
});

describe("conversationsLeafHits", () => {
  const prefix = "apps/engine/src/conversations/";

  test("flags reach-ins from other subsystems", () => {
    expect(
      conversationsLeafHits("apps/engine/src/mcp/server.ts", [
        imp("../conversations/loop.ts", `${prefix}loop.ts`),
        imp("../conversations/tools/sdk-wrap/invoke.ts", `${prefix}tools/sdk-wrap/invoke.ts`),
      ]).map((h) => h.what),
    ).toEqual([`${prefix}loop.ts`, `${prefix}tools/sdk-wrap/invoke.ts`]);
  });

  test("allows only the explicit public entry points and imports from inside conversations", () => {
    expect(
      conversationsLeafHits("apps/engine/src/mcp/server.ts", [
        imp("../conversations/tools", `${prefix}tools/index.ts`),
        imp("../conversations/types.ts", `${prefix}types.ts`),
        imp("../conversations/public/lifecycle.ts", `${prefix}public/lifecycle.ts`),
        imp("../conversations/public/authoring.ts", `${prefix}public/authoring.ts`),
        imp("../conversations/public/context.ts", `${prefix}public/context.ts`),
        imp("../conversations/public/elicitation.ts", `${prefix}public/elicitation.ts`),
        imp("../conversations/public/policy.ts", `${prefix}public/policy.ts`),
        imp("../conversations/public/tool-contract.ts", `${prefix}public/tool-contract.ts`),
        imp("../conversations-extra/x.ts", "apps/engine/src/conversations-extra/x.ts"),
      ]),
    ).toEqual([]);
    expect(
      conversationsLeafHits("apps/engine/src/mcp/server.ts", [
        imp("../conversations/public/other.ts", `${prefix}public/other.ts`),
      ]),
    ).toEqual([{ line: 1, what: `${prefix}public/other.ts` }]);
    expect(
      conversationsLeafHits(`${prefix}loop.ts`, [imp("./intent.ts", `${prefix}intent.ts`)]),
    ).toEqual([]);
  });

  test("works on imports collected from real source text", () => {
    const refs = collectImports(
      "apps/engine/src/queue/h.ts",
      'const { x } = await import("../conversations/elicitations.ts");',
    ).map((r) => ({ ...r, resolved: `${prefix}elicitations.ts` }));
    expect(conversationsLeafHits("apps/engine/src/queue/h.ts", refs)).toHaveLength(1);
  });
});
