import { and, asc, desc, eq, gt, inArray, isNull, ne, sql } from "drizzle-orm";
import type { Actor } from "../../audit/index.ts";
import {
  type Executor,
  type IntakeSnapshot,
  intakeItemEvidence,
  intakeItems,
} from "../../db/index.ts";
import { type IntakeDuplicateMatch, sameSourceUrl, sourceUrlHost } from "../core/intake-dedupe.ts";

const OPEN_STATES = ["collected", "reviewing"] as const;
const URL_CANDIDATE_LIMIT = 200;

type IntakeRow = typeof intakeItems.$inferSelect;

export async function recentOpenIntakeTexts(
  db: Executor,
  p: { tenant_id: string; limit: number; exclude_request_id?: string | undefined },
): Promise<Array<{ id: string; title: string; body: string }>> {
  return await db
    .select({ id: intakeItems.id, title: intakeItems.title, body: intakeItems.body })
    .from(intakeItems)
    .where(
      and(
        eq(intakeItems.tenant_id, p.tenant_id),
        inArray(intakeItems.state, [...OPEN_STATES]),
        p.exclude_request_id ? ne(intakeItems.client_request_id, p.exclude_request_id) : undefined,
      ),
    )
    .orderBy(desc(intakeItems.created_at))
    .limit(p.limit);
}

export async function intakeRowByRequestId(
  db: Executor,
  tenant_id: string,
  client_request_id: string,
): Promise<IntakeRow | null> {
  const rows = await db
    .select()
    .from(intakeItems)
    .where(
      and(
        eq(intakeItems.tenant_id, tenant_id),
        eq(intakeItems.client_request_id, client_request_id),
      ),
    )
    .limit(1);
  return rows[0] ?? null;
}

async function lockOpenItem(
  tx: Executor,
  tenant_id: string,
  id: string,
): Promise<IntakeRow | null> {
  const rows = await tx
    .select()
    .from(intakeItems)
    .where(
      and(
        eq(intakeItems.tenant_id, tenant_id),
        eq(intakeItems.id, id),
        inArray(intakeItems.state, [...OPEN_STATES]),
      ),
    )
    .limit(1)
    .for("update");
  return rows[0] ?? null;
}

export async function lockOpenIntakeDuplicate(
  tx: Executor,
  p: { tenant_id: string; source_url?: string | undefined; similar_id?: string | null },
): Promise<{ row: IntakeRow; match: IntakeDuplicateMatch } | null> {
  const host = sourceUrlHost(p.source_url);
  if (host) {
    const rows = await tx
      .select({ id: intakeItems.id, snapshot: intakeItems.original_snapshot })
      .from(intakeItems)
      .where(
        and(
          eq(intakeItems.tenant_id, p.tenant_id),
          inArray(intakeItems.state, [...OPEN_STATES]),
          sql`${intakeItems.original_snapshot} ->> 'source_url' ILIKE ${`%${host}%`}`,
        ),
      )
      .orderBy(asc(intakeItems.created_at))
      .limit(URL_CANDIDATE_LIMIT);
    const hit = sameSourceUrl(
      p.source_url,
      rows.map((r) => ({ id: r.id, source_url: r.snapshot.source_url ?? null })),
    );
    const row = hit ? await lockOpenItem(tx, p.tenant_id, hit.id) : null;
    if (row) return { row, match: "source_url" };
  }
  if (!p.similar_id) return null;
  const row = await lockOpenItem(tx, p.tenant_id, p.similar_id);
  return row ? { row, match: "similar" } : null;
}

export async function insertIntakeEvidence(
  tx: Executor,
  p: {
    tenant_id: string;
    item_id: string;
    agent: string;
    session_id: string;
    repo: string | null;
    excerpt: string;
    captured_at: string;
    recorded_by: Actor;
  },
): Promise<boolean> {
  const inserted = await tx
    .insert(intakeItemEvidence)
    .values({
      tenant_id: p.tenant_id,
      item_id: p.item_id,
      agent: p.agent,
      session_id: p.session_id,
      repo: p.repo,
      excerpt: p.excerpt,
      captured_at: new Date(p.captured_at),
      recorded_by_type: p.recorded_by.kind,
      recorded_by_id: p.recorded_by.id,
    })
    .onConflictDoNothing()
    .returning({ id: intakeItemEvidence.id });
  return inserted.length > 0;
}

export async function intakeItemsWithoutGroupKey(
  db: Executor,
  p: { after: string | null; limit: number },
): Promise<Array<{ id: string; tenant_id: string; snapshot: IntakeSnapshot }>> {
  return await db
    .select({
      id: intakeItems.id,
      tenant_id: intakeItems.tenant_id,
      snapshot: intakeItems.original_snapshot,
    })
    .from(intakeItems) // tenant-filter:exempt — boot backfill walks every workspace
    .where(and(isNull(intakeItems.group_key), p.after ? gt(intakeItems.id, p.after) : undefined))
    .orderBy(asc(intakeItems.id))
    .limit(p.limit);
}

export async function setIntakeGroupKey(
  db: Executor,
  p: { tenant_id: string; id: string; group_key: string },
): Promise<void> {
  await db
    .update(intakeItems)
    .set({ group_key: p.group_key })
    .where(
      and(
        eq(intakeItems.tenant_id, p.tenant_id),
        eq(intakeItems.id, p.id),
        isNull(intakeItems.group_key),
      ),
    );
}
