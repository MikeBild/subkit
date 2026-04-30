// Skill-body trimming: ambient (applicable but not loaded) skills
// render in summary form (title + 1-line description + load_skill
// hint). Loaded skills (via explicit load_skill calls) carry the
// full body. Pre-fix every applicable skill rendered with its full
// body (~31k tokens of skills per turn in session a128deba).
//
// We can't unit-test the full assembler without a DB, so this test
// reads the source and asserts the formatter pair exists + the
// ambient sections route through the summary form.

import { describe, expect, test } from "bun:test";
import { readFileSync } from "node:fs";
import { join } from "node:path";

const SRC = join(import.meta.dir, "..", "core", "context-assembler.ts");

describe("context-assembler · skill body trimming", () => {
  const body = readFileSync(SRC, "utf-8");

  test("formatSkillSummary helper exists", () => {
    expect(body).toContain("function formatSkillSummary");
  });

  test("globalSkills / connectorSkills / workflowSkills route through formatSkillSummary", () => {
    expect(body).toMatch(/for \(const s of globalSkills\) sections\.push\(formatSkillSummary\(/);
    expect(body).toMatch(/for \(const s of connectorSkills\) sections\.push\(formatSkillSummary\(/);
    expect(body).toMatch(/for \(const s of workflowSkills\) sections\.push\(formatSkillSummary\(/);
  });

  test("loadedSkills still route through full formatSkill", () => {
    expect(body).toMatch(/for \(const s of loadedSkills\) sections\.push\(formatSkill\(/);
  });

  test("the summary form mentions load_skill so the LLM knows how to expand", () => {
    expect(body).toContain("load_skill");
    expect(body).toContain("formatSkillSummary");
  });
});
