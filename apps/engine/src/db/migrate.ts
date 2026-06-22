// Migration runner.
//
// The migration set is **embedded** at build time via the
// `embedded.ts` manifest — each migration's SQL is imported with the
// `with { type: "text" }` attribute and the journal with
// `with { type: "json" }`, so `bun build --compile` inlines them into
// the binary. Every compiled `engine` carries its own journal + SQL
// bodies as inline string literals; there is no runtime disk read for
// migrations, no separate `migrate` container, and no way for a
// parallel migrator to apply a different lineage onto the same
// database.
//
// Why a custom runner instead of drizzle-orm's `migrate()`?
// ---------------------------------------------------------
// drizzle-orm's migrator decides "is this migration applied yet?" by
// comparing its journal `when` timestamp against the **highest
// `created_at` in `drizzle.__drizzle_migrations`**. When the journal
// timestamps are non-monotonic (e.g. a later migration was generated
// on a wall-clock that had gone backwards, or the journal was hand-
// edited), every subsequent migration is silently skipped — the runner
// reports "success" but the SQL never runs.
//
// We saw this in practice: migration `0022_fluffy_mister_fear` had a
// journal `when` less than its predecessor, so `0023_...` was skipped
// even though its hash was not in the migrations table. The fix here
// is simple: use **hash-set membership** ("is this migration's hash
// already in the table?") instead of a timestamp watermark.

import { sql } from "drizzle-orm";
import { z } from "zod";
import { errorFields, logger } from "../logging/logger.ts";
import type { Db } from "./client.ts";
import { EMBEDDED_MIGRATIONS, type EmbeddedMigration } from "./migrations/embedded.ts";
import { runItemvarBackfill } from "./migrations/itemvar-backfill.ts";
import { runLoopToForEachBackfill } from "./migrations/loop-to-for-each-backfill.ts";

export interface MigrationReport {
  applied: number;
  skipped: number;
  hash_drift_backfilled: number;
  total: number;
}

/**
 * Single source of truth for the drift report wire shape — the
 * `/v1/diagnostics/drift` route imports this schema rather than
 * redeclaring the columns. Keeps the runtime + the OpenAPI surface
 * locked together.
 */
export const UnknownInDbRowSchema = z.object({
  row_id: z.number().int(),
  hash: z.string(),
  created_at: z.number().int().nullable(),
});

export const MissingInDbRowSchema = z.object({
  idx: z.number().int(),
  tag: z.string(),
  hash: z.string(),
});

export const DriftReportSchema = z.object({
  /** Rows present in `drizzle.__drizzle_migrations` whose hash is not
   *  in this binary's embedded set. Indicates the DB was migrated by a
   *  different binary lineage — an actionable signal. */
  unknown_in_db: z.array(UnknownInDbRowSchema),
  /** Embedded migrations whose hash is not in the DB. Informational —
   *  `runMigrations` would apply these on the same boot. */
  missing_in_db: z.array(MissingInDbRowSchema),
});

export type DriftReport = z.infer<typeof DriftReportSchema>;

async function ensureMigrationsTable(db: Db): Promise<void> {
  // pgcrypto is required for `gen_random_uuid()` defaults. Drizzle does
  // not emit this automatically when schemas use `.defaultRandom()`.
  await db.execute(sql`CREATE EXTENSION IF NOT EXISTS "pgcrypto"`);
  await db.execute(sql`CREATE SCHEMA IF NOT EXISTS "drizzle"`);
  await db.execute(
    sql`
      CREATE TABLE IF NOT EXISTS "drizzle"."__drizzle_migrations" (
        id SERIAL PRIMARY KEY,
        hash text NOT NULL,
        created_at bigint
      )
    `,
  );
  // Migration IDENTITY column. drizzle's stock table tracks only `hash`,
  // which forces a positional (row-count) fallback to recognise a
  // migration whose .sql was edited after it was applied. That fallback
  // mis-fires on any DB whose `__drizzle_migrations` carries MORE rows
  // than the embedded set — exactly the post-baseline-squash state of a
  // long-lived DB (its pre-squash rows were never collapsed). The result
  // was that every genuinely-new migration was silently skipped on such a
  // DB (prod shipped v7.7.0 with `conversations.turn_count` never
  // created). Tracking the stable `tag` removes the positional guess: a
  // migration is applied iff its tag is recorded, full stop.
  await db.execute(
    sql`ALTER TABLE "drizzle"."__drizzle_migrations" ADD COLUMN IF NOT EXISTS tag text`,
  );
}

