import { describe, expect, test } from "bun:test";
import { existsSync, readdirSync, readFileSync, statSync } from "node:fs";
import { join } from "node:path";

const REPO = join(import.meta.dir, "..", "..");

function countEngineSubsystemDirs(): number {
  const root = join(REPO, "apps/engine/src");
  return readdirSync(root).filter((name) => statSync(join(root, name)).isDirectory()).length;
}

function readSubsystemCount(file: string, label: string): number {
  const text = readFileSync(join(REPO, file), "utf8");
  const match = text.match(/(\d{2})\s+(?:engine\s+subsystems|directories)/);
  if (!match?.[1]) {
    throw new Error(
      `${label}: could not find a "<n> directories" or "<n> engine subsystems" claim in ${file}`,
    );
  }
  return Number(match[1]);
}

describe("subsystem-count parity", () => {
  test("AGENTS.md table count matches apps/engine/src/ directory count", () => {
    const actual = countEngineSubsystemDirs();
    const claimed = readSubsystemCount("AGENTS.md", "AGENTS.md");
    expect(claimed).toBe(actual);
  });

  test(".claude/CLAUDE.md count matches the filesystem", () => {
    if (!existsSync(join(REPO, ".claude/CLAUDE.md"))) return;
    const actual = countEngineSubsystemDirs();
    const claimed = readSubsystemCount(".claude/CLAUDE.md", ".claude/CLAUDE.md");
    expect(claimed).toBe(actual);
  });

  test("apps/engine/AGENTS.md count matches the filesystem", () => {
    const actual = countEngineSubsystemDirs();
    const claimed = readSubsystemCount("apps/engine/AGENTS.md", "apps/engine/AGENTS.md");
    expect(claimed).toBe(actual);
  });
});
