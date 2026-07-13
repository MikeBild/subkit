// Session briefing for external coding agents (Claude Code, Codex, …).
//
// A SessionStart hook calls `GET /v1/agent/briefing?domains=…` and injects the
// returned markdown into the fresh session. The briefing carries the domain's
// prescriptive conventions (skill bodies) plus a knowledge INDEX — full
// documents stay behind `search_knowledge_v2` so the session grounds by
// lookup instead of preloading everything (context economy).
//
// Domain = tag convention `domain:<slug>` on skills and knowledge sources.
// No new table: both rows already carry `tags text[]`.

import type { Db } from "../db/client.ts";
import { listKnowledgeSources } from "../knowledge/service.ts";
import type { KnowledgeSourceView } from "../knowledge/types.ts";
import { countTokens } from "../llm/accounting/count.ts";
import { listSkillCandidates } from "../skill-candidates/index.ts";
import { listSkills } from "../skills/service.ts";
import type { Skill } from "../skills/types.ts";

export const DOMAIN_TAG_PREFIX = "domain:";
export const DOMAIN_SLUG_RE = /^[a-z0-9][a-z0-9_-]*$/;

export const DEFAULT_BRIEFING_BUDGET_TOKENS = 4000;
export const MIN_BRIEFING_BUDGET_TOKENS = 500;
export const MAX_BRIEFING_BUDGET_TOKENS = 16000;

export interface BriefingParams {
  tenant_id: string;
  /** Domain slugs (without the `domain:` prefix). */
  domains: string[];
  budget_tokens: number;
  /** Principal holds `knowledge:read`; without it the index section is omitted. */
  include_knowledge_index: boolean;
  db: Db;
}

export interface BriefingResult {
  markdown: string;
  domains: string[];
  budget_tokens: number;
  used_tokens: number;
  /** Skills whose full body made it into the markdown. */
  skills_full: string[];
  /** Skills trimmed to a title-only pointer line to fit the budget. */
  skills_title_only: string[];
  /** Knowledge sources listed in the index section. */
  knowledge_sources: string[];
  /** Index entries dropped to fit the budget. */
  knowledge_sources_omitted: number;
  proposed_candidates: number;
}

function domainTags(domains: string[]): Set<string> {
  return new Set(domains.map((d) => `${DOMAIN_TAG_PREFIX}${d}`));
}

function matchesDomain(tags: string[], wanted: Set<string>): boolean {
  return tags.some((t) => wanted.has(t));
}

function skillSection(skill: Skill): string {
  const parts = [`### ${skill.title}`, "", skill.body.trim()];
  if (skill.pitfalls.length > 0) {
    parts.push("", "Pitfalls:", ...skill.pitfalls.map((p) => `- ${p}`));
  }
  return parts.join("\n");
}

function skillPointerLine(skill: Skill): string {
  const ref = skill.slug ?? skill.title;
  return `- ${skill.title} — body trimmed for budget; load via \`get_skill\`/\`find_skill\` (\`${ref}\`).`;
}

function knowledgeIndexLine(src: KnowledgeSourceView): string {
  const desc = src.description?.trim() ? ` — ${src.description.trim()}` : "";
  return `- **${src.name}** (\`${src.slug}\`)${desc}`;
}

export interface AssembleInput {
  domains: string[];
  skills: Skill[];
  knowledge: KnowledgeSourceView[];
  includeKnowledgeIndex: boolean;
  proposedCandidates: number;
}

export interface AssembleState {
  /** Skills rendered with full body; the rest render as pointer lines. */
  fullBodyCount: number;
  /** Knowledge index entries kept; the rest collapse into a "+N more" line. */
  knowledgeCount: number;
}

