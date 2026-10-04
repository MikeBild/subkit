import { and, eq, isNull, sql } from "drizzle-orm";
import type { Executor } from "../db/client.ts";
import { knowledgeSources } from "../db/schema/knowledge_sources.ts";
import { envIntOr } from "../utils/env-config.ts";

export const KNOWLEDGE_SOURCE_MAX_BYTES = envIntOr("KNOWLEDGE_SOURCE_MAX_BYTES", 50 * 1024 * 1024);

export const KNOWLEDGE_TENANT_MAX_BYTES = envIntOr("KNOWLEDGE_TENANT_MAX_BYTES", 500 * 1024 * 1024);

export const MAX_FILES_PER_MESSAGE = envIntOr("KNOWLEDGE_MAX_FILES_PER_MESSAGE", 10);

export class KnowledgeBudgetExceededError extends Error {
  readonly bytes_used: number;
  readonly bytes_limit: number;
  constructor(message: string, bytes_used: number, bytes_limit: number) {
    super(message);
    this.name = "KnowledgeBudgetExceededError";
    this.bytes_used = bytes_used;
    this.bytes_limit = bytes_limit;
  }
}

export async function assertTenantKnowledgeBudget(
  tx: Executor,
  tenant_id: string,
  add_bytes: number,
  exclude_source_id?: string,
): Promise<void> {
  const rows = await tx
    .select({ total: sql<number>`coalesce(sum(${knowledgeSources.bytes_total}), 0)` })
    .from(knowledgeSources)
    .where(
      and(
        eq(knowledgeSources.tenant_id, tenant_id),
        isNull(knowledgeSources.deleted_at),
        ...(exclude_source_id ? [sql`${knowledgeSources.id} <> ${exclude_source_id}`] : []),
      ),
    );
  const currentBytes = Number(rows[0]?.total ?? 0);
  if (currentBytes + add_bytes > KNOWLEDGE_TENANT_MAX_BYTES) {
    throw new KnowledgeBudgetExceededError(
      `Tenant knowledge budget exceeded (${currentBytes} + ${add_bytes} > ${KNOWLEDGE_TENANT_MAX_BYTES})`,
      currentBytes + add_bytes,
      KNOWLEDGE_TENANT_MAX_BYTES,
    );
  }
}
