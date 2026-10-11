import { describe, expect, test } from "bun:test";
import { UNDESCRIBED_METADATA } from "../api/catalog-metadata.ts";
import type { KnowledgeSourceView } from "../knowledge/types.ts";
import { countTokens } from "../llm/accounting/count.ts";
import type { Skill } from "../skills/types.ts";
import {
  type AssembleInput,
  type CatalogEntry,
  catalogInDomain,
  inDomain,
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
    files: [],
    guides: [],
    proposedCandidates: 2,
    ...overrides,
  };
}

describe("trimToBudget", () => {
  test("intake reminder contains only tenant-wide counts and separates them from knowledge", () => {
    const { markdown } = trimToBudget(
      input({ intake: { collected: 3, reviewing: 1, proposals: 2 } }),
      16000,
    );
    expect(markdown).toContain("3 collected, 1 under review, 2 proposals");
    expect(markdown).toContain("not accepted knowledge");
    expect(markdown).toContain("necessarily related");
    expect(markdown).toContain("do not preload clips");
    expect(markdown).toContain("confirm its admission");
  });

  test("unavailable or empty intake does not add a reminder", () => {
    for (const intake of [null, { collected: 0, reviewing: 0, proposals: 0 }]) {
      expect(trimToBudget(input({ intake }), 16000).markdown).not.toContain(
        "Collected material awaiting review",
      );
    }
  });

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
    expect(markdown).toContain("2 suggestions are ready for review");
    expect(markdown).toContain("in the user's language");
    expect(markdown).not.toContain("sk learnings review");
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

  test("lists safe file metadata and trims it within the budget", () => {
    const files = [
      {
        name: "Invoices.csv",
        slug: "invoices-schema",
        category: "blog-de",
        description: "Import schema.",
      },
      {
        name: "Archive.csv",
        slug: null,
        category: "blog-de",
        description: null,
      },
    ];
    const fileInput = input({ files, workflows: [], connectors: [] });
    const full = trimToBudget(fileInput, 16000);
    expect(full.markdown).toContain("## Files");
    expect(full.markdown).toContain("Invoices.csv");
    const trimmed = trimToBudget(fileInput, countTokens(full.markdown) - 1);
    expect(trimmed.state.fileCount).toBeLessThan(2);
    expect(trimmed.markdown).toContain("call `list_files` for the rest.");
  });

  test("trims the catalog first — connectors, then workflows — before the knowledge index", () => {
    const full = trimToBudget(input(), 16000);
    const oneLess = trimToBudget(input(), countTokens(full.markdown) - 1);
    expect(oneLess.state).toEqual({
      fullBodyCount: 3,
      knowledgeCount: 2,
      workflowCount: 2,
      connectorCount: 1,
      fileCount: 0,
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

  test("describes collected material without a CLI action or implicit admission", () => {
    const { markdown } = trimToBudget(
      input({ intake: { collected: 1, reviewing: 0, proposals: 0 } }),
      16000,
    );
    expect(markdown).toContain(
      "Offer to review collected entries when relevant, in the user's language",
    );
    expect(markdown).toContain(
      "A person must review the exact proposal and confirm its admission in the Cockpit.",
    );
    expect(markdown).not.toContain("sk learnings review");
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

describe("inDomain", () => {
  test("a domain tag or the category places a skill or source in the domain", () => {
    expect(inDomain({ tags: ["domain:ops"], category: "other" }, ["ops"])).toBe(true);
    expect(inDomain({ tags: [], category: "ops" }, ["ops"])).toBe(true);
    expect(inDomain({ tags: ["foundations"], category: "platform" }, ["ops"])).toBe(false);
    expect(inDomain({ tags: ["domain:radar"], category: null }, ["ops", "radar"])).toBe(true);
  });
});
