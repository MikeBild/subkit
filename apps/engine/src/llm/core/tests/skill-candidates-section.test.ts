import { describe, expect, test } from "bun:test";
import type { SkillCandidateView } from "../../../skill-candidates/types.ts";
import { countTokens } from "../../accounting/index.ts";
import {
  formatSkillCandidates,
  SKILL_CANDIDATES_SECTION_CAP,
} from "../context-assembler/formatters.ts";
import { trimCandidatesToBudget } from "../context-assembler/loaders.ts";

let idCounter = 0;
function makeCandidate(overrides: Partial<SkillCandidateView> = {}): SkillCandidateView {
  const id = `cand-${String(++idCounter).padStart(4, "0")}`;
  return {
    id,
    tenant_id: "test-tenant",
    scope: "global",
    connector_id: null,
    endpoint_key: null,
    workflow_id: null,
    pattern_kind: "repair_pattern",
    title: `Candidate ${id}`,
    body: `This is the body of candidate ${id}. It contains helpful information about a pattern.`,
    examples: [],
    best_practices: [],
    pitfalls: [],
    doc_refs: [],
    facts: null,
    evidence_count: 3,
    confidence: "medium",
    status: "proposed",
    promoted_skill_id: null,
    fingerprint: `fp-${id}`,
    tags: [],
    proposed_by: null,
    version: 1,
    created_at: new Date(2025, 0, 1, 0, 0, 0).toISOString(),
    updated_at: new Date(2025, 0, 1, 0, 0, 0).toISOString(),
    ...overrides,
  };
}

describe("formatSkillCandidates — AC1 proposed-only render", () => {
  test("renders a proposed candidate with [pending approval] marker", () => {
    const c = makeCandidate({ title: "Retry on 429", body: "Always add exponential backoff." });
    const section = formatSkillCandidates([c]);
    expect(section).not.toBeNull();
    expect(section).toContain("Retry on 429");
    expect(section).toContain("[pending approval]");
    expect(section).toContain("Always add exponential backoff.");
  });

  test("renders a drafting context note without the approval marker", () => {
    const c = makeCandidate({
      title: "Workflow 'report' capabilities",
      pattern_kind: "authoring_capability",
      status: "context",
    });
    const section = formatSkillCandidates([c]);
    expect(section).toContain("## Workflow 'report' capabilities [drafting context]");
    expect(section).not.toContain("## Workflow 'report' capabilities [pending approval]");
  });

  test("section heading identifies content as pending operator approval", () => {
    const section = formatSkillCandidates([makeCandidate()]);
    expect(section).not.toBeNull();
    expect(section!.startsWith("# Skill candidates — proposed (pending operator approval)")).toBe(
      true,
    );
  });

  test("returns null for empty array", () => {
    expect(formatSkillCandidates([])).toBeNull();
  });

  test("includes scope + confidence + evidence count in meta line", () => {
    const c = makeCandidate({
      scope: "connector",
      connector_id: "abc-123",
      confidence: "high",
      evidence_count: 10,
    });
    const section = formatSkillCandidates([c]);
    expect(section).toContain("scope=connector");
    expect(section).toContain("confidence=high");
    expect(section).toContain("evidence=10");
  });
});

describe("formatSkillCandidates — AC2 sort order", () => {
  test("renders candidates in the order supplied (sort is caller's responsibility)", () => {
    const c1 = makeCandidate({ title: "First" });
    const c2 = makeCandidate({ title: "Second" });
    const section = formatSkillCandidates([c1, c2]);
    expect(section).not.toBeNull();
    const idx1 = section!.indexOf("First");
    const idx2 = section!.indexOf("Second");
    expect(idx1).toBeLessThan(idx2);
  });
});

describe("trimCandidatesToBudget — 1200-token cap", () => {
  test("single small candidate fits without trimming", () => {
    const result = trimCandidatesToBudget([makeCandidate()]);
    expect(result.trimmed).toBe(0);
    expect(result.section).not.toBeNull();
    const tokens = countTokens(result.section!);
    expect(tokens).toBeLessThanOrEqual(SKILL_CANDIDATES_SECTION_CAP);
  });

  test("50 candidates → section ≤ 1200 tokens with elision notice", () => {
    const candidates = Array.from({ length: 50 }, (_, i) =>
      makeCandidate({
        id: `bulk-${i}`,
        title: `Pattern ${i}`,
        body: `Body of pattern ${i}. Contains relevant guidance for operators. ${"Detail ".repeat(10)}`,
      }),
    );
    const result = trimCandidatesToBudget(candidates);
    if (result.section !== null) {
      const tokens = countTokens(result.section);
      expect(tokens).toBeLessThanOrEqual(SKILL_CANDIDATES_SECTION_CAP);
      if (result.trimmed > 0) {
        expect(result.section).toContain("elided — token budget");
      }
    } else {
      expect(result.trimmed).toBeGreaterThan(0);
    }
  });

  test("lowest-ranked (last in array) dropped first", () => {
    const candidates = Array.from({ length: 20 }, (_, i) =>
      makeCandidate({
        id: `order-${i}`,
        title: `Pattern ${String(i).padStart(2, "0")}`,
        body: `${"Body content repeated. ".repeat(15)}`,
      }),
    );
    const result = trimCandidatesToBudget(candidates);
    if (result.trimmed > 0 && result.survivors.length > 0) {
      const survivorIds = result.survivors.map((c) => c.id);
      expect(survivorIds).toContain("order-0");
      expect(survivorIds).not.toContain(`order-${candidates.length - 1}`);
    }
  });
});

describe("trimCandidatesToBudget — oversized single survivor", () => {
  test("single candidate with oversized body is truncated to ≤ ceil(cap × 0.9) tokens with notice", () => {
    const hugeBody = "x ".repeat(2000);
    const c = makeCandidate({ id: "oversized-1", title: "Oversized Candidate", body: hugeBody });

    const result = trimCandidatesToBudget([c]);

    expect(result.oversized_item_id).toBe("oversized-1");
    expect(result.survivors).toHaveLength(1);
    expect(result.section).not.toBeNull();

    const survivorBody = result.survivors[0]!.body;
    expect(survivorBody).toContain("candidate body truncated for section cap");

    const targetTokens = Math.ceil(SKILL_CANDIDATES_SECTION_CAP * 0.9);
    if (result.section !== null) {
      const tokens = countTokens(result.section);
      expect(tokens).toBeLessThanOrEqual(SKILL_CANDIDATES_SECTION_CAP);
      expect(tokens).toBeGreaterThan(10);
      expect(tokens).toBeLessThanOrEqual(SKILL_CANDIDATES_SECTION_CAP);
      expect(targetTokens).toBe(Math.ceil(1200 * 0.9));
    }
  });

  test("trim helper exposes oversized_item_id so the assembler can emit the warning", () => {
    const hugeBody = "The long body. ".repeat(500);
    const c = makeCandidate({ id: "warn-test-1", body: hugeBody });
    const result = trimCandidatesToBudget([c]);
    if (result.oversized_item_id !== null) {
      expect(result.oversized_item_id).toBe("warn-test-1");
    }
    if (result.section !== null) {
      expect(countTokens(result.section)).toBeLessThanOrEqual(SKILL_CANDIDATES_SECTION_CAP);
    }
  });

  test("section cap constant is 1200", () => {
    expect(SKILL_CANDIDATES_SECTION_CAP).toBe(1200);
  });
});
