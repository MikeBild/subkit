// RETIRED_ENV_KEYS hygiene — every env var listed in env.ts as
// retired must NOT be read directly by production code (outside the
// retire-warn list itself). The contract: an operator who still sets
// a retired env var gets a one-line warn at boot pointing at
// `sk settings configure`, and the engine does NOT silently honor
// the value through some lingering env read.
//
// Allowed exceptions (documented inline):
//   - apps/engine/src/env.ts itself                — owns the warn list
//   - apps/engine/src/llm/core/model-init.ts       — readEnv() routes
//                                                   env→config via the
//                                                   ENV_TO_CONFIG_PATH map
//                                                   so the env reads
//                                                   here are the
//                                                   approved migration
//                                                   bridge
//   - apps/engine/src/llm/accounting/{count,enforce}.ts
//                                                 — explicit
//                                                   getConfig-first +
//                                                   env-fallback
//                                                   helpers
//   - apps/engine/src/llm/runtime-context.ts       — same env-fallback
//                                                   shape as above
//   - apps/engine/src/execution/offload.ts         — env-fallback for
//                                                   the legacy
//                                                   S3_OFFLOAD_*
//                                                   variants
//
// Any other production file that contains `process.env.<RETIRED>` is
// a regression — operators set the env, get the warn, but the value
// silently still wires through.

import { describe, expect, test } from "bun:test";
import { readFileSync } from "node:fs";
import { join } from "node:path";
import { Glob } from "bun";

const SRC_ROOT = join(import.meta.dir, "..", "..");

function loadRetiredEnvKeys(): string[] {
  const text = readFileSync(join(SRC_ROOT, "env.ts"), "utf8");
  const start = text.indexOf("RETIRED_ENV_KEYS");
  if (start < 0) return [];
  const arrStart = text.indexOf("[", start);
  const arrEnd = text.indexOf("]", arrStart);
  if (arrStart < 0 || arrEnd < 0) return [];
  const slice = text.slice(arrStart, arrEnd);
  return [...slice.matchAll(/"([A-Z][A-Z0-9_]+)"/g)].map((m) => m[1] as string);
}

const ALLOWED_FILES = new Set<string>([
  "env.ts",
  "llm/core/model-init.ts",
  "llm/accounting/count.ts",
  "llm/accounting/enforce.ts",
  "llm/runtime-context.ts",
  "execution/offload.ts",
  // Bootstrap-tier env reads — these run BEFORE loadConfig() at boot:
  "index.ts", // runSmoke needs PORT before loadConfig
  "db/migrate.ts", // standalone migration binary
  "db/issue-admin-key.ts", // standalone admin script
  "db/client.ts", // env-fallback when getConfig() throws (test-helper bootstraps)
]);

async function scanProductionFiles(): Promise<Map<string, string[]>> {
  const out = new Map<string, string[]>();
  const glob = new Glob("**/*.ts");
  for await (const file of glob.scan(SRC_ROOT)) {
    if (file.includes("__tests__/") || file.includes("/tests/")) continue;
    if (file.endsWith(".test.ts")) continue;
    if (file.endsWith(".d.ts")) continue;
    if (file.includes("/test-helpers/")) continue;
    if (ALLOWED_FILES.has(file)) continue;
    out.set(file, readFileSync(join(SRC_ROOT, file), "utf8").split("\n"));
  }
  return out;
}

describe("RETIRED_ENV_KEYS hygiene", () => {
  const retired = loadRetiredEnvKeys();

  test("RETIRED_ENV_KEYS list is non-empty", () => {
    expect(retired.length).toBeGreaterThan(20);
  });

  test("no production file outside the allowed bridge list reads any retired env var directly", async () => {
    const files = await scanProductionFiles();
    const violations: string[] = [];
    for (const [file, lines] of files) {
      lines.forEach((line, idx) => {
        for (const key of retired) {
          // Match `process.env.<KEY>` exactly. Allow `process.env[<KEY>]`
          // bracket access too.
          const dot = new RegExp(`process\\.env\\.${key}\\b`);
          const bracket = new RegExp(`process\\.env\\[\\s*"${key}"\\s*\\]`);
          if (dot.test(line) || bracket.test(line)) {
            violations.push(`${file}:${idx + 1} reads process.env.${key}`);
          }
        }
      });
    }
    expect(
      violations,
      `${violations.length} production env reads for retired keys:\n${violations.slice(0, 20).join("\n")}`,
    ).toEqual([]);
  });

  test("ALLOWED_FILES are all real files (no stale exemptions)", () => {
    const stale: string[] = [];
    for (const f of ALLOWED_FILES) {
      try {
        readFileSync(join(SRC_ROOT, f), "utf8");
      } catch {
        stale.push(f);
      }
    }
    expect(stale, `stale ALLOWED_FILES exemptions: ${stale.join(", ")}`).toEqual([]);
  });
});
