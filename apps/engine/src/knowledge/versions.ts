import { and, desc, eq, sql } from "drizzle-orm";
import { type Actor, actorFromColumns } from "../audit/actor.ts";
import { type Executor, getDb } from "../db/client.ts";
import { type ListResult, resolveWindowTotal, totalOverWindow } from "../db/list-result.ts";
import { knowledgeSourceVersions } from "../db/schema/knowledge_sources.ts";
import { canonicalBundleSerialization, parseBundle } from "./bundle.ts";
import { getKnowledgeSource } from "./catalog.ts";
import { ingestKnowledgeSource } from "./service.ts";
import type { KnowledgeSourceView } from "./types.ts";
import { knowledgeVersionDocuments } from "./version-record.ts";

export const KNOWLEDGE_HISTORY_DEFAULT_LIMIT = 50;
export const KNOWLEDGE_HISTORY_MAX_LIMIT = 200;

export interface KnowledgeVersionView {
  version: number;
  content_hash: string;
  author: Actor | null;
  note: string | null;
  created_at: string;
  current: boolean;
}

export interface KnowledgeVersionDetail extends KnowledgeVersionView {
  documents: { path: string; content: string }[];
}

export class KnowledgeVersionAlreadyCurrentError extends Error {
  readonly code = "version_already_current";
  constructor(readonly version: number) {
    super(`version ${version} is already the current content of this knowledge source`);
    this.name = "KnowledgeVersionAlreadyCurrentError";
  }
}

type VersionRow = typeof knowledgeSourceVersions.$inferSelect;

function toView(row: VersionRow, latest: number): KnowledgeVersionView {
  return {
    version: row.version,
    content_hash: row.content_hash,
    author: actorFromColumns(row.author_user_id, row.author_system_account_id),
    note: row.note,
    created_at: row.created_at.toISOString(),
    current: row.version === latest,
  };
}

function latestVersion() {
  return sql<number>`max(${knowledgeSourceVersions.version}) over ()::int`;
}

function sourceVersionConds(tenant_id: string, knowledge_source_id: string) {
  return [
    eq(knowledgeSourceVersions.tenant_id, tenant_id),
    eq(knowledgeSourceVersions.knowledge_source_id, knowledge_source_id),
  ];
}

export async function listKnowledgeHistory(
  tenant_id: string,
  knowledge_source_id: string,
  opts: { limit?: number; offset?: number } = {},
  exec?: Executor,
): Promise<ListResult<KnowledgeVersionView> | null> {
  const db = exec ?? getDb();
  const source = await getKnowledgeSource(tenant_id, knowledge_source_id, db);
  if (!source) return null;
  const limit = Math.min(
    opts.limit ?? KNOWLEDGE_HISTORY_DEFAULT_LIMIT,
    KNOWLEDGE_HISTORY_MAX_LIMIT,
  );
  const offset = opts.offset ?? 0;
  const tenantConds = sourceVersionConds(tenant_id, knowledge_source_id);
  const rows = await db
    .select({ row: knowledgeSourceVersions, total: totalOverWindow(), latest: latestVersion() })
    .from(knowledgeSourceVersions)
    .where(and(...tenantConds))
    .orderBy(desc(knowledgeSourceVersions.version))
    .limit(limit)
    .offset(offset);
  const total = await resolveWindowTotal(rows, offset, async () => {
    const [row] = await db
      .select({ c: sql<number>`count(*)::int` })
      .from(knowledgeSourceVersions)
      .where(and(...tenantConds));
    return Number(row?.c ?? 0);
  });
  return { rows: rows.map(({ row, latest }) => toView(row, Number(latest))), total };
}

async function loadVersion(
  tenant_id: string,
  knowledge_source_id: string,
  version: number,
  db: Executor,
): Promise<{ row: VersionRow; latest: number } | null> {
  const [found] = await db
    .select({
      row: knowledgeSourceVersions,
      latest: sql<number>`(SELECT max(v.version)::int FROM knowledge_source_versions v WHERE v.tenant_id = ${tenant_id} AND v.knowledge_source_id = ${knowledge_source_id})`,
    })
    .from(knowledgeSourceVersions)
    .where(
      and(
        ...sourceVersionConds(tenant_id, knowledge_source_id),
        eq(knowledgeSourceVersions.version, version),
      ),
    )
    .limit(1);
  return found ? { row: found.row, latest: Number(found.latest) } : null;
}

export async function getKnowledgeVersion(
  tenant_id: string,
  knowledge_source_id: string,
  version: number,
  exec?: Executor,
): Promise<KnowledgeVersionDetail | null> {
  const db = exec ?? getDb();
  const source = await getKnowledgeSource(tenant_id, knowledge_source_id, db);
  if (!source) return null;
  const found = await loadVersion(tenant_id, knowledge_source_id, version, db);
  if (!found) return null;
  return {
    ...toView(found.row, found.latest),
    documents: knowledgeVersionDocuments(found.row.content),
  };
}

export async function restoreKnowledgeVersion(
  tenant_id: string,
  knowledge_source_id: string,
  version: number,
  actor: Actor | null,
  exec?: Executor,
): Promise<{ knowledge_source: KnowledgeSourceView; version: number } | null> {
  const db = exec ?? getDb();
  const source = await getKnowledgeSource(tenant_id, knowledge_source_id, db);
  if (!source) return null;
  const found = await loadVersion(tenant_id, knowledge_source_id, version, db);
  if (!found) return null;
  if (found.row.content_hash === source.version) {
    throw new KnowledgeVersionAlreadyCurrentError(version);
  }
  const content = found.row.content;
  const restore = {
    tenant_id,
    knowledge_source_id,
    actor,
    expected_version: source.version,
    restored_from: version,
  };
  const result =
    content.kind === "bundle"
      ? await ingestKnowledgeSource(
          {
            ...restore,
            upload: {
              buffer: Buffer.from(canonicalBundleSerialization(content.files), "utf8"),
              filename: content.filename,
              mime: "application/json",
            },
            parsed_chunks: parseBundle(content.files).chunks,
          },
          db,
        )
      : await ingestKnowledgeSource(
          {
            ...restore,
            upload: {
              buffer: Buffer.from(content.text, "utf8"),
              filename: content.filename,
              ...(content.mime ? { mime: content.mime } : {}),
            },
          },
          db,
        );
  const restored = await getKnowledgeSource(tenant_id, knowledge_source_id, db);
  if (!restored || result.content_version === null) return null;
  return { knowledge_source: restored, version: result.content_version };
}
