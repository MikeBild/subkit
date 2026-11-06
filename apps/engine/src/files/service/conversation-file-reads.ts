import { and, eq, inArray, isNull } from "drizzle-orm";
import type { Executor } from "../../db/client.ts";
import { fileLinks, files } from "../../db/schema/files.ts";

import type { FileRow } from "./shared.ts";

export async function findConversationReadyFile(
  db: Executor,
  tenant_id: string,
  conversation_id: string,
  file_id: string,
  sha256: string,
): Promise<FileRow | undefined> {
  const [row] = await db
    .select({ file: files })
    .from(fileLinks)
    .innerJoin(files, and(eq(files.id, fileLinks.file_id), eq(files.tenant_id, tenant_id)))
    .where(
      and(
        eq(fileLinks.tenant_id, tenant_id),
        eq(fileLinks.resource_type, "conversation"),
        eq(fileLinks.resource_id, conversation_id),
        eq(fileLinks.file_id, file_id),
        eq(files.status, "ready"),
        isNull(files.deleted_at),
        eq(files.sha256, sha256),
      ),
    )
    .limit(1);
  return row?.file;
}

export async function findConversationAttachmentBySlug(
  db: Executor,
  tenant_id: string,
  conversation_id: string,
  slug: string,
) {
  const [link] = await db
    .select({ file_id: fileLinks.file_id, slug: fileLinks.slug })
    .from(fileLinks)
    .where(
      and(
        eq(fileLinks.tenant_id, tenant_id),
        eq(fileLinks.resource_type, "conversation"),
        eq(fileLinks.resource_id, conversation_id),
        eq(fileLinks.slug, slug),
      ),
    )
    .limit(1);
  return link;
}

export async function findReadyFileByHash(
  db: Executor,
  tenant_id: string,
  file_id: string,
  sha256: string,
): Promise<FileRow | undefined> {
  const [row] = await db
    .select({ file: files })
    .from(files)
    .where(
      and(
        eq(files.tenant_id, tenant_id),
        eq(files.id, file_id),
        eq(files.sha256, sha256),
        eq(files.status, "ready"),
        isNull(files.deleted_at),
      ),
    )
    .limit(1);
  return row?.file;
}

export async function listExecutionDataFileSizes(
  db: Executor,
  tenant_id: string,
  file_ids: readonly string[],
): Promise<Array<{ id: string; size_bytes: number }>> {
  return db
    .select({ id: files.id, size_bytes: files.size_bytes })
    .from(fileLinks)
    .innerJoin(files, and(eq(files.id, fileLinks.file_id), eq(files.tenant_id, tenant_id)))
    .where(
      and(
        eq(fileLinks.tenant_id, tenant_id),
        inArray(fileLinks.file_id, [...file_ids]),
        eq(fileLinks.role, "execution_data"),
      ),
    );
}
