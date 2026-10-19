import { and, eq, isNull } from "drizzle-orm";
import { z } from "zod";
import {
  AuditAction,
  type AuditActorType,
  auditAwait,
  FileLinkAddedMetadataSchema,
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
    const [inserted] = await tx.insert(fileLinks).values(link).onConflictDoNothing().returning();
    if (!inserted) {
      const [existing] = await tx
        .select()
        .from(fileLinks)
        .where(
          and(
            eq(fileLinks.tenant_id, link.tenant_id),
            eq(fileLinks.file_id, link.file_id),
            eq(fileLinks.resource_type, link.resource_type),
            eq(fileLinks.resource_id, link.resource_id),
            link.slug == null ? isNull(fileLinks.slug) : eq(fileLinks.slug, link.slug),
          ),
        )
        .limit(1);
      if (!existing) throw new FileLinkError("file_link_conflict");
      return existing;
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
