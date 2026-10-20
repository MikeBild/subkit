import { describe, expect, test } from "bun:test";
import { existsSync, readdirSync, readFileSync, statSync } from "node:fs";
import { join } from "node:path";

const REPO = join(import.meta.dir, "..", "..");

function countEngineSubsystemDirs(): number {
  const root = join(REPO, "apps/engine/src");
  return readdirSync(root).filter((name) => statSync(join(root, name)).isDirectory()).length;
}

function readSubsystemCount(file: string): number | undefined {
  const text = readFileSync(join(REPO, file), "utf8");
  const match = text.match(/(\d{2})\s+(?:engine\s+subsystems|directories)/);
  return match?.[1] ? Number(match[1]) : undefined;
}

describe("subsystem-count parity", () => {
  test.skipIf(readSubsystemCount("AGENTS.md") === undefined)(
    "AGENTS.md table count matches apps/engine/src/ directory count",
    () => {
      expect(readSubsystemCount("AGENTS.md")).toBe(countEngineSubsystemDirs());
    },
  );

  test(".claude/CLAUDE.md count matches the filesystem", () => {
    if (!existsSync(join(REPO, ".claude/CLAUDE.md"))) return;
    const actual = countEngineSubsystemDirs();
    const claimed = readSubsystemCount(".claude/CLAUDE.md");
    expect(claimed).toBe(actual);
  });

  test("apps/engine/AGENTS.md count matches the filesystem", () => {
    const actual = countEngineSubsystemDirs();
    const claimed = readSubsystemCount("apps/engine/AGENTS.md");
    expect(claimed).toBe(actual);
  });
});
