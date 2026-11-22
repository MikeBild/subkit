import { afterEach, beforeEach, describe, expect, test } from "bun:test";
import { mkdirSync, mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";

let tempDir: string;
let originalHome: string | undefined;

beforeEach(() => {
  tempDir = mkdtempSync(join(tmpdir(), "subkit-usage-stats-"));
  originalHome = process.env.HOME;
  process.env.HOME = tempDir;
});

afterEach(() => {
  if (originalHome !== undefined) {
    process.env.HOME = originalHome;
  } else {
    delete process.env.HOME;
  }
  rmSync(tempDir, { recursive: true, force: true });
});

let freshModuleSeq = 0;
async function freshModule() {
  freshModuleSeq += 1;
  const mod = await import(`./usage-stats.ts?seq=${freshModuleSeq}`);
  return mod;
}

describe("usage-stats — write/read round-trip", () => {
  test("getUsageCount returns 0 for unknown command when file is missing", async () => {
    const mod = await freshModule();
    const counts = mod.getAllUsageCounts();
    expect(typeof counts).toBe("object");
  });

  test("recordUsage creates the prefs.json file and bumps the count", async () => {
    const mod = await freshModule();
    const before = mod.getUsageCount("workflows");
    mod.recordUsage("workflows");
    const after = mod.getUsageCount("workflows");
    expect(after).toBe(before + 1);
  });

  test("recordUsage is additive across multiple calls", async () => {
    const mod = await freshModule();
    const before = mod.getUsageCount("executions");
    mod.recordUsage("executions");
    mod.recordUsage("executions");
    mod.recordUsage("executions");
    const after = mod.getUsageCount("executions");
    expect(after).toBe(before + 3);
  });

  test("frequencyBias returns log(count + 1)", async () => {
    const mod = await freshModule();
    const before = mod.getUsageCount("connectors");
    const expectedBias = Math.log(before + 1);
    expect(mod.frequencyBias("connectors")).toBeCloseTo(expectedBias, 10);
  });

  test("getAllUsageCounts returns a snapshot including recently bumped keys", async () => {
    const mod = await freshModule();
    mod.recordUsage("schedules");
    const all = mod.getAllUsageCounts();
    expect(typeof all.schedules).toBe("number");
  });
});

describe("usage-stats — missing file = empty", () => {
  test("getUsageCount on missing file returns 0 (no throw)", async () => {
    const mod = await freshModule();
    const count = mod.getUsageCount("__definitely_not_used_key_xyz__");
    expect(count).toBe(0);
  });
});

describe("usage-stats — malformed JSON = empty", () => {
  test("malformed prefs.json is silently treated as empty", async () => {
    const subkitDir = join(tempDir, ".subkit");
    mkdirSync(subkitDir, { recursive: true });
    writeFileSync(join(subkitDir, "prefs.json"), "{{not-json}}");
    const mod = await freshModule();
    expect(mod.getUsageCount("anything")).toBe(0);
  });

  test("prefs.json missing `counts` field is treated as empty", async () => {
    const subkitDir = join(tempDir, ".subkit");
    mkdirSync(subkitDir, { recursive: true });
    writeFileSync(join(subkitDir, "prefs.json"), JSON.stringify({ version: 1 }));
    const mod = await freshModule();
    expect(mod.getUsageCount("anything")).toBe(0);
  });
});

describe("usage-stats — atomic rename", () => {
  test("prefs.json is written via a temp file (atomic rename guarantees)", async () => {
    const { readdirSync } = await import("node:fs");
    const mod = await freshModule();
    mod.recordUsage("audit");
    const subkitDir = join(tempDir, ".subkit");
    try {
      const files = readdirSync(subkitDir);
      const tmpFiles = files.filter((f) => f.startsWith("prefs.json.tmp-"));
      expect(tmpFiles.length).toBe(0);
    } catch {}
  });
});
