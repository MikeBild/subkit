import {
  and,
  asc,
  count,
  desc,
  eq,
  ilike,
  inArray,
  isNull,
  lt,
  or,
  type SQL,
  sql,
} from "drizzle-orm";
import { type FileStats, type ListFilesQuery, toFileId } from "../../api/files-schemas.ts";
import type { FileCreator } from "../../audit/file-creators.ts";
import {
  AuditAction,
  auditAwait,
  bucketSize,
  FileDownloadedMetadataSchema,
  fileCreatorNames,
  recordedFileCreators,
} from "../../audit/index.ts";
import type { ResolvedPrincipal } from "../../auth/types.ts";
import type { Db } from "../../db/client.ts";
import { catalogGroupOrder } from "../../db/list-result.ts";
import {
  connectors,
  conversations,
  executions,
  fileLinks,
  files,
  filesDedupSeen,
  knowledgeSources,
  skills,
  workflows,
  workflowVersions,
} from "../../db/schema/index.ts";
import { PACKAGE_CONTENT_TYPE } from "../../identity/index.ts";
import { principalHolds } from "../../rbac/index.ts";
import { storageKey } from "../resolver.ts";
import { dagNamesFile, workflowUsageCounts } from "../usage.ts";
import { findFileVersion } from "../versions.ts";
import {
  auditedBy,
  type FileActor,
  type FileRow,
  findTenantFile,
  openObjectStream,
} from "./shared.ts";

export interface FileListEntry {
  row: FileRow;
  creator: FileCreator | null;
  usage: { workflows: number; conversations: number };
}

export interface FileListPage {
  entries: FileListEntry[];
  total: number;
  next_cursor: string | null;
}

export async function listFiles(
  db: Db,
  tenant_id: string,
  q: ListFilesQuery,
): Promise<FileListPage> {
  const limit = Math.min(q.limit ?? 20, 100);

  const tenantConds: SQL[] = [eq(files.tenant_id, tenant_id), isNull(files.deleted_at)];
  if (q.status) tenantConds.push(eq(files.status, q.status));
  if (q.category) tenantConds.push(eq(files.category, q.category));
  if (q.description_source) tenantConds.push(eq(files.description_source, q.description_source));
  if (q.description_source === "llm")
    tenantConds.push(sql`length(trim(coalesce(${files.description}, ''))) > 0`);
  if (q.q) {
    const needle = `%${q.q}%`;
    const search = or(
      ilike(files.filename, needle),
      ilike(files.content_type, needle),
      ilike(files.description, needle),
      ilike(files.category, needle),
    );
    if (search) tenantConds.push(search);
  }
  if (q.linked_to) {
    const colon = q.linked_to.indexOf(":");
    const rtype = q.linked_to.slice(0, colon);
    const rid = q.linked_to.slice(colon + 1);
    tenantConds.push(sql<boolean>`exists (
        select 1 from file_links fl
        where fl.tenant_id = ${tenant_id}
          and fl.file_id = ${files.id}
          and fl.resource_type = ${rtype}
          and fl.resource_id = ${rid}::uuid
      )`);
  }
  const totalConds = [...tenantConds];
  const cursorOrder =
    !q.group_by && (!q.sort || q.sort === "created_at") && (!q.order || q.order === "desc");
  if (q.cursor && cursorOrder) {
    const cursorDate = new Date(q.cursor);
    if (!Number.isNaN(cursorDate.getTime())) {
      tenantConds.push(lt(files.created_at, cursorDate));
    }
  }

  const sortColumn =
    q.sort === "filename"
      ? files.filename
      : q.sort === "content_type"
        ? files.content_type
        : q.sort === "size_bytes"
          ? files.size_bytes
          : q.sort === "status"
            ? files.status
            : files.created_at;
  const ordered = q.order === "asc" ? asc(sortColumn) : desc(sortColumn);
  const [totalRow] = await db
    .select({ total: sql<number>`count(*)::int` })
    .from(files)
    .where(and(eq(files.tenant_id, tenant_id), ...totalConds.slice(1)));
  const rows = await db
    .select()
    .from(files)
    .where(and(eq(files.tenant_id, tenant_id), ...tenantConds.slice(1)))
    .orderBy(...catalogGroupOrder(q.group_by, files.category), ordered, asc(files.id))
    .limit(limit + 1)
    .offset(q.offset ?? 0);

  const hasMore = rows.length > limit;
  const page = hasMore ? rows.slice(0, limit) : rows;
  const pageIds = page.map((r) => r.id);
  const workflowCounts = await workflowUsageCounts(db, tenant_id, page);
  const conversationRows =
    page.length > 0
      ? await db
          .select({
            id: fileLinks.file_id,
            conversations: sql<number>`count(distinct ${fileLinks.resource_id})::int`,
          })
          .from(fileLinks)
          .where(
            and(
              eq(fileLinks.tenant_id, tenant_id),
              eq(fileLinks.resource_type, "conversation"),
              inArray(fileLinks.file_id, pageIds),
            ),
          )
          .groupBy(fileLinks.file_id)
      : [];
  const conversationCounts = new Map(conversationRows.map((u) => [u.id, u.conversations]));
  const creators = await recordedFileCreators(db, tenant_id, page);
  const entries = page.map((row) => ({
    row,
    creator: creators.get(row.id) ?? null,
    usage: {
      workflows: workflowCounts.get(row.id) ?? 0,
      conversations: Number(conversationCounts.get(row.id) ?? 0),
    },
  }));
  const lastVisible = hasMore && cursorOrder ? rows[limit - 1] : undefined;
  return {
    entries,
    total: Number(totalRow?.total ?? 0),
    next_cursor: lastVisible ? lastVisible.created_at.toISOString() : null,
  };
}

