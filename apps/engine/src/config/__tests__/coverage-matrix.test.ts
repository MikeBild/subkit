import { describe, expect, test } from "bun:test";
import { readFileSync } from "node:fs";
import { join } from "node:path";
import { Glob } from "bun";
import { dottedPath, listConfigLeaves } from "../walk.ts";

const REPO_ROOT = join(import.meta.dir, "..", "..", "..", "..", "..");
const SRC_ROOT = join(REPO_ROOT, "apps", "engine", "src");

const BOOT_ONLY_LEAVES = new Set<string>([
  "log.level",
  "log.format",
  "server.port",
  "server.public_base_url",
  "database.url",
  "auth.session.secret",
]);

function loadEnvToConfigPath(): Set<string> {
  const text = readFileSync(join(SRC_ROOT, "llm", "core", "model-init.ts"), "utf8");
  const out = new Set<string>();
  const pattern = /^\s*[A-Z_]+:\s*\[(.+?)\],\s*$/gm;
  let m: RegExpExecArray | null;
  // biome-ignore lint/suspicious/noAssignInExpressions: regex iteration pattern
  while ((m = pattern.exec(text)) !== null) {
    const literal = m[1];
    if (!literal) continue;
    const segs = [...literal.matchAll(/"([^"]+)"/g)].map((mm) => mm[1] as string);
    if (segs.length > 0) out.add(segs.join("."));
  }
  return out;
}

async function loadAllSourceText(): Promise<string> {
  const glob = new Glob("**/*.ts");
  const files: string[] = [];
  for await (const file of glob.scan(SRC_ROOT)) {
    if (file.includes("__tests__/") || file.includes("/tests/")) continue;
    if (file.endsWith(".test.ts")) continue;
    if (file.endsWith(".d.ts")) continue;
    files.push(join(SRC_ROOT, file));
  }
  return files.map((f) => readFileSync(f, "utf8")).join("\n\n");
}

function leafIsConsumed(corpus: string, dotted: string, envMap: Set<string>): boolean {
  if (envMap.has(dotted)) return true;
  const segs = dotted.split(".");
  const fullSuffix = segs.join("\\.");
  if (new RegExp(`\\.${fullSuffix}\\b`).test(corpus)) return true;
  for (let i = segs.length - 1; i >= 1; i -= 1) {
    const prefix = segs.slice(0, i).join("\\.");
    if (new RegExp(`\\.${prefix}\\b`).test(corpus)) return true;
  }
  return false;
}

describe("config coverage matrix — every schema leaf has a live consumer", () => {
  test("every leaf is read by at least one production code path (or bootstraps via readEnv)", async () => {
    const leaves = listConfigLeaves();
    expect(leaves.length).toBeGreaterThan(70);
    const envMap = loadEnvToConfigPath();
    const corpus = await loadAllSourceText();
    const orphans: string[] = [];
    for (const leaf of leaves) {
      const dotted = dottedPath(leaf);
      if (BOOT_ONLY_LEAVES.has(dotted)) continue;
      if (!leafIsConsumed(corpus, dotted, envMap)) orphans.push(dotted);
    }
    if (orphans.length > 0) {
      expect(
        orphans,
        `${orphans.length} schema leaves have no live consumer:\n${orphans.join("\n")}`,
      ).toEqual([]);
    }
  });

  test("every entry in ENV_TO_CONFIG_PATH points at a real leaf", () => {
    const envMap = loadEnvToConfigPath();
    expect(envMap.size).toBeGreaterThan(20);
    const validLeaves = new Set(listConfigLeaves().map((l) => dottedPath(l)));
    const stale: string[] = [];
    for (const path of envMap) {
      if (!validLeaves.has(path)) stale.push(path);
    }
    expect(stale, `ENV_TO_CONFIG_PATH points at non-existent leaves: ${stale.join(", ")}`).toEqual(
      [],
    );
  });
});
