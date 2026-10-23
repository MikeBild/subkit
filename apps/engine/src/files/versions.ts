import { and, desc, eq, inArray, ne } from "drizzle-orm";
import { FILE_VERSION_RETENTION, type FileVersionWire } from "../api/files-schemas.ts";
import {
  AuditAction,
  auditAwait,
  bucketSize,
  FileReplacedMetadataSchema,
  recordedFileCreators,
} from "../audit/index.ts";
import type { Db, Executor } from "../db/client.ts";
import { writeEvent } from "../db/events.ts";
import { files, fileVersions } from "../db/schema/index.ts";
import { retryTransient } from "../db/transient.ts";
import { logger } from "../logging/index.ts";
import type { RequestSource } from "../observability/service-metadata.ts";
import { getObjectStore } from "../storage/object-store.ts";
import { storageKey } from "./resolver.ts";

type FileRow = typeof files.$inferSelect;
type VersionRow = typeof fileVersions.$inferSelect;

export interface ContentActor {
  kind: "user" | "system_account";
  id: string;
}

export interface NextContent {
  filename: string;
  content_type: string | null;
  size_bytes: number;
  sha256: string;
  storage_uri: string;
  scan_result: string;
  restored_from: number | null;
}

export class DuplicateFileContentError extends Error {
  readonly code = "duplicate_content";
  constructor(readonly twinId: string) {
    super("another stored file already has exactly this content");
    this.name = "DuplicateFileContentError";
  }
}

export type ReplaceOutcome =
  | { kind: "not_found" }
  | { kind: "unchanged"; row: FileRow }
  | { kind: "replaced"; row: FileRow; previous: FileRow; archived: boolean };

function versionActor(
  kind: VersionRow["replaced_by_kind"],
  id: string | null,
): ContentActor | null {
  if (!id || (kind !== "user" && kind !== "system_account")) return null;
  return { kind, id };
}

async function latestArchived(
  db: Executor,
  tenantId: string,
  row: FileRow,
): Promise<VersionRow | undefined> {
  const [latest] = await db
    .select()
    .from(fileVersions)
    .where(
      and(
        eq(fileVersions.tenant_id, tenantId),
        eq(fileVersions.file_id, row.id),
        eq(fileVersions.version, row.version - 1),
      ),
    )
    .limit(1);
  return latest;
}

export async function currentUploader(
  db: Executor,
  tenantId: string,
  row: FileRow,
): Promise<ContentActor | null> {
  if (row.version <= 1) {
    const creators = await recordedFileCreators(db, tenantId, [row]);
    return creators.get(row.id) ?? null;
  }
  const latest = await latestArchived(db, tenantId, row);
  return latest ? versionActor(latest.replaced_by_kind, latest.replaced_by) : null;
}

