import { describe, expect, test } from "bun:test";
import { parseSource } from "../audit/imports.ts";
import {
  getDbCallHits,
  lintSuppressionHits,
  processEnvHits,
  type ResolvedImport,
  vendorImportHits,
} from "../audit/rules.ts";

const engine = "apps/engine/src/";
const imp = (specifier: string, typeOnly = false): ResolvedImport => ({
  specifier,
  resolved: specifier,
  typeOnly,
  line: 1,
});

describe("vendorImportHits", () => {
  const what = (file: string, specifiers: string[]) =>
    vendorImportHits(
      `${engine}${file}`,
      specifiers.map((s) => imp(s)),
    ).map((hit) => hit.what);

  test("flags vendor SDKs imported outside their adapter folders", () => {
    expect(what("workflows/service.ts", ["drizzle-orm", "drizzle-orm/pg-core", "pg"])).toEqual([
      "drizzle-orm",
      "drizzle-orm/pg-core",
      "pg",
    ]);
    expect(what("queue/handlers/run.ts", ["pg-boss"])).toEqual(["pg-boss"]);
    expect(what("mcp/capabilities/tools.ts", ["@modelcontextprotocol/sdk/types.js"])).toEqual([
      "@modelcontextprotocol/sdk/types.js",
    ]);
    expect(what("http/middleware/error.ts", ["ai", "@ai-sdk/openai"])).toEqual([
      "ai",
      "@ai-sdk/openai",
    ]);
  });

  test("allows each SDK inside its adapter folders", () => {
    expect(what("db/client.ts", ["drizzle-orm", "pg"])).toEqual([]);
    expect(what("conversations/persistence/turns.ts", ["drizzle-orm"])).toEqual([]);
    expect(what("knowledge/adapters/store.ts", ["drizzle-orm", "ai"])).toEqual([]);
    expect(what("connectors/drivers/postgres.ts", ["pg"])).toEqual([]);
    expect(what("pubsub/listener.ts", ["pg"])).toEqual([]);
    expect(what("queue/boss.ts", ["pg-boss"])).toEqual([]);
    expect(what("mcp/client/pool.ts", ["@modelcontextprotocol/sdk/client/index.js"])).toEqual([]);
    expect(what("mcp/transports/guards.ts", ["@modelcontextprotocol/sdk/types.js"])).toEqual([]);
    expect(what("mcp/server.ts", ["@modelcontextprotocol/sdk/server/mcp.js"])).toEqual([]);
    expect(what("llm/runtime/model-init.ts", ["ai", "@ai-sdk/anthropic"])).toEqual([]);
  });

  test("ignores type-only imports, other packages, tests and files outside the engine", () => {
    expect(vendorImportHits(`${engine}workflows/service.ts`, [imp("drizzle-orm", true)])).toEqual(
      [],
    );
    expect(what("workflows/service.ts", ["zod", "hono", "./ai.ts", "aid"])).toEqual([]);
    expect(what("workflows/service.test.ts", ["drizzle-orm"])).toEqual([]);
    expect(what("workflows/tests/setup.ts", ["drizzle-orm"])).toEqual([]);
    expect(vendorImportHits("apps/subkit/src/x.ts", [imp("drizzle-orm")])).toEqual([]);
  });
});

describe("getDbCallHits", () => {
  test("counts every getDb call, with or without arguments", () => {
    const sf = parseSource(
      "a.ts",
      "const a = getDb();\nconst b = x ?? getDb();\nconst c = getDb(tx);\nconst d = getDbUrl();",
    );
    expect(getDbCallHits(sf).map((hit) => hit.line)).toEqual([1, 2, 3]);
  });
});

describe("processEnvHits", () => {
  const lines = (file: string, source: string) =>
    processEnvHits(file, parseSource(file, source)).map((hit) => hit.line);

  test("flags reads, writes and whole-object uses of process.env", () => {
    expect(
      lines(
        `${engine}db/client.ts`,
        "const a = process.env.X;\nprocess.env.Y = '1';\nconst c = { ...process.env };\nconst d = process.argv;",
      ),
    ).toEqual([1, 2, 3]);
  });

  test("exempts the env schema and the determinism env helper", () => {
    expect(lines(`${engine}env.ts`, "const a = process.env.X;")).toEqual([]);
    expect(lines(`${engine}test-helpers/determinism/env.ts`, "process.env.X = 'y';")).toEqual([]);
  });
});

describe("lintSuppressionHits", () => {
  const lines = (file: string, source: string) =>
    lintSuppressionHits(parseSource(file, source)).map((hit) => hit.line);

  test("counts line and block suppressions, also inside JSX expressions", () => {
    expect(
      lines(
        "a.tsx",
        [
          "// biome-ignore lint/suspicious/noExplicitAny: x",
          "const a: any = 1;",
          "/* biome-ignore lint/style/useImportType: y */",
          "const b = <div>{/* biome-ignore lint/a11y/useSemanticElements: z */}<span /></div>;",
        ].join("\n"),
      ),
    ).toEqual([1, 3, 4]);
  });

  test("ignores the directive name inside strings, regexes and ordinary comments", () => {
    expect(
      lines(
        "a.ts",
        'const a = "biome-ignore";\nconst r = /biome-ignore|@ts-ignore/;\n// not a biome-ignore directive\n',
      ),
    ).toEqual([]);
  });
});