function assemble(input: AssembleInput, state: AssembleState): string {
  const lines: string[] = [
    `# sk session briefing — domains: ${input.domains.join(", ")}`,
    "",
    "Grounding rule: for facts of these domains, look up instead of guessing —",
    `call \`search_knowledge_v2\` with \`tags: ["${[...domainTags(input.domains)].join('", "')}"]\`.`,
    "If the search returns nothing, say so; do not invent domain internals.",
  ];

  if (input.skills.length > 0) {
    lines.push("", "## Conventions");
    const full = input.skills.slice(0, state.fullBodyCount);
    const trimmed = input.skills.slice(state.fullBodyCount);
    for (const skill of full) lines.push("", skillSection(skill));
    if (trimmed.length > 0) {
      lines.push("");
      for (const skill of trimmed) lines.push(skillPointerLine(skill));
    }
  }

  if (input.includeKnowledgeIndex && input.knowledge.length > 0) {
    lines.push("", "## Knowledge index (search, don't preload)");
    const kept = input.knowledge.slice(0, state.knowledgeCount);
    for (const src of kept) lines.push(knowledgeIndexLine(src));
    const omitted = input.knowledge.length - kept.length;
    if (omitted > 0) {
      lines.push(`- …and ${omitted} more — call \`list_knowledge_sources\` for the full index.`);
    }
  }

  if (input.proposedCandidates > 0) {
    lines.push(
      "",
      `Curation reminder: ${input.proposedCandidates} proposed skill candidate(s) await human review.`,
    );
  }

  return lines.join("\n");
}

/**
 * Deterministic budget trim, cheapest information loss first:
 * 1. drop knowledge-index entries from the end (a pointer line keeps them reachable),
 * 2. then collapse skill bodies to pointer lines, last skill first.
 * The header + grounding rule are never trimmed.
 */
export function trimToBudget(
  input: AssembleInput,
  budget_tokens: number,
): { markdown: string; state: AssembleState } {
  const state: AssembleState = {
    fullBodyCount: input.skills.length,
    knowledgeCount: input.knowledge.length,
  };
  let markdown = assemble(input, state);
  while (countTokens(markdown) > budget_tokens && state.knowledgeCount > 0) {
    state.knowledgeCount -= 1;
    markdown = assemble(input, state);
  }
  while (countTokens(markdown) > budget_tokens && state.fullBodyCount > 0) {
    state.fullBodyCount -= 1;
    markdown = assemble(input, state);
  }
  return { markdown, state };
}

export async function buildAgentBriefing(p: BriefingParams): Promise<BriefingResult> {
  const wanted = domainTags(p.domains);

  const [allSkills, allKnowledge, proposed] = await Promise.all([
    listSkills({ tenant_id: p.tenant_id, status: "active", limit: 500 }, p.db),
    p.include_knowledge_index
      ? listKnowledgeSources({ tenant_id: p.tenant_id, status: "active", limit: 500 }, p.db)
      : Promise.resolve([]),
    listSkillCandidates({ tenant_id: p.tenant_id, status: "proposed", limit: 500 }, p.db),
  ]);

  const skills = allSkills
    .filter((s) => matchesDomain(s.tags, wanted))
    .sort((a, b) => a.title.localeCompare(b.title));
  const knowledge = allKnowledge
    .filter((k) => matchesDomain(k.tags, wanted))
    .sort((a, b) => a.name.localeCompare(b.name));

  const { markdown, state } = trimToBudget(
    {
      domains: p.domains,
      skills,
      knowledge,
      includeKnowledgeIndex: p.include_knowledge_index,
      proposedCandidates: proposed.length,
    },
    p.budget_tokens,
  );

  return {
    markdown,
    domains: p.domains,
    budget_tokens: p.budget_tokens,
    used_tokens: countTokens(markdown),
    skills_full: skills.slice(0, state.fullBodyCount).map((s) => s.slug ?? s.title),
    skills_title_only: skills.slice(state.fullBodyCount).map((s) => s.slug ?? s.title),
    knowledge_sources: knowledge.slice(0, state.knowledgeCount).map((k) => k.slug),
    knowledge_sources_omitted: knowledge.length - state.knowledgeCount,
    proposed_candidates: proposed.length,
  };
}