export async function replaceFileContent(
  db: Db,
  input: {
    tenantId: string;
    fileId: string;
    actor: ContentActor;
    content: NextContent;
    requestSource: RequestSource | undefined;
  },
): Promise<ReplaceOutcome> {
  const { tenantId, fileId, actor, content } = input;
  const outcome = await retryTransient(
    () =>
      db.transaction(async (tx) => {
        const [row] = await tx
          .select()
          .from(files)
          .where(and(eq(files.tenant_id, tenantId), eq(files.id, fileId)))
          .for("update")
          .limit(1);
        if (!row || row.deleted_at) return { kind: "not_found" as const, pruned: [] as string[] };
        if (content.sha256 === row.sha256 && content.filename === row.filename)
          return { kind: "unchanged" as const, row, pruned: [] as string[] };
        const [twin] = await tx
          .select({ id: files.id })
          .from(files)
          .where(
            and(
              eq(files.tenant_id, tenantId),
              eq(files.sha256, content.sha256),
              ne(files.id, row.id),
            ),
          )
          .limit(1);
        if (twin) throw new DuplicateFileContentError(twin.id);

        const now = new Date();
        const archived = row.status === "ready";
        if (archived) {
          const uploader = await currentUploader(tx, tenantId, row);
          await tx.insert(fileVersions).values({
            tenant_id: tenantId,
            file_id: row.id,
            version: row.version,
            filename: row.filename,
            content_type: row.content_type,
            size_bytes: row.size_bytes,
            storage_uri: row.storage_uri,
            sha256: row.sha256,
            restored_from: row.restored_from,
            uploaded_at: row.replaced_at ?? row.created_at,
            uploaded_by_kind: uploader?.kind ?? null,
            uploaded_by: uploader?.id ?? null,
            replaced_at: now,
            replaced_by_kind: actor.kind,
            replaced_by: actor.id,
          });
        }
        const [updated] = await tx
          .update(files)
          .set({
            filename: content.filename,
            content_type: content.content_type,
            size_bytes: content.size_bytes,
            storage_uri: content.storage_uri,
            sha256: content.sha256,
            scan_result: content.scan_result,
            status: "ready",
            version: archived ? row.version + 1 : row.version,
            restored_from: content.restored_from,
            updated_at: now,
            replaced_at: now,
          })
          .where(and(eq(files.tenant_id, tenantId), eq(files.id, row.id)))
          .returning();
        if (!updated) throw new Error("file row vanished while locked");

        const stale = await tx
          .select({ id: fileVersions.id, storage_uri: fileVersions.storage_uri })
          .from(fileVersions)
          .where(and(eq(fileVersions.tenant_id, tenantId), eq(fileVersions.file_id, row.id)))
          .orderBy(desc(fileVersions.version))
          .offset(FILE_VERSION_RETENTION);
        if (stale.length > 0)
          await tx.delete(fileVersions).where(
            and(
              eq(fileVersions.tenant_id, tenantId),
              inArray(
                fileVersions.id,
                stale.map((entry) => entry.id),
              ),
            ),
          );
        const pruned = stale.map((entry) => storageKey(entry.storage_uri));
        if (!archived) pruned.push(storageKey(row.storage_uri));

        await auditAwait(
          {
            tenant_id: tenantId,
            actor_type: actor.kind,
            actor_id: actor.id,
            action: AuditAction.FILE_REPLACED,
            resource_type: "file",
            resource_id: row.id,
            result: "success",
            metadata: FileReplacedMetadataSchema.parse({
              file_id: row.id,
              content_type: content.content_type,
              size_bytes_bucket: bucketSize(content.size_bytes),
              sha256_prefix: content.sha256.slice(0, 16),
              version: updated.version,
              ...(content.restored_from ? { restored_from_version: content.restored_from } : {}),
              ...(stale.length > 0 ? { pruned_versions: stale.length } : {}),
              request_source: input.requestSource,
            }),
          },
          tx,
        );
        await writeEvent(tx, {
          tenant_id: tenantId,
          channel: "notification.emitted",
          type: "file.replaced",
          payload: { file_id: `fid_${row.id}` },
        });
        return { kind: "replaced" as const, row: updated, previous: row, archived, pruned };
      }),
    { label: "files_replace" },
  );
  for (const key of outcome.pruned) {
    try {
      await getObjectStore().delete(key);
    } catch (err) {
      logger.warn({
        module: "files",
        action: "versions.prune_object",
        msg: "pruned file version object was not removed",
        file_id: fileId,
        error: err instanceof Error ? err.message : String(err),
      });
    }
  }
  if (outcome.kind === "replaced")
    return {
      kind: "replaced",
      row: outcome.row,
      previous: outcome.previous,
      archived: outcome.archived,
    };
  if (outcome.kind === "unchanged") return { kind: "unchanged", row: outcome.row };
  return { kind: "not_found" };
}

export async function listFileVersions(
  db: Executor,
  tenantId: string,
  row: FileRow,
): Promise<FileVersionWire[]> {
  const archived = await db
    .select()
    .from(fileVersions)
    .where(and(eq(fileVersions.tenant_id, tenantId), eq(fileVersions.file_id, row.id)))
    .orderBy(desc(fileVersions.version));
  const latest = archived.find((entry) => entry.version === row.version - 1);
  const current: FileVersionWire = {
    version: row.version,
    current: true,
    filename: row.filename,
    content_type: row.content_type,
    size_bytes: row.size_bytes,
    sha256: row.sha256,
    restored_from: row.restored_from,
    uploaded_at: (row.replaced_at ?? row.created_at).toISOString(),
    uploaded_by:
      row.version <= 1
        ? ((await recordedFileCreators(db, tenantId, [row])).get(row.id) ?? null)
        : latest
          ? versionActor(latest.replaced_by_kind, latest.replaced_by)
          : null,
    replaced_at: null,
  };
  return [
    current,
    ...archived.map((entry) => ({
      version: entry.version,
      current: false,
      filename: entry.filename,
      content_type: entry.content_type,
      size_bytes: entry.size_bytes,
      sha256: entry.sha256,
      restored_from: entry.restored_from,
      uploaded_at: entry.uploaded_at.toISOString(),
      uploaded_by: versionActor(entry.uploaded_by_kind, entry.uploaded_by),
      replaced_at: entry.replaced_at.toISOString(),
    })),
  ];
}

export async function findFileVersion(
  db: Executor,
  tenantId: string,
  fileId: string,
  version: number,
): Promise<VersionRow | undefined> {
  const [entry] = await db
    .select()
    .from(fileVersions)
    .where(
      and(
        eq(fileVersions.tenant_id, tenantId),
        eq(fileVersions.file_id, fileId),
        eq(fileVersions.version, version),
      ),
    )
    .limit(1);
  return entry;
}

export async function fileVersionKeys(
  db: Executor,
  tenantId: string,
  fileId: string,
): Promise<string[]> {
  const rows = await db
    .select({ storage_uri: fileVersions.storage_uri })
    .from(fileVersions)
    .where(and(eq(fileVersions.tenant_id, tenantId), eq(fileVersions.file_id, fileId)));
  return rows.map((row) => storageKey(row.storage_uri));
}
