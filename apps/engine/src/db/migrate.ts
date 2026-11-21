import { sql } from "drizzle-orm";
import { drizzle } from "drizzle-orm/node-postgres";
import type pg from "pg";
import { z } from "zod";
import { errorFields, logger } from "../logging/index.ts";
import { cutOverLearningCandidates } from "../skill-candidates/learning-cutover.ts";
import { createMigrationDbFromUrl, type Db } from "./client.ts";
import { runContextNoteFactsBackfill } from "./migrations/context-note-facts-backfill.ts";
import { EMBEDDED_MIGRATIONS, type EmbeddedMigration } from "./migrations/embedded.ts";
import { runInboxNonActionablePurge } from "./migrations/inbox-nonactionable-purge.ts";
import { runLoopToForEachBackfill } from "./migrations/loop-to-for-each-backfill.ts";
import { runMetricsScopeBackfill } from "./migrations/metrics-scope-backfill.ts";
import * as schema from "./schema/index.ts";

interface MigrationReport {
  applied: number;
  skipped: number;
  hash_drift_backfilled: number;
  total: number;
}

const MigrationJournalRowSchema = z.object({
  row_id: z.number().int(),
  hash: z.string(),
  created_at: z.number().int().nullable(),
  tag: z.string().nullable(),
});

const MissingInDbRowSchema = z.object({
  idx: z.number().int(),
  tag: z.string(),
  hash: z.string(),
});

export const DriftReportSchema = z.object({
  unknown_in_db: z.array(MigrationJournalRowSchema),
  historical_in_db: z.array(MigrationJournalRowSchema),
  missing_in_db: z.array(MissingInDbRowSchema),
});

export type DriftReport = z.infer<typeof DriftReportSchema>;

async function ensureMigrationsTable(db: Db): Promise<void> {
  await db.execute(sql`CREATE EXTENSION IF NOT EXISTS "pgcrypto" WITH SCHEMA "public"`);
  await db.execute(sql`CREATE SCHEMA IF NOT EXISTS "subkit"`);
  await db.execute(
    sql`
      CREATE TABLE IF NOT EXISTS "subkit"."__drizzle_migrations" (
        id SERIAL PRIMARY KEY,
        hash text NOT NULL,
        created_at bigint
      )
    `,
  );
  await db.execute(
    sql`ALTER TABLE "subkit"."__drizzle_migrations" ADD COLUMN IF NOT EXISTS tag text`,
  );
  const drizzleSchemaTable = (await db.execute(
    sql`SELECT to_regclass('drizzle.__drizzle_migrations') IS NOT NULL AS present`,
  )) as unknown as { rows: Array<{ present: boolean }> };
  if (drizzleSchemaTable.rows[0]?.present === true) {
    await db.execute(sql`
      INSERT INTO "subkit"."__drizzle_migrations" (hash, created_at, tag)
      SELECT source.hash, source.created_at, source.tag
        FROM "drizzle"."__drizzle_migrations" source
       WHERE NOT EXISTS (
         SELECT 1
           FROM "subkit"."__drizzle_migrations" isolated
          WHERE isolated.hash = source.hash
            AND isolated.tag IS NOT DISTINCT FROM source.tag
       )
    `);
  }
}

interface AppliedState {
  hashes: Set<string>;
  tags: Set<string>;
  count: number;
  baselinePresent: boolean;
}

interface JournalRow {
  id: number | string;
  hash: string;
  tag: string | null;
}

const MIGRATION_LOCK_KEY = 776_644_2026;

export const SQUASHED_CHAIN_HEAD_TAG = "0023_drop_chat_mode";

export const RETIRED_BASELINE_TAGS: readonly string[] = ["0000_baseline"];

export function splitLineage<T extends JournalRow>(
  rows: readonly T[],
  baselineTag: string | undefined,
): { history: T[]; current: T[] } {
  const baselineId = rows.find((r) => r.tag === baselineTag)?.id;
  if (baselineId !== undefined) {
    const boundary = Number(baselineId);
    return {
      history: rows.filter((r) => Number(r.id) < boundary),
      current: rows.filter((r) => Number(r.id) >= boundary),
    };
  }
  const headId = rows.find((r) => r.tag === SQUASHED_CHAIN_HEAD_TAG)?.id;
  if (headId === undefined) return { history: [], current: [...rows] };
  const boundary = Number(headId);
  return {
    history: rows.filter((r) => Number(r.id) <= boundary),
    current: rows.filter((r) => Number(r.id) > boundary),
  };
}

export function stopsBeforeChainHead(
  rows: readonly JournalRow[],
  baselineTag: string | undefined,
): boolean {
  const tags = new Set(rows.map((r) => r.tag));
  return (
    !tags.has(baselineTag ?? null) &&
    !tags.has(SQUASHED_CHAIN_HEAD_TAG) &&
    RETIRED_BASELINE_TAGS.some((tag) => tags.has(tag))
  );
}

