import { describe, expect, test } from "bun:test";
import type { KnowledgeSourceView } from "../knowledge/types.ts";
import { countTokens } from "../llm/accounting/count.ts";
import type { Skill } from "../skills/types.ts";
import { type AssembleInput, trimToBudget } from "./briefing.ts";

function makeSkill(n: number, bodyWords = 200): Skill {
  return {
    id: `00000000-0000-0000-0000-00000000000${n}`,
    tenant_id: "t1",
    scope: "global",
    connector_id: null,
    workflow_id: null,
    slug: `skill-${n}`,
    title: `Skill ${n}`,
    body: Array.from({ length: bodyWords }, (_, i) => `word${i}`).join(" "),
    examples: [],
    best_practices: [],
    pitfalls: n === 1 ? ["never do the bad thing"] : [],
    doc_refs: [],
    gates_tools: [],
    activates_when: [],
    input_schema: null,
    output_schema: null,
    side_effects: "read",
    idempotency: "none",
    maturity: "stable",
    tags: ["domain:blog-de"],
    applies_to: "both",
    status: "active",
    source: "manual",
    version: 1,
    created_at: "2026-01-01T00:00:00.000Z",
    updated_at: "2026-01-01T00:00:00.000Z",
  };
}

function makeKnowledge(n: number): KnowledgeSourceView {
  return {
    id: `10000000-0000-0000-0000-00000000000${n}`,
    tenant_id: "t1",
    name: `Source ${n}`,
    slug: `source-${n}`,
    description: `Reference material number ${n} for the domain.`,
    tags: ["domain:blog-de"],
    scope: "global",
    workflow_id: null,
    status: "active",
    last_error: null,
    source_type: "inline",
    source_uri: "",
    mime_type: null,
    version: "v",
    bytes_total: 100,
    chunk_count: 3,
    refresh_strategy: "manual",
    refresh_cron: null,
    last_refreshed_at: null,
    created_at: "2026-01-01T00:00:00.000Z",
    updated_at: "2026-01-01T00:00:00.000Z",
  };
}

function input(overrides: Partial<AssembleInput> = {}): AssembleInput {
  return {
    domains: ["blog-de"],
    skills: [makeSkill(1), makeSkill(2), makeSkill(3)],
    knowledge: [makeKnowledge(1), makeKnowledge(2)],
    includeKnowledgeIndex: true,
    proposedCandidates: 2,
    ...overrides,
  };
}

describe("trimToBudget", () => {
  test("keeps everything when the budget is generous", () => {
    const { markdown, state } = trimToBudget(input(), 16000);
    expect(state.fullBodyCount).toBe(3);
    expect(state.knowledgeCount).toBe(2);
    expect(markdown).toContain("# sk session briefing — domains: blog-de");
    expect(markdown).toContain("## Conventions");
    expect(markdown).toContain("### Skill 1");
    expect(markdown).toContain("never do the bad thing");
    expect(markdown).toContain("## Knowledge index");
    expect(markdown).toContain("**Source 2**");
    expect(markdown).toContain("2 proposed skill candidate(s)");
    expect(markdown).toContain('search_knowledge` with `tags: ["domain:blog-de"]');
  });

  test("stays within the budget", () => {
    const budget = 600;
    const { markdown } = trimToBudget(input(), budget);
    expect(countTokens(markdown)).toBeLessThanOrEqual(budget);
  });

  test("trims the knowledge index before skill bodies", () => {
    // Force exactly one trim step: full render minus a single index entry.
    const full = trimToBudget(input(), 16000);
    const oneLess = trimToBudget(input(), countTokens(full.markdown) - 1);
    expect(oneLess.state.knowledgeCount).toBe(1);
    expect(oneLess.state.fullBodyCount).toBe(3);
    expect(oneLess.markdown).toContain("…and 1 more — call `list_knowledge_sources`");
  });

  test("collapses skill bodies last skill first, keeping pointer lines", () => {
    // Skills 1+2 stay small, skill 3 alone blows the budget — the trim must
    // drop the index, then collapse ONLY the last skill's body.
    const skills = [makeSkill(1, 20), makeSkill(2, 20), makeSkill(3, 2000)];
    const { markdown, state } = trimToBudget(input({ skills }), 800);
    expect(state.knowledgeCount).toBe(0);
    expect(state.fullBodyCount).toBe(2);
    expect(markdown).toContain("### Skill 1");
    expect(markdown).toContain("### Skill 2");
    expect(markdown).toContain("load via `get_skill`/`find_skill` (`skill-3`)");
  });

  test("never trims the header and grounding rule", () => {
    const { markdown } = trimToBudget(input(), 1);
    expect(markdown).toContain("# sk session briefing");
    expect(markdown).toContain("search_knowledge");
  });

  test("omits the knowledge index without knowledge:read", () => {
    const { markdown } = trimToBudget(input({ includeKnowledgeIndex: false }), 16000);
    expect(markdown).not.toContain("## Knowledge index");
  });

  test("renders no curation reminder when nothing is proposed", () => {
    const { markdown } = trimToBudget(input({ proposedCandidates: 0 }), 16000);
    expect(markdown).not.toContain("proposed skill candidate");
  });

  test("multi-domain header and search tags list every domain", () => {
    const { markdown } = trimToBudget(input({ domains: ["blog-de", "infra"] }), 16000);
    expect(markdown).toContain("domains: blog-de, infra");
    expect(markdown).toContain('"domain:blog-de", "domain:infra"');
  });
});
