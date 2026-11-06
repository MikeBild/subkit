import { createHash, randomUUID } from "node:crypto";
import type { z } from "@hono/zod-openapi";
import { and, eq, isNull, ne } from "drizzle-orm";
import { DescriptionAcceptanceError, metadataChange } from "../../api/catalog-metadata.ts";
import { type LinkRequest, toFileId, type UpdateFileSchema } from "../../api/files-schemas.ts";
import {
  AuditAction,
  auditAwait,
  FileDeletedMetadataSchema,
  FileRenamedMetadataSchema,
} from "../../audit/index.ts";
import { lockCatalogVocabulary } from "../../db/catalog-vocabulary.ts";
import type { Db } from "../../db/client.ts";
import { writeEvent } from "../../db/events.ts";
import { files } from "../../db/schema/index.ts";
import { logger } from "../../logging/index.ts";
import { getObjectStore } from "../../storage/object-store.ts";
import { FileLinkError, linkStoredFile } from "../links.ts";
import { buildObjectKey, composeStorageUri, streamFromBytes } from "../object-key.ts";
import { storageKey } from "../resolver.ts";
import {
  DuplicateFileContentError,
  findFileVersion,
  type NextContent,
  replaceFileContent,
} from "../versions.ts";
import {
  auditedBy,
  type FileActor,
  type FileRow,
  findTenantFile,
  scanWithTimeout,
} from "./shared.ts";

export async function findLiveFile(
  db: Db,
  tenantId: string,
  fileUuid: string,
): Promise<FileRow | null> {
  const row = await findTenantFile(db, tenantId, fileUuid);
  return row && !row.deleted_at ? row : null;
}

export async function deleteFile(
  db: Db,
  actor: FileActor,
  fileUuid: string,
): Promise<"not_found" | "deleted"> {
  const tenant_id = actor.principal.tenant_id;
  const row = await findTenantFile(db, tenant_id, fileUuid);
  if (!row) return "not_found";
  if (row.deleted_at) return "deleted";
  await db
    .update(files)
    .set({ deleted_at: new Date() })
    .where(and(eq(files.tenant_id, tenant_id), eq(files.id, row.id)));
  await auditAwait(
    {
      ...auditedBy(actor),
      action: AuditAction.FILE_DELETED,
      resource_type: "file",
      resource_id: row.id,
      result: "success",
      metadata: FileDeletedMetadataSchema.parse({
        file_id: row.id,
        reason: "user_request",
        request_source: actor.request_source,
      }),
    },
    db,
  );
  await writeEvent(db, {
    tenant_id,
    channel: "notification.emitted",
    type: "file.deleted",
    payload: { file_id: toFileId(row.id) },
  });
  return "deleted";
}

export async function linkFile(db: Db, actor: FileActor, fileUuid: string, body: LinkRequest) {
  const tenant_id = actor.principal.tenant_id;
  const row = await findTenantFile(db, tenant_id, fileUuid);
  if (!row) return { kind: "not_found" } as const;
  if (row.status !== "ready") return { kind: "not_ready", status: row.status } as const;
  try {
    const link = await linkStoredFile(
      db,
      {
        tenant_id,
        file_id: row.id,
        resource_type: body.resource_type,
        resource_id: body.resource_id,
        slug: body.slug ?? null,
        role: body.role ?? null,
      },
      {
        actor_type: auditedBy(actor).actor_type,
        actor_id: actor.principal.id,
        request_source: actor.request_source ?? "api",
        allowed_statuses: ["ready"],
      },
    );
    return { kind: "linked", link } as const;
  } catch (error) {
    if (error instanceof FileLinkError) return { kind: "link_changed", code: error.code } as const;
    throw error;
  }
}

export async function updateFileDetails(
  db: Db,
  actor: FileActor,
  fileUuid: string,
  body: z.infer<typeof UpdateFileSchema>,
): Promise<FileRow | null> {
  const tenant_id = actor.principal.tenant_id;
  return db.transaction(async (tx) => {
    await lockCatalogVocabulary(tx, tenant_id);
    const [row] = await tx
      .select()
      .from(files)
      .where(and(eq(files.tenant_id, tenant_id), eq(files.id, fileUuid)))
      .for("update")
      .limit(1);
    if (!row || row.deleted_at) return null;
    const metadata = metadataChange(row, {
      ...(body.description !== undefined ? { description: body.description } : {}),
      ...(body.accept_description !== undefined
        ? { accept_description: body.accept_description }
        : {}),
      ...(body.category !== undefined ? { category: body.category } : {}),
    });
    const renamed = body.filename !== undefined && body.filename !== row.filename;
    if (!renamed && !metadata) return row;
    const [updated] = await tx
      .update(files)
      .set({
        ...(renamed ? { filename: body.filename } : {}),
        ...metadata,
        updated_at: new Date(),
      })
      .where(
        and(
          eq(files.tenant_id, tenant_id),
          eq(files.id, row.id),
          isNull(files.deleted_at),
          ...(body.accept_description && typeof body.description === "string"
            ? [eq(files.description, body.description)]
            : []),
        ),
      )
      .returning();
    if (!updated && body.accept_description)
      throw new DescriptionAcceptanceError("description_changed");
    if (renamed) {
      await auditAwait(
        {
          ...auditedBy(actor),
          action: AuditAction.FILE_RENAMED,
          resource_type: "file",
          resource_id: row.id,
          result: "success",
          metadata: FileRenamedMetadataSchema.parse({
            file_id: row.id,
            request_source: actor.request_source,
          }),
        },
        tx,
      );
    }
    if (metadata) {
      await auditAwait(
        {
          ...auditedBy(actor),
          action: AuditAction.CATALOG_METADATA_UPDATED,
          resource_type: "file",
          resource_id: row.id,
          result: "success",
          before: { description: row.description, category: row.category },
          after: {
            description:
              metadata.description === undefined ? row.description : metadata.description,
            category: updated?.category ?? row.category,
          },
          metadata: {
            request_source: actor.request_source,
            ...(metadata.description_source
              ? { description_source: metadata.description_source }
              : {}),
            ...(metadata.category_source ? { category_source: metadata.category_source } : {}),
          },
        },
        tx,
      );
    }
    return updated ?? row;
  });
}

