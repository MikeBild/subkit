import { describe, expect, test } from "bun:test";
import { existsSync, readdirSync, readFileSync } from "node:fs";
import { dirname, join, relative, resolve } from "node:path";

const engineSrc = resolve(import.meta.dir, "../..");
const conversationsDir = join(engineSrc, "conversations");
const mcpBarrel = join(engineSrc, "mcp/index.ts");
const transpiler = new Bun.Transpiler({ loader: "ts" });

const isProductionSource = (path: string) =>
  path.endsWith(".ts") && !path.endsWith(".test.ts") && !path.includes("/tests/");

const productionSources = (dir: string): string[] =>
  readdirSync(dir, { recursive: true, encoding: "utf8" })
    .map((entry) => join(dir, entry))
    .filter(isProductionSource);

const staticRelativeImports = (file: string): string[] =>
  transpiler
    .scanImports(readFileSync(file, "utf8"))
    .filter((entry) => entry.kind === "import-statement" && entry.path.startsWith("."))
    .map((entry) => resolve(dirname(file), entry.path))
    .filter((path) => path.endsWith(".ts") && existsSync(path));

function chainToMcpBarrel(entries: readonly string[]): string[] | null {
  const parentOf = new Map<string, string | null>(entries.map((entry) => [entry, null]));
  const queue = [...entries];
  while (queue.length > 0) {
    const file = queue.shift() as string;
    if (file === mcpBarrel) {
      const chain: string[] = [];
      for (let node: string | null | undefined = file; node; node = parentOf.get(node))
        chain.unshift(relative(engineSrc, node));
      return chain;
    }
    for (const next of staticRelativeImports(file)) {
      if (parentOf.has(next)) continue;
      parentOf.set(next, file);
      queue.push(next);
    }
  }
  return null;
}

describe("mcp barrel import cycle", () => {
  test("no conversations module statically reaches mcp/index.ts", () => {
    const entries = productionSources(conversationsDir);
    expect(entries).toContain(join(conversationsDir, "persistence/save-connector.ts"));
    expect(chainToMcpBarrel(entries)?.join(" -> ") ?? null).toBeNull();
  });

  test("the walk reports the chain when a module imports the barrel", () => {
    expect(chainToMcpBarrel([join(engineSrc, "http/routes/connectors/oauth.ts")])).toEqual([
      "http/routes/connectors/oauth.ts",
      "mcp/index.ts",
    ]);
  });
});