export async function fileStats(db: Db, tenant_id: string): Promise<FileStats> {
  const liveTenantFiles = () => and(eq(files.tenant_id, tenant_id), isNull(files.deleted_at));
  const byStatusRows = await db
    .select({ status: files.status, n: count() })
    .from(files)
    .where(liveTenantFiles())
    .groupBy(files.status);
  const byVerdictRows = await db
    .select({ verdict: files.scan_result, n: count() })
    .from(files)
    .where(liveTenantFiles())
    .groupBy(files.scan_result);
  const sizeRows = await db.select({ size: files.size_bytes }).from(files).where(liveTenantFiles());

  const by_size_bucket: Record<string, number> = {};
  let total = 0;
  for (const r of sizeRows) {
    total++;
    const b = bucketSize(r.size);
    by_size_bucket[b] = (by_size_bucket[b] ?? 0) + 1;
  }

  const [dedupRow] = await db
    .select({ n: filesDedupSeen.count })
    .from(filesDedupSeen)
    .where(eq(filesDedupSeen.tenant_id, tenant_id))
    .limit(1);
  const dedup_hits = dedupRow ? Number(dedupRow.n) : 0;

  const by_status: Record<string, number> = {};
  for (const r of byStatusRows) by_status[r.status] = Number(r.n);

  const scan_verdicts: Record<string, number> = {};
  for (const r of byVerdictRows) {
    scan_verdicts[r.verdict ?? "unscanned"] = Number(r.n);
  }

  return { total, by_status, by_size_bucket, dedup_hits, scan_verdicts };
}

export interface FileDetail {
  row: FileRow;
  creator: FileCreator | null;
  creator_name: string | null;
  creator_api_key_name: string | null;
}

export async function getFileDetail(
  db: Db,
  principal: ResolvedPrincipal,
  fileUuid: string,
): Promise<FileDetail | null> {
  const row = await findTenantFile(db, principal.tenant_id, fileUuid);
  if (!row) return null;
  const creators = await recordedFileCreators(db, principal.tenant_id, [row]);
  const creator = creators.get(row.id) ?? null;
  const directoryReadable = await principalHolds(db, principal, "identity:read");
  const names = directoryReadable
    ? await fileCreatorNames(db, principal.tenant_id, row.id, creator)
    : { name: null, api_key_name: null };
  return { row, creator, creator_name: names.name, creator_api_key_name: names.api_key_name };
}

export async function findDownloadableFile(
  db: Db,
  tenantId: string,
  fileUuid: string,
): Promise<FileRow | null> {
  const row = await findTenantFile(db, tenantId, fileUuid);
  if (!row || row.content_type === PACKAGE_CONTENT_TYPE) return null;
  return row;
}

export async function downloadFile(
  db: Db,
  actor: FileActor,
  row: FileRow,
  range: { start: number; end: number } | null,
): Promise<ReadableStream<Uint8Array>> {
  await auditAwait(
    {
      ...auditedBy(actor),
      action: AuditAction.FILE_DOWNLOADED,
      resource_type: "file",
      resource_id: row.id,
      result: "success",
      metadata: FileDownloadedMetadataSchema.parse({
        file_id: row.id,
        content_type: row.content_type,
        size_bytes_bucket: bucketSize(row.size_bytes),
        range: Boolean(range),
        request_source: actor.request_source,
      }),
    },
    db,
  );
  return openObjectStream(storageKey(row.storage_uri), range);
}

export async function downloadFileVersion(db: Db, actor: FileActor, row: FileRow, version: number) {
  const source =
    version === row.version
      ? row
      : await findFileVersion(db, actor.principal.tenant_id, row.id, version);
  if (!source) return null;
  await auditAwait(
    {
      ...auditedBy(actor),
      action: AuditAction.FILE_DOWNLOADED,
      resource_type: "file",
      resource_id: row.id,
      result: "success",
      metadata: FileDownloadedMetadataSchema.parse({
        file_id: row.id,
        content_type: source.content_type,
        size_bytes_bucket: bucketSize(source.size_bytes),
        version,
        request_source: actor.request_source,
      }),
    },
    db,
  );
  return { source, stream: await openObjectStream(storageKey(source.storage_uri), null) };
}

