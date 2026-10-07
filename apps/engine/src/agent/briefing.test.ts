import { describe, expect, test } from "bun:test";
import { UNDESCRIBED_METADATA } from "../api/catalog-metadata.ts";
import type { KnowledgeSourceView } from "../knowledge/types.ts";
import { countTokens } from "../llm/accounting/count.ts";
import type { Skill } from "../skills/types.ts";
import {
  type AssembleInput,
  type CatalogEntry,
  catalogInDomain,
  trimToBudget,
} from "./briefing.ts";

function makeSkill(n: number, bodyWords = 200): Skill {
  return {
    id: `00000000-0000-0000-0000-00000000000${n}`,
    tenant_id: "t1",
    scope: "global",
    connector_id: null,
    workflow_id: null,
    slug: `skill-${n}`,
    title: `Skill ${n}`,
    ...UNDESCRIBED_METADATA,
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
    description_source: "human",
    category: "other",
    category_source: "llm",
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

function makeEntry(kind: "wf" | "conn", n: number): CatalogEntry {
  return {
    id: `20000000-0000-0000-0000-00000000000${n}`,
    slug: `blog-de-${kind}-${n}`,
    name: `${kind === "wf" ? "Workflow" : "Connector"} ${n}`,
    description: `Does thing ${n} for the blog.`,
    category: "content",
  };
}

function input(overrides: Partial<AssembleInput> = {}): AssembleInput {
  return {
    domains: ["blog-de"],
    skills: [makeSkill(1), makeSkill(2), makeSkill(3)],
    knowledge: [makeKnowledge(1), makeKnowledge(2)],
    includeKnowledgeIndex: true,
    workflows: [makeEntry("wf", 1), makeEntry("wf", 2)],
    connectors: [makeEntry("conn", 1), makeEntry("conn", 2)],
    guides: [],
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

  test("lists the domain's workflows and connectors with name, slug, category and purpose", () => {
    const { markdown } = trimToBudget(input(), 16000);
    expect(markdown).toContain("## Workflows (run with `run_workflow` instead of rebuilding)");
    expect(markdown).toContain(
      "- **Workflow 1** (`blog-de-wf-1`, content) — Does thing 1 for the blog.",
    );
    expect(markdown).toContain("## Connectors");
    expect(markdown).toContain("- **Connector 2** (`blog-de-conn-2`, content)");
  });

  test("trims the catalog first — connectors, then workflows — before the knowledge index", () => {
    const full = trimToBudget(input(), 16000);
    const oneLess = trimToBudget(input(), countTokens(full.markdown) - 1);
    expect(oneLess.state).toEqual({
      fullBodyCount: 3,
      knowledgeCount: 2,
      workflowCount: 2,
      connectorCount: 1,
    });
    expect(oneLess.markdown).toContain("…and 1 more — call `find_connector` for the rest.");
    const noConnectors = trimToBudget(input({ connectors: [] }), 16000);
    const lessWorkflows = trimToBudget(
      input({ connectors: [] }),
      countTokens(noConnectors.markdown) - 1,
    );
    expect(lessWorkflows.state.workflowCount).toBe(1);
    expect(lessWorkflows.state.knowledgeCount).toBe(2);
  });

  test("trims the knowledge index before skill bodies", () => {
    const catalogFree = input({ workflows: [], connectors: [] });
    const full = trimToBudget(catalogFree, 16000);
    const oneLess = trimToBudget(catalogFree, countTokens(full.markdown) - 1);
    expect(oneLess.state.knowledgeCount).toBe(1);
    expect(oneLess.state.fullBodyCount).toBe(3);
    expect(oneLess.markdown).toContain("…and 1 more — call `list_knowledge_sources`");
  });

  test("lists the guides for working with sk as load pointers that are never trimmed", () => {
    const guide = {
      ...makeSkill(4, 2000),
      slug: "workflow-find-run-check",
      title: "Find a Workflow",
    };
    const { markdown } = trimToBudget(input({ guides: [guide] }), 1);
    expect(markdown).toContain("## Working with sk");
    expect(markdown).toContain(
      "- Find a Workflow — load via `get_skill`/`find_skill` (`workflow-find-run-check`).",
    );
    expect(markdown).not.toContain("word1999");
  });

  test("the same input renders the same briefing", () => {
    expect(trimToBudget(input(), 900)).toEqual(trimToBudget(input(), 900));
  });

  test("collapses skill bodies last skill first, keeping pointer lines", () => {
    const skills = [makeSkill(1, 20), makeSkill(2, 20), makeSkill(3, 2000)];
    const { markdown, state } = trimToBudget(input({ skills }), 800);
    expect(state.workflowCount).toBe(0);
    expect(state.connectorCount).toBe(0);
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

describe("catalogInDomain", () => {
  test("a category equal to the domain or a slug under it belongs to the domain", () => {
    expect(catalogInDomain({ slug: "weekly-digest", category: "radar" }, ["radar"])).toBe(true);
    expect(catalogInDomain({ slug: "radar-collect-raw", category: "other" }, ["radar"])).toBe(true);
    expect(catalogInDomain({ slug: "radar", category: "other" }, ["radar"])).toBe(true);
    expect(catalogInDomain({ slug: "radarx-collect", category: "other" }, ["radar"])).toBe(false);
    expect(
      catalogInDomain({ slug: "blog-de-sync", category: "content" }, ["radar", "blog-de"]),
    ).toBe(true);
  });
});
