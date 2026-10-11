import { and, eq, isNull } from "drizzle-orm";
import { PLATFORM_CATEGORY, UNCATEGORIZED } from "../api/catalog-metadata.ts";
import { listConnectors } from "../connectors/service.ts";
import type { Db } from "../db/client.ts";
import { files } from "../db/schema/index.ts";
import { listKnowledgeSources } from "../knowledge/service.ts";
import { DOMAIN_TAG_PREFIX } from "../knowledge/tags.ts";
import { listSkills } from "../skills/service.ts";
import { listWorkflowSummaries } from "../workflows/service.ts";

export const DOMAIN_PROMPT_MAX_CHARS = 2_000;
export const DOMAIN_REPO_MAX_CHARS = 200;

export interface ResolvedDomains {
  domains: string[];
  from_prompt: string[];
  from_repo: string[];
  from_folder: string[];
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

function normalizedFolder(text: string | undefined): string | null {
  if (!text) return null;
  if (text.includes("/") || text.includes("\\")) return null;
  const normalized = text
    .normalize("NFKD")
    .replace(/[\u0300-\u036f]/gu, "")
    .toLowerCase()
    .replace(/[^a-z0-9]+/gu, "-")
    .replace(/^-+|-+$/gu, "");
  return normalized || null;
}

export function resolveDomains(p: {
  prompt?: string | undefined;
  repo_hint?: string | undefined;
  folder_hint?: string | undefined;
  known: readonly string[];
}): ResolvedDomains {
  const known = [...new Set(p.known)].sort();
  const prompt = p.prompt?.slice(0, DOMAIN_PROMPT_MAX_CHARS);
  const repo = p.repo_hint?.slice(0, DOMAIN_REPO_MAX_CHARS);
  const folder = normalizedFolder(p.folder_hint?.slice(0, DOMAIN_REPO_MAX_CHARS));
  const from_prompt = known.filter((d) => mentions(prompt, d));
  const from_repo = known.filter((d) => mentions(repo, d));
  const from_folder = folder ? known.filter((d) => d === folder) : [];
  const domains = [...new Set([...from_prompt, ...from_repo, ...from_folder])].sort();
  return { domains, from_prompt, from_repo, from_folder };
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
  opts: {
    include_knowledge: boolean;
    workflow_visible: ((id: string) => boolean) | null;
    connector_visible: ((id: string) => boolean) | null;
    file_visible: ((id: string) => boolean) | null;
    file_tenant_wide: boolean;
  },
  db: Db,
): Promise<string[]> {
  const [skills, knowledge, workflows, connectors, fileRows] = await Promise.all([
    listSkills({ tenant_id, status: "active", limit: 500 }, db),
    opts.include_knowledge
      ? listKnowledgeSources({ tenant_id, status: "active", limit: 500 }, db)
      : Promise.resolve([]),
    opts.workflow_visible
      ? listWorkflowSummaries(tenant_id, { status: "active" }, db).then((result) => result.rows)
      : Promise.resolve([]),
    opts.connector_visible
      ? listConnectors(tenant_id, { enabled: true }, db).then((result) => result.rows)
      : Promise.resolve([]),
    opts.file_visible
      ? opts.file_tenant_wide
        ? db
            .select({ category: files.category })
            .from(files)
            .where(
              and(
                eq(files.tenant_id, tenant_id),
                eq(files.status, "ready"),
                isNull(files.deleted_at),
              ),
            )
            .groupBy(files.category)
        : db
            .select({ id: files.id, category: files.category })
            .from(files)
            .where(
              and(
                eq(files.tenant_id, tenant_id),
                eq(files.status, "ready"),
                isNull(files.deleted_at),
              ),
            )
      : Promise.resolve([]),
  ]);
  const known = new Set<string>();
  for (const item of [...skills, ...knowledge]) {
    for (const domain of domainsOfItem(item)) known.add(domain);
  }
  for (const workflow of workflows) {
    if (opts.workflow_visible?.(workflow.id)) addCategory(known, workflow.category);
  }
  for (const connector of connectors) {
    if (opts.connector_visible?.(connector.id)) addCategory(known, connector.category);
  }
  for (const file of fileRows) {
    if (!("id" in file) || (typeof file.id === "string" && opts.file_visible?.(file.id))) {
      addCategory(known, file.category);
    }
  }
  return [...known].sort();
}

function addCategory(domains: Set<string>, category: string | null | undefined): void {
  if (category && category !== UNCATEGORIZED && category !== PLATFORM_CATEGORY) {
    domains.add(category);
  }
}