interface AppliedState {
  hashes: Set<string>;
  /** Tags of migrations already recorded as applied — the authoritative
   *  applied-set. A migration is applied iff its tag is here. */
  tags: Set<string>;
  /** Total tracking rows. Used only to recognise the synthetic squashed
   *  baseline (idx 0): a DB with any migration history already has the
   *  baseline schema, so the baseline is stamped rather than re-run. */
  count: number;
}

async function readAppliedHashes(db: Db): Promise<AppliedState> {
  const rows = (await db.execute(
    sql`SELECT hash, tag FROM "drizzle"."__drizzle_migrations"`,
  )) as unknown as { rows: Array<{ hash: string; tag: string | null }> };
  const dbRows = rows.rows ?? [];
  const hashes = new Set(dbRows.map((r) => r.hash));
  const tags = new Set(dbRows.map((r) => r.tag).filter((t): t is string => t != null));
  return { hashes, tags, count: dbRows.length };
}

/**
 * Apply embedded migrations to the given database connection.
 *
 * Idempotent: re-running on an already-migrated DB is a no-op. Safe to
 * invoke on every engine boot. The caller owns the connection pool —
 * this function does not open or close any pools.
 */
export async function runMigrations(db: Db): Promise<MigrationReport> {
  logger.info({
    module: "db",
    action: "migrate.started",
    msg: "applying embedded migrations",
    total: EMBEDDED_MIGRATIONS.length,
  });

  await ensureMigrationsTable(db);
  const applied = await readAppliedHashes(db);

  let appliedCount = 0;
  let skippedCount = 0;
  let hashDriftCount = 0;
  for (const m of EMBEDDED_MIGRATIONS) {
    // Authoritative: a migration is applied iff its tag is recorded.
    if (applied.tags.has(m.tag)) {
      if (applied.hashes.has(m.hash)) {
        skippedCount++;
      } else {
        // Tag recorded but hash differs → the .sql was edited after it was
        // applied. Backfill the stored hash; never re-run.
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
          sql`UPDATE "drizzle"."__drizzle_migrations" SET hash = ${m.hash} WHERE tag = ${m.tag}`,
        );
        applied.hashes.add(m.hash);
      }
      continue;
    }
    // Legacy adoption: a row from before tag-tracking whose hash matches
    // this migration. It IS applied — stamp its tag so future boots match
    // by identity, then skip.
    if (applied.hashes.has(m.hash)) {
      skippedCount++;
      await db.execute(
        sql`UPDATE "drizzle"."__drizzle_migrations" SET tag = ${m.tag} WHERE hash = ${m.hash} AND tag IS NULL`,
      );
      applied.tags.add(m.tag);
      continue;
    }
    // Synthetic squashed baseline (idx 0): its hash is never present on a
    // DB migrated through the pre-squash lineage, but the schema already
    // exists whenever the DB has any migration history. Stamp it instead
    // of re-running the huge, non-idempotent baseline body.
    if (m.idx === 0 && applied.count > 0) {
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
        sql`INSERT INTO "drizzle"."__drizzle_migrations" (hash, created_at, tag) VALUES (${m.hash}, ${m.when}, ${m.tag})`,
      );
      applied.hashes.add(m.hash);
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
      for (const stmt of m.statements) {
        // Safe `sql.raw`: `stmt` originates from `EMBEDDED_MIGRATIONS`,
        // i.e. SQL bodies imported with `with { type: "text" }` and
        // baked into the engine binary at build time. There is no
        // user-controlled path into this string — drift between source
        // and embedded set is caught by `migrate-embedded-bundle.test.ts`.
        await tx.execute(sql.raw(stmt));
      }
      await tx.execute(
        sql`INSERT INTO "drizzle"."__drizzle_migrations" ("hash", "created_at", "tag") VALUES (${m.hash}, ${m.when}, ${m.tag})`,
      );
    });
    applied.hashes.add(m.hash);
    applied.tags.add(m.tag);
    applied.count += 1;
    appliedCount++;
    // Per-migration timing — a slow migration on boot used to be an
    // invisible contributor to the boot-time budget. With this an
    // operator can attribute a long boot to the exact migration.
    logger.info({
      module: "db",
      action: "migrate.applied_one",
      msg: "migration applied",
      idx: m.idx,
      tag: m.tag,
      duration_ms: Date.now() - migStartedAt,
    });
  }

  // Code backfills — run after the SQL set so their schema exists.
  // Each is one-shot via a `data_migrations` marker row and never
  // breaks boot: a failure logs + leaves the marker unset so the next
  // boot retries.
  try {
    await runItemvarBackfill(db);
  } catch (err) {
    logger.error({
      module: "db",
      action: "migrate.code_backfill_failed",
      msg: "item_var backfill failed (non-fatal; retried on next boot)",
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

  const report: MigrationReport = {
    applied: appliedCount,
    skipped: skippedCount,
    hash_drift_backfilled: hashDriftCount,
    total: EMBEDDED_MIGRATIONS.length,
  };

  logger.info({
    module: "db",
    action: "migrate.applied",
    msg: "migrations applied successfully",
    ...report,
  });

  return report;
}

/**
 * Compare the database's `drizzle.__drizzle_migrations` rows against
 * this binary's embedded set.
 *
 * `unknown_in_db.length > 0` means the DB carries migration rows from
 * a binary lineage this engine doesn't recognise. That is the
 * symptom: prod had 27 such rows and three subsystems failed because
 * the schema state didn't match the engine's expectations. Operators
 * should treat this as a deploy-time alarm.
 *
 * Side effect: the function calls `ensureMigrationsTable`
 * before reading, which `CREATE EXTENSION IF NOT EXISTS pgcrypto`,
 * `CREATE SCHEMA IF NOT EXISTS drizzle`, and creates the journal table
 * if missing. On every boot path migrations run first, so this is a
 * no-op; on direct calls against a virgin database it primes the
 * journal table so a follow-up `runMigrations(db)` doesn't re-create
 * it. The drift report itself is read-only.
 */
export async function detectDrift(db: Db): Promise<DriftReport> {
  await ensureMigrationsTable(db);
  const rows = (await db.execute(
    sql`SELECT id, hash, created_at FROM "drizzle"."__drizzle_migrations" ORDER BY id`,
  )) as unknown as {
    rows: Array<{ id: number; hash: string; created_at: number | null }>;
  };
  const dbRows = rows.rows ?? [];

  const embeddedHashes = new Set(EMBEDDED_MIGRATIONS.map((m) => m.hash));
  const dbHashes = new Set(dbRows.map((r) => r.hash));

  const unknown_in_db = dbRows
    .filter((r) => !embeddedHashes.has(r.hash))
    .map((r) => ({
      row_id: r.id,
      hash: r.hash,
      created_at: r.created_at,
    }));

  const missing_in_db = EMBEDDED_MIGRATIONS.filter((m) => !dbHashes.has(m.hash)).map((m) => ({
    idx: m.idx,
    tag: m.tag,
    hash: m.hash,
  }));

  return { unknown_in_db, missing_in_db };
}

/** Read-only accessor for tests + diagnostics. */
export function listEmbeddedMigrations(): readonly EmbeddedMigration[] {
  return EMBEDDED_MIGRATIONS;
}