async function readJournalRows(db: Db): Promise<JournalRow[]> {
  const rows = (await db.execute(
    sql`SELECT id, hash, tag FROM "subkit"."__drizzle_migrations" ORDER BY id`,
  )) as unknown as { rows?: JournalRow[] };
  return rows.rows ?? [];
}

async function readAppliedState(db: Db, baselineTag: string | undefined): Promise<AppliedState> {
  const rows = await readJournalRows(db);
  const baselinePresent = rows.some((r) => r.tag === baselineTag);
  const scoped = baselinePresent ? splitLineage(rows, baselineTag).current : rows;
  return {
    hashes: new Set(scoped.map((r) => r.hash)),
    tags: new Set(scoped.map((r) => r.tag).filter((t): t is string => t != null)),
    count: scoped.length,
    baselinePresent,
  };
}

export async function runMigrations(
  db: Db,
  migrations: readonly EmbeddedMigration[] = EMBEDDED_MIGRATIONS,
): Promise<MigrationReport> {
  const pool = (db as unknown as { $client?: pg.Pool }).$client;
  if (!pool || typeof pool.connect !== "function") {
    const report = await applyMigrations(db, migrations);
    return report;
  }
  const lockClient = await pool.connect();
  try {
    await lockClient.query("SELECT pg_advisory_lock($1)", [MIGRATION_LOCK_KEY]);
    const lockedDb = drizzle(lockClient, { schema }) as Db;
    const report = await applyMigrations(lockedDb, migrations);
    return report;
  } finally {
    try {
      await lockClient.query("SELECT pg_advisory_unlock($1)", [MIGRATION_LOCK_KEY]);
    } catch {}
    lockClient.release();
  }
}

export async function runMigrationsFromUrl(
  url: string,
  migrations: readonly EmbeddedMigration[] = EMBEDDED_MIGRATIONS,
): Promise<MigrationReport> {
  const { pool, db } = createMigrationDbFromUrl(url);
  try {
    return await runMigrations(db, migrations);
  } finally {
    await pool.end();
  }
}

async function applyMigrations(
  db: Db,
  migrations: readonly EmbeddedMigration[] = EMBEDDED_MIGRATIONS,
): Promise<MigrationReport> {
  logger.info({
    module: "db",
    action: "migrate.started",
    msg: "applying embedded migrations",
    total: migrations.length,
  });

  await ensureMigrationsTable(db);
  const baselineTag = migrations.find((m) => m.idx === 0)?.tag;
  let applied = await readAppliedState(db, baselineTag);

  let appliedCount = 0;
  let skippedCount = 0;
  let hashDriftCount = 0;
  for (const m of migrations) {
    if (applied.tags.has(m.tag)) {
      if (applied.hashes.has(m.hash)) {
        skippedCount++;
      } else {
        hashDriftCount++;
        logger.warn({
          module: "db",
          action: "migrate.hash_drift",
          msg: "migration file hash changed since it was applied — backfilling stored hash",
          idx: m.idx,
          tag: m.tag,
          new_hash: m.hash,
        });
        await db.execute(
          sql`UPDATE "subkit"."__drizzle_migrations" SET hash = ${m.hash} WHERE tag = ${m.tag}`,
        );
        applied.hashes.add(m.hash);
      }
      continue;
    }
    if (m.idx === 0 && applied.count > 0 && !applied.baselinePresent) {
      if (!applied.tags.has(SQUASHED_CHAIN_HEAD_TAG)) {
        logger.error({
          module: "db",
          action: "migrate.baseline_stamp_refused",
          msg: "database carries migration history that stops before the squashed chain head — upgrade through a release that still ships that chain first",
          tag: m.tag,
          required_tag: SQUASHED_CHAIN_HEAD_TAG,
          applied_rows: applied.count,
        });
        throw new Error(
          `migration baseline ${m.tag} cannot be stamped: database history does not include ${SQUASHED_CHAIN_HEAD_TAG}`,
        );
      }
      hashDriftCount++;
      logger.warn({
        module: "db",
        action: "migrate.hash_drift",
        msg: "baseline already applied under a pre-squash lineage — stamping tag + hash",
        idx: m.idx,
        tag: m.tag,
        new_hash: m.hash,
      });
      await db.execute(
        sql`INSERT INTO "subkit"."__drizzle_migrations" (hash, created_at, tag) VALUES (${m.hash}, ${m.when}, ${m.tag})`,
      );
      applied = await readAppliedState(db, m.tag);
      continue;
    }
    if (applied.hashes.has(m.hash)) {
      skippedCount++;
      await db.execute(
        sql`UPDATE "subkit"."__drizzle_migrations" SET tag = ${m.tag} WHERE hash = ${m.hash} AND tag IS NULL`,
      );
      applied.tags.add(m.tag);
      continue;
    }
    logger.info({
      module: "db",
      action: "migrate.applying",
      msg: "applying migration",
      idx: m.idx,
      tag: m.tag,
      statement_count: m.statements.length,
    });
    const migStartedAt = Date.now();
    await db.transaction(async (tx) => {
      await tx.execute(sql`SET LOCAL search_path = subkit, pg_catalog, public`);
      for (const stmt of m.statements) {
        await tx.execute(sql.raw(stmt));
      }
      await tx.execute(
        sql`INSERT INTO "subkit"."__drizzle_migrations" ("hash", "created_at", "tag") VALUES (${m.hash}, ${m.when}, ${m.tag})`,
      );
    });
    applied.hashes.add(m.hash);
    applied.tags.add(m.tag);
    applied.count += 1;
    appliedCount++;
    logger.info({
      module: "db",
      action: "migrate.applied_one",
      msg: "migration applied",
      idx: m.idx,
      tag: m.tag,
      duration_ms: Date.now() - migStartedAt,
    });
  }

  await db.execute(sql`SELECT set_config('search_path', 'subkit,pg_catalog,public', false)`);

  try {
    await runInboxNonActionablePurge(db);
  } catch (err) {
    logger.error({
      module: "db",
      action: "migrate.code_backfill_failed",
      msg: "inbox non-actionable purge failed (non-fatal; retried on next boot)",
      ...errorFields(err),
    });
  }
  try {
    await runLoopToForEachBackfill(db);
  } catch (err) {
    logger.error({
      module: "db",
      action: "migrate.code_backfill_failed",
      msg: "loop→for_each backfill failed (non-fatal; retried on next boot)",
      ...errorFields(err),
    });
  }
  try {
    await runMetricsScopeBackfill(db);
  } catch (err) {
    logger.error({
      module: "db",
      action: "migrate.code_backfill_failed",
      msg: "metrics:read scope backfill failed (non-fatal; retried on next boot)",
      ...errorFields(err),
    });
  }
  try {
    await runContextNoteFactsBackfill(db);
  } catch (err) {
    logger.error({
      module: "db",
      action: "migrate.code_backfill_failed",
      msg: "context note facts backfill failed (non-fatal; retried on next boot)",
      ...errorFields(err),
    });
  }

  try {
    const cutover = await cutOverLearningCandidates(db);
    if (cutover.collected + cutover.dropped > 0)
      logger.info({
        module: "db",
        action: "skill_candidate.learning_cutover.completed",
        msg: "open learning candidates moved into intake",
        collected: cutover.collected,
        dropped: cutover.dropped,
      });
  } catch (err) {
    logger.error({
      module: "db",
      action: "migrate.code_backfill_failed",
      msg: "learning candidate cutover failed (non-fatal; retried on next boot)",
      ...errorFields(err),
    });
  }

  const report: MigrationReport = {
    applied: appliedCount,
    skipped: skippedCount,
    hash_drift_backfilled: hashDriftCount,
    total: migrations.length,
  };

  logger.info({
    module: "db",
    action: "migrate.applied",
    msg: "migrations applied successfully",
    ...report,
  });

  return report;
}

