import { and, desc, eq, isNotNull, sql } from "drizzle-orm";
import { isConversationTitleOpening, refreshConversationTitle } from "../conversations/title.ts";
import type { Db } from "../db/client.ts";
import { conversations, dataMigrations, tenants } from "../db/schema/index.ts";
import { withTenantWork } from "../execution/tenant-work.ts";
import { SelfServiceIdentityError } from "../identity/index.ts";
import { errorFields, logger } from "../logging/logger.ts";

export const CONVERSATION_TITLE_SWEEP_NAME = "conversation_title_model_v4";

const SCAN = 100;

const RETITLE = 10;

export interface ConversationTitleSweepDependencies {
  refreshTitle?: typeof refreshConversationTitle;
}

export { isStillOpeningLine } from "../conversations/title.ts";

export interface ConversationTitleSweepReport {
  done: boolean;
  scanned: number;
  retitled: number;
}

let cursor: { updated_at: string; id: string } | null = null;

export function resetConversationTitleSweep(): void {
  cursor = null;
}

export async function runConversationTitleSweep(
  db: Db,
  dependencies: ConversationTitleSweepDependencies = {},
): Promise<ConversationTitleSweepReport> {
  const marker = await db
    .select({ name: dataMigrations.name })
    .from(dataMigrations) // tenant-filter:exempt — instance-global sweep ledger
    .where(eq(dataMigrations.name, CONVERSATION_TITLE_SWEEP_NAME))
    .limit(1);
  if (marker.length > 0) return { done: true, scanned: 0, retitled: 0 };

  const started = Date.now();
  const conds = [
    isNotNull(conversations.title),
    eq(conversations.title_locked, false),
    sql`EXISTS(SELECT 1 FROM ${tenants} WHERE ${tenants.id}=${conversations.tenant_id} AND ${tenants.status}='active' AND ${tenants.deleted_at} IS NULL)`,
  ];
  if (cursor) {
    conds.push(
      sql`(${conversations.updated_at}, ${conversations.id}) < (${cursor.updated_at}::timestamptz, ${cursor.id}::uuid)`,
    );
  }

  const batch = await db
    .select({
      id: conversations.id,
      tenant_id: conversations.tenant_id,
      updated_at: sql<string>`${conversations.updated_at}::text`,
    })
    .from(conversations) // tenant-filter:exempt — instance-wide maintenance sweep
    .where(and(...conds))
    .orderBy(desc(conversations.updated_at), desc(conversations.id))
    .limit(SCAN);

  if (batch.length === 0) {
    await db
      .insert(dataMigrations)
      .values({ name: CONVERSATION_TITLE_SWEEP_NAME })
      .onConflictDoNothing();
    cursor = null;
    logger.info({
      module: "scheduler",
      action: "conversation_title_sweep.completed",
      msg: "conversation title maintenance walk completed",
    });
    return { done: true, scanned: 0, retitled: 0 };
  }
  const refreshTitle = dependencies.refreshTitle ?? refreshConversationTitle;
  let attempted = 0;
  let retitled = 0;
  for (const row of batch) {
    const outcome = await withTenantWork(row.tenant_id, async () => {
      try {
        const candidate = await isConversationTitleOpening(db, row.tenant_id, row.id);
        if (!candidate) return "visited";
        if (attempted >= RETITLE) return "deferred";
        attempted += 1;
        if (await refreshTitle(row.tenant_id, row.id, db)) retitled += 1;
        return "visited";
      } catch (error) {
        if (error instanceof SelfServiceIdentityError && error.code === "tenant_unavailable")
          return "visited";
        throw error;
      }
    });
    if (outcome === "deferred") break;
    cursor = { updated_at: row.updated_at, id: row.id };
  }

  logger.info({
    module: "scheduler",
    action: "conversation_title_sweep.fired",
    msg: "named dormant conversations",
    scanned: batch.length,
    attempted,
    retitled,
    duration_ms: Date.now() - started,
  });
  return { done: false, scanned: batch.length, retitled };
}

export async function runConversationTitleSweepSafely(db: Db): Promise<void> {
  try {
    await runConversationTitleSweep(db);
  } catch (err) {
    logger.warn({
      module: "scheduler",
      action: "conversation_title_sweep.failed",
      msg: "dormant-conversation titling sweep failed",
      ...errorFields(err),
    });
  }
}
