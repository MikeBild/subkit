import { PLATFORM_CATEGORY, UNCATEGORIZED } from "../api/catalog-metadata.ts";
import type { Db } from "../db/client.ts";
import { listKnowledgeSources } from "../knowledge/service.ts";
import { DOMAIN_TAG_PREFIX } from "../knowledge/tags.ts";
import { listSkills } from "../skills/service.ts";

export const DOMAIN_PROMPT_MAX_CHARS = 2_000;
export const DOMAIN_REPO_MAX_CHARS = 200;

export interface ResolvedDomains {
  domains: string[];
  from_prompt: string[];
  from_repo: string[];
}

function words(text: string): Set<string> {
  return new Set(
    text
      .toLowerCase()
      .split(/[^\p{L}\p{N}_]+/u)
      .filter(Boolean),
  );
}

function mentions(text: string | undefined, domain: string): boolean {
  if (!text) return false;
  const present = words(text);
  return domain.split("-").every((part) => part.length > 0 && present.has(part));
}

export function resolveDomains(p: {
  prompt?: string | undefined;
  repo_hint?: string | undefined;
  known: readonly string[];
}): ResolvedDomains {
  const known = [...new Set(p.known)].sort();
  const prompt = p.prompt?.slice(0, DOMAIN_PROMPT_MAX_CHARS);
  const repo = p.repo_hint?.slice(0, DOMAIN_REPO_MAX_CHARS);
  const from_prompt = known.filter((d) => mentions(prompt, d));
  const from_repo = known.filter((d) => mentions(repo, d));
  const domains = [...new Set([...from_prompt, ...from_repo])].sort();
  return { domains, from_prompt, from_repo };
}

export function domainsOfTags(tags: readonly string[]): string[] {
  return tags
    .filter((t) => t.startsWith(DOMAIN_TAG_PREFIX) && t.length > DOMAIN_TAG_PREFIX.length)
    .map((t) => t.slice(DOMAIN_TAG_PREFIX.length));
}

export function domainsOfItem(item: {
  tags: readonly string[];
  category?: string | null;
}): string[] {
  const domains = new Set(domainsOfTags(item.tags));
  if (item.category && item.category !== UNCATEGORIZED && item.category !== PLATFORM_CATEGORY) {
    domains.add(item.category);
  }
  return [...domains];
}

export async function listKnownDomains(
  tenant_id: string,
  opts: { include_knowledge: boolean },
  db: Db,
): Promise<string[]> {
  const [skills, knowledge] = await Promise.all([
    listSkills({ tenant_id, status: "active", limit: 500 }, db),
    opts.include_knowledge
      ? listKnowledgeSources({ tenant_id, status: "active", limit: 500 }, db)
      : Promise.resolve([]),
  ]);
  const known = new Set<string>();
  for (const item of [...skills, ...knowledge]) {
    for (const domain of domainsOfItem(item)) known.add(domain);
  }
  return [...known].sort();
}
