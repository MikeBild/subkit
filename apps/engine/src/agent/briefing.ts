import { listConnectors } from "../connectors/service.ts";
import type { Db } from "../db/client.ts";
import { listKnowledgeSources } from "../knowledge/service.ts";
import { DOMAIN_TAG_PREFIX } from "../knowledge/tags.ts";
import type { KnowledgeSourceView } from "../knowledge/types.ts";
import { countTokens } from "../llm/accounting/count.ts";
import { listSkillCandidates } from "../skill-candidates/index.ts";
import { listSkills } from "../skills/service.ts";
import type { Skill } from "../skills/types.ts";
import { listWorkflowSummaries } from "../workflows/service.ts";

export const DOMAIN_SLUG_RE = /^[a-z0-9][a-z0-9_-]*$/;

export const DEFAULT_BRIEFING_BUDGET_TOKENS = 4000;
export const MIN_BRIEFING_BUDGET_TOKENS = 500;
export const MAX_BRIEFING_BUDGET_TOKENS = 16000;

export interface CatalogEntry {
  id: string;
  slug: string;
  name: string;
  description: string | null;
  category: string;
}

export interface BriefingParams {
  tenant_id: string;
  domains: string[];
  budget_tokens: number;
  include_knowledge_index: boolean;
  workflow_visible: ((id: string) => boolean) | null;
  connector_visible: ((id: string) => boolean) | null;
  db: Db;
}

export interface BriefingResult {
  markdown: string;
  domains: string[];
  budget_tokens: number;
  used_tokens: number;
  skills_full: string[];
  skills_title_only: string[];
  knowledge_sources: string[];
  knowledge_sources_omitted: number;
  workflows: string[];
  workflows_omitted: number;
  connectors: string[];
  connectors_omitted: number;
  proposed_candidates: number;
}

function domainTags(domains: string[]): Set<string> {
  return new Set(domains.map((d) => `${DOMAIN_TAG_PREFIX}${d}`));
}

function matchesDomain(tags: string[], wanted: Set<string>): boolean {
  return tags.some((t) => wanted.has(t));
}

export function catalogInDomain(entry: Pick<CatalogEntry, "slug" | "category">, domains: string[]) {
  return domains.some(
    (d) => entry.category === d || entry.slug === d || entry.slug.startsWith(`${d}-`),
  );
}

function byNameThenSlug(a: CatalogEntry, b: CatalogEntry): number {
  return a.name.localeCompare(b.name) || a.slug.localeCompare(b.slug);
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

function catalogLine(entry: CatalogEntry): string {
  const desc = entry.description?.trim() ? ` — ${entry.description.trim()}` : "";
  return `- **${entry.name}** (\`${entry.slug}\`, ${entry.category})${desc}`;
}

export interface AssembleInput {
  domains: string[];
  skills: Skill[];
  knowledge: KnowledgeSourceView[];
  includeKnowledgeIndex: boolean;
  workflows: CatalogEntry[];
  connectors: CatalogEntry[];
  proposedCandidates: number;
}

export interface AssembleState {
  fullBodyCount: number;
  knowledgeCount: number;
  workflowCount: number;
  connectorCount: number;
}

function catalogSection(
  lines: string[],
  heading: string,
  entries: CatalogEntry[],
  kept: number,
  more: string,
): void {
  if (entries.length === 0) return;
  lines.push("", heading);
  for (const entry of entries.slice(0, kept)) lines.push(catalogLine(entry));
  const omitted = entries.length - kept;
  if (omitted > 0) lines.push(`- …and ${omitted} more — ${more}`);
}

function assemble(input: AssembleInput, state: AssembleState): string {
  const lines: string[] = [
    `# sk session briefing — domains: ${input.domains.join(", ")}`,
    "",
    "Grounding rule: for facts of these domains, look up instead of guessing —",
    `call \`search_knowledge\` with \`tags: ["${[...domainTags(input.domains)].join('", "')}"]\`.`,
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

  catalogSection(
    lines,
    "## Workflows (run with `run_workflow` instead of rebuilding)",
    input.workflows,
    state.workflowCount,
    "call `find_workflow` for the rest.",
  );
  catalogSection(
    lines,
    "## Connectors",
    input.connectors,
    state.connectorCount,
    "call `find_connector` for the rest.",
  );

  if (input.proposedCandidates > 0) {
    lines.push(
      "",
      `Curation reminder: ${input.proposedCandidates} proposed skill candidate(s) await human review — \`sk learnings review\`, or ask here to approve one.`,
    );
  }

  return lines.join("\n");
}

export function trimToBudget(
  input: AssembleInput,
  budget_tokens: number,
): { markdown: string; state: AssembleState } {
  const state: AssembleState = {
    fullBodyCount: input.skills.length,
    knowledgeCount: input.knowledge.length,
    workflowCount: input.workflows.length,
    connectorCount: input.connectors.length,
  };
  let markdown = assemble(input, state);
  const over = () => countTokens(markdown) > budget_tokens;
  const steps: Array<keyof AssembleState> = [
    "connectorCount",
    "workflowCount",
    "knowledgeCount",
    "fullBodyCount",
  ];
  for (const step of steps) {
    while (over() && state[step] > 0) {
      state[step] -= 1;
      markdown = assemble(input, state);
    }
  }
  return { markdown, state };
}

async function catalogFor(
  p: BriefingParams,
): Promise<{ workflows: CatalogEntry[]; connectors: CatalogEntry[] }> {
  const [workflowRows, connectorRows] = await Promise.all([
    p.workflow_visible
      ? listWorkflowSummaries(p.tenant_id, { status: "active" }, p.db).then((r) => r.rows)
      : Promise.resolve([]),
    p.connector_visible
      ? listConnectors(p.tenant_id, { enabled: true }, p.db).then((r) => r.rows)
      : Promise.resolve([]),
  ]);
  const workflowVisible = p.workflow_visible;
  const connectorVisible = p.connector_visible;
  const workflows = workflowRows
    .filter((w) => workflowVisible?.(w.id) && catalogInDomain(w, p.domains))
    .map((w) => ({
      id: w.id,
      slug: w.slug,
      name: w.name,
      description: w.description,
      category: w.category,
    }))
    .sort(byNameThenSlug);
  const connectors = connectorRows
    .filter((c) => connectorVisible?.(c.id) && catalogInDomain(c, p.domains))
    .map((c) => ({
      id: c.id,
      slug: c.slug,
      name: c.display_name,
      description: c.description,
      category: c.category,
    }))
    .sort(byNameThenSlug);
  return { workflows, connectors };
}

export async function buildAgentBriefing(p: BriefingParams): Promise<BriefingResult> {
  const wanted = domainTags(p.domains);

  const [allSkills, allKnowledge, proposed, catalog] = await Promise.all([
    listSkills({ tenant_id: p.tenant_id, status: "active", limit: 500 }, p.db),
    p.include_knowledge_index
      ? listKnowledgeSources({ tenant_id: p.tenant_id, status: "active", limit: 500 }, p.db)
      : Promise.resolve([]),
    listSkillCandidates({ tenant_id: p.tenant_id, status: "proposed", limit: 500 }, p.db),
    catalogFor(p),
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
      workflows: catalog.workflows,
      connectors: catalog.connectors,
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
    workflows: catalog.workflows.slice(0, state.workflowCount).map((w) => w.slug),
    workflows_omitted: catalog.workflows.length - state.workflowCount,
    connectors: catalog.connectors.slice(0, state.connectorCount).map((c) => c.slug),
    connectors_omitted: catalog.connectors.length - state.connectorCount,
    proposed_candidates: proposed.length,
  };
}
