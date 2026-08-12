// Bundle upsert + chunk read — the directory-import surface of the
// knowledge subsystem (REPL `/knowledge import`, `sk knowledge-sources
// import`, `POST /v1/knowledge-sources/bundle`) and the full-content
// retrieval it unlocks (chunks route, `read_knowledge` tool, MCP
// `knowledge://` resource).
//
// Composes the canonical service functions (`createKnowledgeSource`,
// `ingestKnowledgeSource`) verbatim — there is no third chunk-insert path.

import { createHash } from "node:crypto";
import { and, asc, eq, inArray } from "drizzle-orm";
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

/** The bundle slug is already taken by a non-bundle source — upserting would
 *  replace foreign chunks wholesale. Routes map this to 409. */
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

function toSlug(name: string): string {
  return name
    .toLowerCase()
    .replace(/[^a-z0-9]+/g, "-")
    .replace(/^-|-$/g, "")
    .slice(0, 100);
}

/** Compose a tag set with EVERY structural tag (`type:*`, `domain:*`)
 *  ahead of the topical remainder — the 20-tag `dedupeTags` cap must
 *  never drop a routing key in favor of topical filler, no matter how
 *  many caller-supplied or frontmatter tags compete. */
function structuralFirst(tags: readonly string[]): string[] {
  return dedupeTags([...tags.filter(isStructuralTag), ...tags.filter((t) => !isStructuralTag(t))]);
}

/** Postgres unique-violation (23505) on the partial tenant+slug index —
 *  the check-then-insert race window when two first imports of the same
 *  slug run concurrently. Mirrors `workflows/slug-conflict.ts`. */
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

/**
 * Upsert a knowledge bundle by `(tenant_id, slug)` — the same choreography
 * the boot seeder uses (`applyKnowledgeSeeds`): create when the slug is new,
 * re-ingest in place when the canonical content changed, no-op when the
 * version fingerprint matches. Re-imports are therefore idempotent; the
 * persisted upload buffer is the canonical serialization, so the raw bundle
 * stays retrievable via the source's `file_id`.
 */
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
  // Non-ASCII names slugify to "" — without a deterministic fallback two
  // unrelated bundles would collide on slug "" and silently overwrite
  // each other on upsert.
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

  if (!existing) {
    let created: KnowledgeSourceView;
    try {
      created = await createKnowledgeSource(
        {
          tenant_id: p.tenant_id,
          actor_id: p.actor_id,
          input: { ...p.input, slug, tags },
          upload,
          source_type_override: "bundle",
          parsed_chunks: parsed.chunks,
        },
        db,
      );
    } catch (err) {
      // Two concurrent FIRST imports of the same slug: both pass the
      // check above, one insert wins, the loser lands here. Re-running
      // once converges the loser onto the update/unchanged path — the
      // documented upsert contract — instead of a raw 23505 → 500.
      if (isUniqueViolation(err) && !retriedAfterConflict) {
        return upsertKnowledgeBundleInner(p, db, true);
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

  // Refusing to silently swallow a slug that belongs to a different kind of
  // source (a file upload, a seed) — that would replace its chunks wholesale.
  if (existing.source_type !== "bundle") {
    throw new KnowledgeSlugConflictError(slug, existing.source_type);
  }

  // Metadata refresh — applied on BOTH the unchanged and the updated path
  // (a re-import with new `--tags`/`--description`/`--scope`/name on
  // identical content must still land them; the API validates these
  // fields on every request, so silently dropping them would lie). Tags
  // merge additively with structural routing keys ordered ahead of the
  // cap; every other field follows the caller when EXPLICITLY supplied
  // and different. Operator PATCH remains the one wholesale-replace path
  // for tags.
  const mergedTags = structuralFirst([...existing.tags, ...tags]);
  const tagsChanged =
    mergedTags.length !== existing.tags.length || mergedTags.some((t, i) => t !== existing.tags[i]);
  const patch: {
    tags?: string[];
    description?: string;
    name?: string;
    scope?: "global" | "workflow";
    workflow_id?: string | null;
    refresh_strategy?: "manual" | "scheduled";
    refresh_cron?: string | null;
  } = {};
  if (tagsChanged) patch.tags = mergedTags;
  if (p.input.description !== undefined && p.input.description !== existing.description) {
    patch.description = p.input.description;
  }
  if (p.input.name !== existing.name) patch.name = p.input.name;
  if (p.input.scope !== undefined && p.input.scope !== existing.scope) {
    patch.scope = p.input.scope;
    // Re-homing workflow → global must also clear the binding — the input
    // schema cannot express `workflow_id: null`, and a stale id would keep
    // the source matching the old workflow's list filter.
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
          { tenant_id: p.tenant_id, id: existing.id, patch, actor_id: p.actor_id },
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
      actor_id: p.actor_id,
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

/**
 * List a source's chunks in ordinal order. Returns `null` when the source
 * does not exist for the tenant (callers map that to 404 / tool error).
 * `path` narrows to a single bundle file ("read me the runbook X").
 */
export async function listKnowledgeChunks(
  p: ListKnowledgeChunksParams,
  exec?: Executor,
): Promise<{ source: KnowledgeSourceView; chunks: KnowledgeChunkView[] } | null> {
  const db = exec ?? getDb();
  const source = await getKnowledgeSource(p.tenant_id, p.knowledge_source_id, db);
  if (!source) return null;

  const limit = Math.min(Math.max(1, p.limit ?? 50), 200);
  const offset = Math.max(0, p.offset ?? 0);

  // The write side normalizes bundle paths (`runbooks/x.md` → `/runbooks/x.md`);
  // accept both the caller's literal string and its normalized form so the
  // exact path a client sent on import reads back. Non-bundle sources keep
  // matching their stored literal path (`doc.pdf#page=3`).
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
