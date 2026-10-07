import { and, desc, eq } from "drizzle-orm";
import type { Actor } from "../audit/actor.ts";
import type { Executor } from "../db/client.ts";
import { knowledgeSourceVersions } from "../db/schema/knowledge_sources.ts";
import { KnowledgeSlugConflictError } from "./bundle-service.ts";
import {
  applyKnowledgeCreate,
  applyKnowledgeIngest,
  finishKnowledgeWrite,
  getKnowledgeSourceBySlug,
  prepareKnowledgeCreate,
  prepareKnowledgeIngest,
  updateKnowledgeSource,
} from "./service.ts";
import { DOMAIN_TAG_PREFIX, dedupeTags } from "./tags.ts";
import type { CreateKnowledgeSourceParams, IngestKnowledgeSourceParams } from "./types.ts";
import { learningNote } from "./version-record.ts";

export const LEARNINGS_SLUG = "learnings";

export interface LearningsTarget {
  slug: string;
  name: string;
  domain: string | null;
  tags: string[];
}

export function learningsTarget(tags: readonly string[]): LearningsTarget {
  const domainTags = dedupeTags(
    tags.filter((t) => t.startsWith(DOMAIN_TAG_PREFIX) && t.length > DOMAIN_TAG_PREFIX.length),
  );
  const first = domainTags[0];
  const domain = first ? first.slice(DOMAIN_TAG_PREFIX.length) : null;
  return domain
    ? {
        slug: `${LEARNINGS_SLUG}-${domain}`,
        name: `Learnings · ${domain}`,
        domain,
        tags: domainTags,
      }
    : { slug: LEARNINGS_SLUG, name: "Learnings", domain: null, tags: [] };
}

export function learningSection(entry: { title: string; body: string }): string {
  return `## ${entry.title.trim()}\n\n${entry.body.trim()}\n`;
}

export function appendLearning(current: string, entry: { title: string; body: string }): string {
  const base = current.replace(/\s+$/, "");
  return `${base}\n\n${learningSection(entry)}`;
}

export function initialLearnings(target: LearningsTarget, entry: { title: string; body: string }) {
  return `# ${target.name}\n\n${learningSection(entry)}`;
}

export interface AppliedLearning {
  knowledge_source_id: string;
  slug: string;
  version: number | null;
}

async function latestText(
  db: Executor,
  tenant_id: string,
  knowledge_source_id: string,
): Promise<{ text: string; filename: string } | null> {
  const [row] = await db
    .select({ content: knowledgeSourceVersions.content })
    .from(knowledgeSourceVersions)
    .where(
      and(
        eq(knowledgeSourceVersions.tenant_id, tenant_id),
        eq(knowledgeSourceVersions.knowledge_source_id, knowledge_source_id),
      ),
    )
    .orderBy(desc(knowledgeSourceVersions.version))
    .limit(1);
  if (row?.content.kind !== "document") return null;
  return { text: row.content.text, filename: row.content.filename };
}

export async function appendLearningToKnowledge(
  tx: Executor,
  p: {
    tenant_id: string;
    title: string;
    body: string;
    tags: readonly string[];
    approver: Actor | null;
    proposer: Actor | null;
  },
): Promise<AppliedLearning & { finish(db: Executor): void }> {
  const target = learningsTarget(p.tags);
  const note = learningNote(p.proposer);
  const existing = await getKnowledgeSourceBySlug(p.tenant_id, target.slug, tx);
  if (!existing) {
    const params: CreateKnowledgeSourceParams = {
      tenant_id: p.tenant_id,
      input: { name: target.name, slug: target.slug, tags: target.tags, scope: "global" },
      upload: {
        buffer: Buffer.from(initialLearnings(target, p), "utf8"),
        filename: `${target.slug}.md`,
        mime: "text/markdown",
      },
      actor: p.approver,
      source_type_override: "inline",
      note,
    };
    const created = await applyKnowledgeCreate(
      tx,
      params,
      await prepareKnowledgeCreate(params, tx),
    );
    return {
      knowledge_source_id: created.id,
      slug: created.slug,
      version: 1,
      finish: (db) => finishKnowledgeWrite(p.tenant_id, created.id, db),
    };
  }
  const current =
    existing.source_type === "inline" ? await latestText(tx, p.tenant_id, existing.id) : null;
  if (!current) throw new KnowledgeSlugConflictError(target.slug, existing.source_type);
  const params: IngestKnowledgeSourceParams = {
    tenant_id: p.tenant_id,
    knowledge_source_id: existing.id,
    expected_version: existing.version,
    upload: {
      buffer: Buffer.from(appendLearning(current.text, p), "utf8"),
      filename: current.filename,
      mime: "text/markdown",
    },
    actor: p.approver,
    note,
  };
  const applied = await applyKnowledgeIngest(tx, params, await prepareKnowledgeIngest(params, tx));
  const tags = dedupeTags([...existing.tags, ...target.tags]);
  if (tags.length !== existing.tags.length) {
    await updateKnowledgeSource(
      {
        tenant_id: p.tenant_id,
        id: existing.id,
        patch: { tags },
        actor_id: p.approver?.id ?? null,
      },
      tx,
    );
  }
  return {
    knowledge_source_id: existing.id,
    slug: existing.slug,
    version: applied?.version ?? null,
    finish: (db) => finishKnowledgeWrite(p.tenant_id, existing.id, db),
  };
}