const LINK_READ_PERMISSIONS = {
  knowledge_source: "knowledge:read",
  skill: "skill:read",
  connector: "connector:read",
  workflow_run: "execution:read",
} as const;

async function readableLinkKinds(db: Db, principal: ResolvedPrincipal): Promise<Set<string>> {
  const kinds = new Set<string>();
  for (const [kind, permission] of Object.entries(LINK_READ_PERMISSIONS)) {
    if (await principalHolds(db, principal, permission)) kinds.add(kind);
  }
  return kinds;
}

type LinkedRecord = Pick<typeof fileLinks.$inferSelect, "resource_type"> & { id: string };

async function linkedRecordNames(
  db: Db,
  tenant_id: string,
  links: readonly { resource_type: string; id: string }[],
): Promise<Map<string, string>> {
  const ids = (type: string) =>
    links.filter((link) => link.resource_type === type).map((link) => link.id);
  const names = new Map<string, string>();
  const put = (type: string, rows: readonly { id: string; name: string | null }[]) => {
    for (const row of rows) if (row.name) names.set(`${type}:${row.id}`, row.name);
  };
  const knowledge = ids("knowledge_source");
  if (knowledge.length > 0)
    put(
      "knowledge_source",
      await db
        .select({ id: knowledgeSources.id, name: knowledgeSources.name })
        .from(knowledgeSources)
        .where(
          and(
            eq(knowledgeSources.tenant_id, tenant_id),
            inArray(knowledgeSources.id, knowledge),
            isNull(knowledgeSources.deleted_at),
          ),
        ),
    );
  const skillIds = ids("skill");
  if (skillIds.length > 0)
    put(
      "skill",
      await db
        .select({ id: skills.id, name: skills.title })
        .from(skills)
        .where(and(eq(skills.tenant_id, tenant_id), inArray(skills.id, skillIds))),
    );
  const connectorIds = ids("connector");
  if (connectorIds.length > 0)
    put(
      "connector",
      await db
        .select({ id: connectors.id, name: connectors.display_name })
        .from(connectors)
        .where(
          and(
            eq(connectors.tenant_id, tenant_id),
            inArray(connectors.id, connectorIds),
            isNull(connectors.deleted_at),
          ),
        ),
    );
  const runIds = ids("workflow_run");
  if (runIds.length > 0)
    put(
      "workflow_run",
      await db
        .select({ id: executions.id, name: workflows.name })
        .from(executions)
        .innerJoin(
          workflows,
          and(
            eq(workflows.tenant_id, executions.tenant_id),
            eq(workflows.id, executions.workflow_id),
          ),
        )
        .where(and(eq(executions.tenant_id, tenant_id), inArray(executions.id, runIds))),
    );
  return names;
}

export async function fileUsage(db: Db, principal: ResolvedPrincipal, row: FileRow) {
  const tenant_id = principal.tenant_id;
  const usedBy = await db
    .select({ id: workflows.id, name: workflows.name })
    .from(workflows)
    .innerJoin(workflowVersions, eq(workflowVersions.id, workflows.current_version_id))
    .where(
      and(
        eq(workflows.tenant_id, tenant_id),
        isNull(workflows.deleted_at),
        dagNamesFile(workflowVersions.dag, toFileId(row.id), row.slug),
      ),
    )
    .orderBy(workflows.name);
  const links = await db
    .select({
      resource_type: fileLinks.resource_type,
      resource_id: fileLinks.resource_id,
      title: conversations.title,
    })
    .from(fileLinks)
    .leftJoin(
      conversations,
      and(
        eq(fileLinks.resource_type, "conversation"),
        eq(conversations.id, fileLinks.resource_id),
        eq(conversations.tenant_id, tenant_id),
      ),
    )
    .where(and(eq(fileLinks.tenant_id, tenant_id), eq(fileLinks.file_id, row.id)));
  const seen = new Set<string>();
  const conversationsUsing: Array<{ id: string; title: string | null }> = [];
  const others: LinkedRecord[] = [];
  for (const link of links) {
    if (link.resource_type !== "conversation") {
      others.push({ resource_type: link.resource_type, id: link.resource_id });
      continue;
    }
    if (seen.has(link.resource_id)) continue;
    seen.add(link.resource_id);
    conversationsUsing.push({ id: link.resource_id, title: link.title ?? null });
  }
  const readable = await readableLinkKinds(db, principal);
  const names = await linkedRecordNames(
    db,
    tenant_id,
    others.filter((link) => readable.has(link.resource_type)),
  );
  const other_links = others
    .map((link) => ({ ...link, name: names.get(`${link.resource_type}:${link.id}`) ?? null }))
    .sort((a, b) => (a.name ?? "").localeCompare(b.name ?? "") || a.id.localeCompare(b.id));
  return {
    workflows: usedBy,
    conversations: conversationsUsing,
    other: others.length,
    other_links,
  };
}
