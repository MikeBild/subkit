import { describe, expect, test } from "bun:test";
import { readFileSync } from "node:fs";
import { join } from "node:path";

const SRC = join(import.meta.dir, "..", "runtime", "context-assembler.ts");
const FORMATTERS = join(import.meta.dir, "..", "runtime", "context-assembler", "formatters.ts");

describe("context-assembler · skill index rendering", () => {
  const body = readFileSync(SRC, "utf-8");
  const formatters = readFileSync(FORMATTERS, "utf-8");

  test("formatSkillIndex helper exists", () => {
    expect(formatters).toContain("function formatSkillIndex");
  });

  test("globalSkills / connectorSkills / workflowSkills route through formatSkillIndex", () => {
    expect(body).toMatch(/formatSkillIndex\("Global", globalSkills/);
    expect(body).toMatch(/formatSkillIndex\("Connector", connectorSkills/);
    expect(body).toMatch(/formatSkillIndex\("Workflow", workflowSkills/);
  });

  test("loadedSkills still route through full formatSkill", () => {
    expect(body).toMatch(/for \(const s of loadedSkills\) sections\.push\(formatSkill\(/);
  });

  test("the index block mentions load_skill so the LLM knows how to expand", () => {
    expect(body).toContain("load_skill");
    expect(body).toContain("formatSkillIndex");
  });

  test("the legacy formatSkillSummary helper has been retired", () => {
    expect(body).not.toContain("function formatSkillSummary");
  });
});
