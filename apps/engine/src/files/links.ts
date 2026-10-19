import { and, eq, isNull } from "drizzle-orm";
import { z } from "zod";
import {
  AuditAction,
  type AuditActorType,
  auditAwait,
  FileLinkAddedMetadataSchema,
  FileLinkRemovedMetadataSchema,
} from "../audit/index.ts";
import { lockCatalogVocabulary } from "../db/catalog-vocabulary.ts";
import type { Executor } from "../db/client.ts";
import { fileLinkResourceEnum, fileLinks, fileStatusEnum, files } from "../db/schema/files.ts";
import { RequestSourceSchema } from "../observability/service-metadata.ts";

const linkSchema = z
  .object({
    tenant_id: z.uuid(),
    file_id: z.uuid(),
    resource_type: z.enum(fileLinkResourceEnum.enumValues),
    resource_id: z.uuid(),
    slug: z.string().nullable().optional(),
    role: z.string().nullable().optional(),
  })
  .strict();
const contextSchema = z
  .object({
    actor_type: z.enum(["user", "system_account", "system", "unknown"]),
    actor_id: z.string().nullable(),
    request_source: RequestSourceSchema,
    source: z.string().max(100).optional(),
    allowed_statuses: z.array(z.enum(fileStatusEnum.enumValues)).min(1).max(6),
    replace_file_id: z.uuid().optional(),
  })
  .strict();

export class FileLinkError extends Error {
  constructor(readonly code: "file_unavailable" | "file_link_conflict") {
    super(code);
    this.name = "FileLinkError";
  }
}

export async function linkStoredFile(
  exec: Executor,
  input: z.infer<typeof linkSchema>,
  context: {
    actor_type: AuditActorType;
    actor_id: string | null;
    request_source: z.infer<typeof RequestSourceSchema>;
    source?: string;
    allowed_statuses: readonly (typeof fileStatusEnum.enumValues)[number][];
    replace_file_id?: string;
  },
): Promise<typeof fileLinks.$inferSelect> {
  const link = linkSchema.parse(input);
  const actor = contextSchema.parse(context);
  return exec.transaction(async (tx) => {
    await lockCatalogVocabulary(tx, link.tenant_id);
    const [locked] = await tx
      .select({ id: files.id })
      .from(files)
      .where(and(eq(files.tenant_id, link.tenant_id), eq(files.id, link.file_id)))
      .for("update")
      .limit(1);
    if (!locked) throw new FileLinkError("file_unavailable");
    const [file] = await tx
      .select({ status: files.status, deleted_at: files.deleted_at })
      .from(files)
      .where(and(eq(files.tenant_id, link.tenant_id), eq(files.id, link.file_id)))
      .limit(1);
    if (!file || file.deleted_at !== null || !actor.allowed_statuses.includes(file.status))
      throw new FileLinkError("file_unavailable");
    let [inserted] = await tx.insert(fileLinks).values(link).onConflictDoNothing().returning();
    if (!inserted) {
      const [existing] = await tx
        .select()
        .from(fileLinks)
        .where(
          and(
            eq(fileLinks.tenant_id, link.tenant_id),
            eq(fileLinks.resource_type, link.resource_type),
            eq(fileLinks.resource_id, link.resource_id),
            link.slug == null ? isNull(fileLinks.slug) : eq(fileLinks.slug, link.slug),
          ),
        )
        .for("update")
        .limit(1);
      if (!existing) throw new FileLinkError("file_link_conflict");
      if (existing.file_id === link.file_id) return existing;
      if (existing.file_id !== actor.replace_file_id) throw new FileLinkError("file_link_conflict");
      await tx
        .delete(fileLinks)
        .where(and(eq(fileLinks.tenant_id, link.tenant_id), eq(fileLinks.id, existing.id)));
      await auditAwait(
        {
          tenant_id: link.tenant_id,
          actor_type: actor.actor_type,
          actor_id: actor.actor_id,
          action: AuditAction.FILE_LINK_REMOVED,
          resource_type: "file",
          resource_id: existing.file_id,
          result: "success",
          metadata: FileLinkRemovedMetadataSchema.parse({
            file_id: existing.file_id,
            resource_type: existing.resource_type,
            resource_id: existing.resource_id,
            slug: existing.slug,
            role: existing.role,
            request_source: actor.request_source,
            ...(actor.source ? { source: actor.source } : {}),
          }),
        },
        tx,
      );
      [inserted] = await tx.insert(fileLinks).values(link).returning();
      if (!inserted) throw new FileLinkError("file_link_conflict");
    }
    await auditAwait(
      {
        tenant_id: link.tenant_id,
        actor_type: actor.actor_type,
        actor_id: actor.actor_id,
        action: AuditAction.FILE_LINK_ADDED,
        resource_type: "file",
        resource_id: link.file_id,
        result: "success",
        metadata: FileLinkAddedMetadataSchema.parse({
          file_id: link.file_id,
          resource_type: link.resource_type,
          resource_id: link.resource_id,
          slug: link.slug ?? null,
          role: link.role ?? null,
          request_source: actor.request_source,
          ...(actor.source ? { source: actor.source } : {}),
        }),
      },
      tx,
    );
    return inserted;
  });
}

export async function replaceStoredFileLink(
  exec: Executor,
  input: z.infer<typeof linkSchema>,
  context: Omit<Parameters<typeof linkStoredFile>[2], "replace_file_id">,
): Promise<typeof fileLinks.$inferSelect> {
  const link = linkSchema.parse(input);
  const slug = link.slug;
  if (slug == null) throw new FileLinkError("file_link_conflict");
  return exec.transaction(async (tx) => {
    await lockCatalogVocabulary(tx, link.tenant_id);
    const [existing] = await tx
      .select({ file_id: fileLinks.file_id })
      .from(fileLinks)
      .where(
        and(
          eq(fileLinks.tenant_id, link.tenant_id),
          eq(fileLinks.resource_type, link.resource_type),
          eq(fileLinks.resource_id, link.resource_id),
          eq(fileLinks.slug, slug),
        ),
      )
      .for("update")
      .limit(1);
    return linkStoredFile(tx, link, {
      ...context,
      ...(existing ? { replace_file_id: existing.file_id } : {}),
    });
  });
}