export async function detectDrift(db: Db): Promise<DriftReport> {
  await ensureMigrationsTable(db);
  const rows = (await db.execute(
    sql`SELECT id, hash, created_at, tag FROM "subkit"."__drizzle_migrations" ORDER BY id`,
  )) as unknown as {
    rows: Array<{
      id: number;
      hash: string;
      created_at: number | null;
      tag: string | null;
    }>;
  };
  const embeddedByTag = new Map(EMBEDDED_MIGRATIONS.map((m) => [m.tag, m.hash]));
  const embeddedByHash = new Map(EMBEDDED_MIGRATIONS.map((m) => [m.hash, m.tag]));
  const baselineTag = EMBEDDED_MIGRATIONS.find((m) => m.idx === 0)?.tag;
  const { history, current } = splitLineage(rows.rows ?? [], baselineTag);
  const toRow = (r: {
    id: number;
    hash: string;
    created_at: number | null;
    tag: string | null;
  }) => ({
    row_id: r.id,
    hash: r.hash,
    created_at: r.created_at,
    tag: r.tag,
  });

  const unknown_in_db = current
    .filter(
      (r) =>
        r.tag !== null &&
        (embeddedByTag.get(r.tag) !== r.hash || embeddedByHash.get(r.hash) !== r.tag),
    )
    .map(toRow);

  const historical_in_db = [
    ...history,
    ...current.filter((r) => r.tag === null && !embeddedByHash.has(r.hash)),
  ].map(toRow);

  const currentTags = new Set(
    current.flatMap((r) => (r.tag !== null && embeddedByTag.get(r.tag) === r.hash ? [r.tag] : [])),
  );
  const untaggedCurrentHashes = new Set(
    current.filter((r) => r.tag === null && embeddedByHash.has(r.hash)).map((r) => r.hash),
  );
  const missing_in_db = EMBEDDED_MIGRATIONS.filter(
    (m) => !currentTags.has(m.tag) && !untaggedCurrentHashes.has(m.hash),
  ).map((m) => ({ idx: m.idx, tag: m.tag, hash: m.hash }));

  return { unknown_in_db, historical_in_db, missing_in_db };
}

export function listEmbeddedMigrations(): readonly EmbeddedMigration[] {
  return EMBEDDED_MIGRATIONS;
}
