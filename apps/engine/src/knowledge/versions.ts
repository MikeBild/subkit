import { and, desc, eq, sql } from "drizzle-orm";
import { type Actor, actorFromColumns } from "../audit/actor.ts";
import { type Executor, getDb } from "../db/client.ts";
import { type ListResult, resolveWindowTotal, totalOverWindow } from "../db/list-result.ts";
import { knowledgeSourceVersions } from "../db/schema/knowledge_sources.ts";
import { getKnowledgeSource } from "./catalog.ts";
import { KnowledgeVersionAlreadyCurrentError } from "./errors.ts";
import { ingestKnowledgeSource } from "./service.ts";
import type { KnowledgeSourceView } from "./types.ts";
import {
  knowledgeContentHash,
  knowledgeVersionDocuments,
  knowledgeVersionUpload,
  latestKnowledgeVersion,
} from "./version-record.ts";

export const KNOWLEDGE_HISTORY_DEFAULT_LIMIT = 50;
export const KNOWLEDGE_HISTORY_MAX_LIMIT = 200;

interface KnowledgeVersionView {
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

const versionMeta = {
  version: knowledgeSourceVersions.version,
  content_hash: knowledgeSourceVersions.content_hash,
  author_user_id: knowledgeSourceVersions.author_user_id,
  author_system_account_id: knowledgeSourceVersions.author_system_account_id,
  note: knowledgeSourceVersions.note,
  created_at: knowledgeSourceVersions.created_at,
};

type VersionMeta = {
  version: number;
  content_hash: string;
  author_user_id: string | null;
  author_system_account_id: string | null;
  note: string | null;
  created_at: Date;
};

function toView(row: VersionMeta, latest: number): KnowledgeVersionView {
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
    .select({ ...versionMeta, total: totalOverWindow(), latest: latestVersion() })
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
  return { rows: rows.map((row) => toView(row, Number(row.latest))), total };
}

async function loadVersion(
  tenant_id: string,
  knowledge_source_id: string,
  version: number,
  db: Executor,
) {
  const [found] = await db
    .select({
      ...versionMeta,
      content: knowledgeSourceVersions.content,
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
  return found ?? null;
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
    ...toView(found, Number(found.latest)),
    documents: knowledgeVersionDocuments(found.content),
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
  const upload = knowledgeVersionUpload(found.content);
  const latest = await latestKnowledgeVersion(db, tenant_id, knowledge_source_id);
  if (latest?.content_hash === knowledgeContentHash(upload.text)) {
    throw new KnowledgeVersionAlreadyCurrentError(version);
  }
  const result = await ingestKnowledgeSource(
    {
      tenant_id,
      knowledge_source_id,
      actor,
      expected_version: source.version,
      restored_from: version,
      upload: {
        buffer: Buffer.from(upload.text, "utf8"),
        filename: upload.filename,
        ...(upload.mime ? { mime: upload.mime } : {}),
      },
      ...(upload.parsed_chunks ? { parsed_chunks: upload.parsed_chunks } : {}),
    },
    db,
  );
  const restored = await getKnowledgeSource(tenant_id, knowledge_source_id, db);
  if (!restored) return null;
  if (result.content_version === null) throw new KnowledgeVersionAlreadyCurrentError(version);
  return { knowledge_source: restored, version: result.content_version };
}
