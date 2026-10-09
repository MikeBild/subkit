import { createHash } from "node:crypto";
import { and, asc, eq, inArray } from "drizzle-orm";
import { type CatalogMetadataColumns, metadataChange } from "../api/catalog-metadata.ts";
import { type Executor, getDb } from "../db/client.ts";
import { knowledgeChunks } from "../db/schema/knowledge_sources.ts";
import { canonicalBundleSerialization, normalizeBundlePath, parseBundle } from "./bundle.ts";
import { getKnowledgeSource } from "./catalog.ts";
import {
  createKnowledgeSource,
  getKnowledgeSourceBySlug,
  ingestKnowledgeSource,
  updateKnowledgeSource,
} from "./service.ts";
import { dedupeTags, isStructuralTag } from "./tags.ts";
import type {
  KnowledgeBundleUpsertResult,
  KnowledgeChunkView,
  KnowledgeSourceView,
  ListKnowledgeChunksParams,
  UpsertKnowledgeBundleParams,
} from "./types.ts";

export class KnowledgeSlugConflictError extends Error {
  constructor(
    readonly slug: string,
    readonly existing_source_type: string,
  ) {
    super(
      `slug '${slug}' already belongs to a '${existing_source_type}' knowledge source — pick a different name/slug`,
    );
    this.name = "KnowledgeSlugConflictError";
  }
}

export class KnowledgeSlugExistsError extends Error {
  constructor(
    readonly slug: string,
    readonly knowledge_source_id: string,
  ) {
    super(`slug '${slug}' already belongs to a knowledge source`);
    this.name = "KnowledgeSlugExistsError";
  }
}

function toSlug(name: string): string {
  return name
    .toLowerCase()
    .replace(/[^a-z0-9]+/g, "-")
    .replace(/^-|-$/g, "")
    .slice(0, 100);
}

function structuralFirst(tags: readonly string[]): string[] {
  return dedupeTags([...tags.filter(isStructuralTag), ...tags.filter((t) => !isStructuralTag(t))]);
}

function isUniqueViolation(err: unknown): boolean {
  const msg = err instanceof Error ? err.message : String(err);
  const cause = (err as { cause?: { code?: string } }).cause;
  const code = (err as { code?: string }).code ?? cause?.code;
  return (
    code === "23505" ||
    msg.includes("23505") ||
    msg.toLowerCase().includes("duplicate key") ||
    msg.includes("knowledge_sources_tenant_slug")
  );
}

export async function upsertKnowledgeBundle(
  p: UpsertKnowledgeBundleParams,
  exec?: Executor,
): Promise<KnowledgeBundleUpsertResult> {
  return upsertKnowledgeBundleInner(p, exec ?? getDb(), false);
}