async function findTwin(db: Db, tenantId: string, sha256: string, fileId: string) {
  const [twin] = await db
    .select({ id: files.id })
    .from(files)
    .where(and(eq(files.tenant_id, tenantId), eq(files.sha256, sha256), ne(files.id, fileId)))
    .limit(1);
  return twin?.id ?? null;
}

async function discardObject(key: string) {
  try {
    await getObjectStore().delete(key);
  } catch (err) {
    logger.warn({
      module: "http.files",
      action: "replace.discard_object",
      msg: "unused replacement object was not removed",
      error: err instanceof Error ? err.message : String(err),
    });
  }
}

export type ContentChange =
  | { kind: "replaced" | "unchanged"; row: FileRow }
  | { kind: "not_found" }
  | { kind: "duplicate"; twinId: string };

async function applyContent(
  db: Db,
  actor: FileActor,
  fileId: string,
  key: string,
  content: NextContent,
): Promise<ContentChange> {
  try {
    const result = await replaceFileContent(db, {
      tenantId: actor.principal.tenant_id,
      fileId,
      actor: {
        kind: auditedBy(actor).actor_type === "user" ? "user" : "system_account",
        id: actor.principal.id,
      },
      content,
      requestSource: actor.request_source,
    });
    if (result.kind !== "replaced") await discardObject(key);
    return result;
  } catch (err) {
    await discardObject(key);
    if (err instanceof DuplicateFileContentError) return { kind: "duplicate", twinId: err.twinId };
    throw err;
  }
}

export type ReplaceBytesOutcome =
  | ContentChange
  | { kind: "scan_rejected"; verdict: "infected" | "timeout" };

export async function replaceFileBytes(
  db: Db,
  actor: FileActor,
  row: FileRow,
  input: { filename: string; content_type: string | null; bytes: Uint8Array },
): Promise<ReplaceBytesOutcome> {
  const tenant_id = actor.principal.tenant_id;
  const sha256 = createHash("sha256").update(input.bytes).digest("hex");
  if (sha256 === row.sha256 && input.filename === row.filename) return { kind: "unchanged", row };
  const twin = await findTwin(db, tenant_id, sha256, row.id);
  if (twin) return { kind: "duplicate", twinId: twin };

  const key = buildObjectKey(tenant_id, randomUUID());
  await getObjectStore().put(key, input.bytes);
  const scan = await scanWithTimeout(streamFromBytes(input.bytes), {
    content_type: input.content_type,
    filename: input.filename,
  });
  if (scan.verdict !== "clean") {
    await discardObject(key);
    return { kind: "scan_rejected", verdict: scan.verdict };
  }
  return applyContent(db, actor, row.id, key, {
    filename: input.filename,
    content_type: input.content_type,
    size_bytes: input.bytes.byteLength,
    sha256,
    storage_uri: composeStorageUri(key),
    scan_result: scan.verdict,
    restored_from: null,
  });
}

export type RestoreOutcome =
  | ContentChange
  | { kind: "current_version" }
  | { kind: "version_not_found" };

export async function restoreFileVersion(
  db: Db,
  actor: FileActor,
  row: FileRow,
  version: number,
): Promise<RestoreOutcome> {
  const tenant_id = actor.principal.tenant_id;
  if (version === row.version) return { kind: "current_version" };
  const source = await findFileVersion(db, tenant_id, row.id, version);
  if (!source?.sha256) return { kind: "version_not_found" };
  const twin = await findTwin(db, tenant_id, source.sha256, row.id);
  if (twin) return { kind: "duplicate", twinId: twin };
  const store = getObjectStore();
  const key = buildObjectKey(tenant_id, randomUUID());
  await store.putStream(
    key,
    await store.openRead(storageKey(source.storage_uri)),
    source.size_bytes,
  );
  return applyContent(db, actor, row.id, key, {
    filename: source.filename,
    content_type: source.content_type,
    size_bytes: source.size_bytes,
    sha256: source.sha256,
    storage_uri: composeStorageUri(key),
    scan_result: "clean",
    restored_from: version,
  });
}
