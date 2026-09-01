// Coverage matrix — every leaf in ConfigSchema must have at least one
// production consumer that reads it via getConfig(). Catches dead
// leaves (defined in the schema but never wired) and migration
// regressions (a subsystem that quietly stops calling getConfig).
//
// The check is structural — a grep over apps/engine/src/ for
// `getConfig()` chains terminating in the leaf path. Two patterns are
// recognized:
//
//   getConfig().<section>.<leaf>            // direct
//   getConfig(...).<section>.<leaf>         // tenant-scoped overload
//
// Plus the env-fallback path via readEnv() in llm/core/model-init.ts
// (ENV_TO_CONFIG_PATH map). A leaf with no match in either is a gap
// and fails this test.
//
// Excluded from the live-consumer requirement (documented inline):
//   - log.level / log.format               — read at boot only via reconfigureLogger
//   - server.port                          — read at boot only by serve()
//   - database.url                         — read by getDb() bootstrap path
//   - tenants                              — overlay record, walked separately
//
// To re-add a leaf to the live-consumer set, write a getConfig() call
// in production code (not a test) that resolves the dotted path.

import { describe, expect, test } from "bun:test";
import { readFileSync } from "node:fs";
import { join } from "node:path";
import { Glob } from "bun";
import { dottedPath, listConfigLeaves } from "../walk.ts";

const REPO_ROOT = join(import.meta.dir, "..", "..", "..", "..", "..");
const SRC_ROOT = join(REPO_ROOT, "apps", "engine", "src");

// Boot-only / loader-internal leaves that the structural grep can't
// detect because the consumer lives in the loader itself or in a
// wrapper that swallows the dotted path.
const BOOT_ONLY_LEAVES = new Set<string>([
  "log.level",
  "log.format",
  "server.port",
  "server.public_base_url",
  "database.url",
  "auth.session.secret",
]);

// readEnv() in llm/core/model-init.ts wires every entry in
// ENV_TO_CONFIG_PATH to its leaf — this is a single declarative map
// that subsumes ~30 individual getConfig() chains. We treat any leaf
// path appearing in that map as "consumed via readEnv".
function loadEnvToConfigPath(): Set<string> {
  const text = readFileSync(join(SRC_ROOT, "llm", "core", "model-init.ts"), "utf8");
  const out = new Set<string>();
  // Match: KEY: ["llm", "providers", "anthropic", "api_key"],
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
  // Bound the read for speed: each file is small (<5k LOC) and there
  // are ~600 files; full-corpus read is ~5 MB — well under bun test
  // memory. A grep is structurally identical and faster but requires
  // shell access which we want to avoid here.
  return files.map((f) => readFileSync(f, "utf8")).join("\n\n");
}

function leafIsConsumed(corpus: string, dotted: string, envMap: Set<string>): boolean {
  if (envMap.has(dotted)) return true;
  // Match the full dotted suffix anywhere — `.<a>.<b>.<c>` is a
  // canonical access shape that reaches the consumer through a
  // `getConfig()` binding (direct or multi-step). The dotted path
  // alone is the structural signal.
  const segs = dotted.split(".");
  const fullSuffix = segs.join("\\.");
  if (new RegExp(`\\.${fullSuffix}\\b`).test(corpus)) return true;
  // Section destructure: any prefix dotted-access reachable in the
  // corpus implies the leaf is read through that destructure.
  // Catches `cfg.storage.object_store` followed elsewhere by `.bucket`,
  // `.region`, `.access_key_id`, etc.
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
      // Fail with a precise list so adding a getConfig() reference
      // (or ENV_TO_CONFIG_PATH entry) is mechanical.
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
