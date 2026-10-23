import { and, eq, inArray, sql } from "drizzle-orm";
import type { Executor } from "../db/client.ts";
import { auditLog } from "../db/schema/audit.ts";
import { apiKeys, systemAccounts, users } from "../db/schema/identity.ts";
import { AuditAction } from "./types.ts";

export type FileCreator = { kind: "user" | "system_account"; id: string };

export async function recordedFileCreators(
  db: Executor,
  tenantId: string,
  files: readonly { id: string; created_by: string | null }[],
): Promise<Map<string, FileCreator>> {
  const creators = new Map<string, FileCreator>();
  const known = new Map(
    files.filter((file) => file.created_by !== null).map((file) => [file.id, file.created_by]),
  );
  if (known.size === 0) return creators;
  const rows = await db
    .select({
      file_id: auditLog.resource_id,
      kind: auditLog.actor_type,
      actor_id: auditLog.actor_id,
    })
    .from(auditLog)
    .where(
      and(
        eq(auditLog.tenant_id, tenantId),
        eq(auditLog.resource_type, "file"),
        eq(auditLog.action, AuditAction.FILE_CREATED),
        eq(auditLog.result, "success"),
        inArray(auditLog.resource_id, [...known.keys()]),
        sql`${auditLog.metadata}->'dedup' = 'false'::jsonb`,
      ),
    );
  const ambiguous = new Set<string>();
  for (const row of rows) {
    if (!row.file_id || !row.actor_id || known.get(row.file_id) !== row.actor_id) continue;
    if (row.kind !== "user" && row.kind !== "system_account") continue;
    const prior = creators.get(row.file_id);
    if (prior && prior.kind !== row.kind) ambiguous.add(row.file_id);
    creators.set(row.file_id, { kind: row.kind, id: row.actor_id });
  }
  for (const id of ambiguous) creators.delete(id);
  return creators;
}

export interface FileCreatorNames {
  name: string | null;
  api_key_name: string | null;
}

export async function fileCreatorNames(
  db: Executor,
  tenantId: string,
  fileId: string,
  creator: FileCreator | null,
): Promise<FileCreatorNames> {
  if (!creator) return { name: null, api_key_name: null };
  const [person] =
    creator.kind === "user"
      ? await db
          .select({ name: sql<string | null>`nullif(${users.display_name}, '')` })
          .from(users)
          .where(and(eq(users.tenant_id, tenantId), eq(users.id, creator.id)))
          .limit(1)
      : await db
          .select({ name: systemAccounts.name })
          .from(systemAccounts)
          .where(and(eq(systemAccounts.tenant_id, tenantId), eq(systemAccounts.id, creator.id)))
          .limit(1);
  const [key] = await db
    .select({ name: apiKeys.name })
    .from(auditLog)
    .innerJoin(
      apiKeys,
      and(
        eq(apiKeys.tenant_id, auditLog.tenant_id),
        sql`${apiKeys.id}::text = ${auditLog.metadata}->>'audit_used_api_key_id'`,
      ),
    )
    .where(
      and(
        eq(auditLog.tenant_id, tenantId),
        eq(auditLog.resource_type, "file"),
        eq(auditLog.action, AuditAction.FILE_CREATED),
        eq(auditLog.result, "success"),
        eq(auditLog.resource_id, fileId),
        eq(auditLog.actor_id, creator.id),
        sql`${auditLog.metadata}->'dedup' = 'false'::jsonb`,
      ),
    )
    .limit(1);
  return { name: person?.name ?? null, api_key_name: key?.name ?? null };
}
