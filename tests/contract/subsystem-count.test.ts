// Subsystem-count parity gate.
//
// `AGENTS.md` and `.claude/CLAUDE.md` both publish a count of the engine
// subsystems. When directories are added or removed under
// `apps/engine/src/`, those numbers drift silently. This test fails on
// drift so the docs and the filesystem always agree.
//
// What the test checks:
//   - the directory count under apps/engine/src/ matches the number
//     written into AGENTS.md.
//   - the same number appears in .claude/CLAUDE.md.
//
// What the test deliberately does NOT check:
//   - the per-row content of the AGENTS.md table. That's covered by
//     the docs review process; rigid table-content tests churn on
//     every cosmetic edit and pay back rarely.

import { existsSync, readdirSync, readFileSync, statSync } from "node:fs";
import { join } from "node:path";

import { describe, expect, test } from "bun:test";

const REPO = join(import.meta.dir, "..", "..");

function countEngineSubsystemDirs(): number {
  const root = join(REPO, "apps/engine/src");
  return readdirSync(root).filter((name) => statSync(join(root, name)).isDirectory()).length;
}

function readSubsystemCount(file: string, label: string): number {
  const text = readFileSync(join(REPO, file), "utf8");
  // Match either "39 directories" or "39 engine subsystems" — the two
  // canonical phrasings. Capture the first number that appears in
  // either form so future edits to the surrounding prose don't break
  // the regex.
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
    // `.claude/` is a gitignored, machine-local bootstrap dir (see the repo
    // CLAUDE.md) — absent in CI and fresh clones. Skip the parity check when
    // the file is not present; the committed AGENTS.md checks below are the
    // real gate. When a contributor DOES have the local shim, still verify it.
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
