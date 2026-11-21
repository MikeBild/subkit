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
  "llm/runtime/model-init.ts",
  "llm/accounting/count.ts",
  "llm/accounting/enforce.ts",
  "llm/runtime-context.ts",
  "execution/offload.ts",
  "index.ts",
  "db/migrate.ts",
  "db/issue-admin-key.ts",
  "db/client.ts",
]);

function inDirectory(file: string, directory: string): boolean {
  return file === directory || file.startsWith(`${directory}/`) || file.includes(`/${directory}/`);
}

async function scanProductionFiles(): Promise<Map<string, string[]>> {
  const out = new Map<string, string[]>();
  const glob = new Glob("**/*.ts");
  for await (const file of glob.scan(SRC_ROOT)) {
    if (inDirectory(file, "__tests__") || inDirectory(file, "tests")) continue;
    if (file.endsWith(".test.ts") || file.endsWith("-fixtures.ts")) continue;
    if (file.endsWith(".d.ts")) continue;
    if (inDirectory(file, "test-helpers")) continue;
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
          const read = new RegExp(`\\b(readEnv|envFlag|envInt|envList)\\(\\s*"${key}"`);
          if (read.test(line)) violations.push(`${file}:${idx + 1} reads ${key}`);
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
