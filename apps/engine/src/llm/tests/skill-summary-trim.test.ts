// Skill ambient-rendering pattern: applicable-but-not-loaded skills
// render as a single per-scope INDEX block (one line per skill,
// slug + title + first-line description). The LLM uses
// `load_skill(<slug>)` to fetch the full body when it needs the
// rules. Loaded skills (via explicit load_skill calls) carry the
// full body via `formatSkill`.
//
// Pattern mirrors the validated reference-impl shape: a tiny catalog
// in the system prompt, full bodies on demand. Pre-fix every
// applicable skill rendered with its full body (~31k tokens of
// skills per turn in session a128deba). Post-index-pattern the
// ambient cost is bounded by skill count rather than by each skill's
// body content.
//
// We can't unit-test the full assembler without a DB, so this test
// reads the source and asserts the index helper exists + the ambient
// sections route through it.

import { describe, expect, test } from "bun:test";
import { readFileSync } from "node:fs";
import { join } from "node:path";

// After the Phase 4 split (audit §4.2), the assembler is split across
// `core/context-assembler.ts` (orchestrator) and
// `core/context-assembler/{formatters,loaders,skill-picker}.ts`. The
// `formatSkillIndex` helper lives in `formatters.ts`; the routing
// call sites stay in `context-assembler.ts`.
const SRC = join(import.meta.dir, "..", "core", "context-assembler.ts");
const FORMATTERS = join(import.meta.dir, "..", "core", "context-assembler", "formatters.ts");

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
    // Per repo policy (no backwards-compat shims): the per-skill
    // summary helper should not coexist with the index helper.
    expect(body).not.toContain("function formatSkillSummary");
  });
});