async function upsertKnowledgeBundleInner(
  p: UpsertKnowledgeBundleParams,
  db: Executor,
  retriedAfterConflict: boolean,
): Promise<KnowledgeBundleUpsertResult> {
  const parsed = parseBundle(p.files);
  const canonical = canonicalBundleSerialization(p.files);
  const version = createHash("sha256").update(canonical).digest("hex").slice(0, 32);
  const derivedSlug = p.input.slug ?? toSlug(p.input.name);
  const slug =
    derivedSlug || `bundle-${createHash("sha256").update(p.input.name).digest("hex").slice(0, 12)}`;
  const tags = structuralFirst([...(p.input.tags ?? []), ...parsed.sourceTags]);
  const upload = {
    buffer: Buffer.from(canonical, "utf8"),
    filename: `${slug}.bundle.json`,
    mime: "application/json",
  };

  const existing = await getKnowledgeSourceBySlug(p.tenant_id, slug, db);

  if (existing && p.create_only) {
    throw new KnowledgeSlugExistsError(slug, existing.id);
  }

  if (!existing) {
    let created: KnowledgeSourceView;
    try {
      created = await createKnowledgeSource(
        {
          tenant_id: p.tenant_id,
          actor: p.actor,
          input: { ...p.input, slug, tags },
          upload,
          source_type_override: "bundle",
          parsed_chunks: parsed.chunks,
        },
        db,
      );
    } catch (err) {
      if (isUniqueViolation(err)) {
        const conflict = await getKnowledgeSourceBySlug(p.tenant_id, slug, db);
        if (p.create_only && conflict) {
          throw new KnowledgeSlugExistsError(slug, conflict.id);
        }
        if (!retriedAfterConflict) {
          return upsertKnowledgeBundleInner(p, db, true);
        }
      }
      throw err;
    }
    return {
      knowledge_source: created,
      outcome: "created",
      ingested_count: created.chunk_count,
      skipped_count: parsed.skipped.length,
      skipped_files: parsed.skipped,
    };
  }

  if (existing.source_type !== "bundle") {
    throw new KnowledgeSlugConflictError(slug, existing.source_type);
  }

  const mergedTags = structuralFirst([...existing.tags, ...tags]);
  const tagsChanged =
    mergedTags.length !== existing.tags.length || mergedTags.some((t, i) => t !== existing.tags[i]);
  const patch: CatalogMetadataColumns & {
    tags?: string[];
    name?: string;
    scope?: "global" | "workflow";
    workflow_id?: string | null;
    refresh_strategy?: "manual" | "scheduled";
    refresh_cron?: string | null;
  } = {};
  if (tagsChanged) patch.tags = mergedTags;
  Object.assign(
    patch,
    metadataChange(existing, {
      ...(p.input.description !== undefined ? { description: p.input.description } : {}),
      ...(p.input.category !== undefined ? { category: p.input.category } : {}),
    }),
  );
  if (p.input.name !== existing.name) patch.name = p.input.name;
  if (p.input.scope !== undefined && p.input.scope !== existing.scope) {
    patch.scope = p.input.scope;
    if (p.input.scope === "global" && existing.workflow_id !== null) {
      patch.workflow_id = null;
    }
  }
  if (p.input.workflow_id !== undefined && p.input.workflow_id !== existing.workflow_id) {
    patch.workflow_id = p.input.workflow_id;
  }
  if (
    p.input.refresh_strategy !== undefined &&
    p.input.refresh_strategy !== existing.refresh_strategy
  ) {
    patch.refresh_strategy = p.input.refresh_strategy;
  }
  if (p.input.refresh_cron !== undefined && p.input.refresh_cron !== existing.refresh_cron) {
    patch.refresh_cron = p.input.refresh_cron;
  }
  const applyMetaMerge = async (): Promise<KnowledgeSourceView | null> =>
    Object.keys(patch).length > 0
      ? await updateKnowledgeSource(
          { tenant_id: p.tenant_id, id: existing.id, patch, actor_id: p.actor?.id ?? null },
          db,
        )
      : null;

  if (existing.version === version) {
    const remerged = await applyMetaMerge();
    return {
      knowledge_source: remerged ?? existing,
      outcome: "unchanged",
      ingested_count: 0,
      skipped_count: parsed.skipped.length,
      skipped_files: parsed.skipped,
    };
  }

  const ingest = await ingestKnowledgeSource(
    {
      tenant_id: p.tenant_id,
      knowledge_source_id: existing.id,
      upload,
      actor: p.actor,
      parsed_chunks: parsed.chunks,
    },
    db,
  );

  const view = (await applyMetaMerge()) ?? (await getKnowledgeSource(p.tenant_id, existing.id, db));
  if (!view) throw new Error(`knowledge source '${existing.id}' vanished during bundle upsert`);

  return {
    knowledge_source: view,
    outcome: "updated",
    ingested_count: ingest.ingested_count,
    skipped_count: parsed.skipped.length,
    skipped_files: parsed.skipped,
  };
}

export async function listKnowledgeChunks(
  p: ListKnowledgeChunksParams,
  exec?: Executor,
): Promise<{ source: KnowledgeSourceView; chunks: KnowledgeChunkView[] } | null> {
  const db = exec ?? getDb();
  const source = await getKnowledgeSource(p.tenant_id, p.knowledge_source_id, db);
  if (!source) return null;

  const limit = Math.min(Math.max(1, p.limit ?? 50), 200);
  const offset = Math.max(0, p.offset ?? 0);

  const pathForms =
    p.path !== undefined ? [...new Set([p.path, normalizeBundlePath(p.path)])] : undefined;

  const rows = await db
    .select({
      ordinal: knowledgeChunks.ordinal,
      title: knowledgeChunks.title,
      path: knowledgeChunks.path,
      content: knowledgeChunks.content,
      byte_size: knowledgeChunks.byte_size,
    })
    .from(knowledgeChunks)
    .where(
      and(
        eq(knowledgeChunks.tenant_id, p.tenant_id),
        eq(knowledgeChunks.knowledge_source_id, p.knowledge_source_id),
        ...(pathForms ? [inArray(knowledgeChunks.path, pathForms)] : []),
      ),
    )
    .orderBy(asc(knowledgeChunks.ordinal))
    .limit(limit)
    .offset(offset);

  return { source, chunks: rows };
}
