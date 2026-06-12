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
import { logger } from "../logging/logger.ts";
import type { Db } from "./client.ts";
import { EMBEDDED_MIGRATIONS, type EmbeddedMigration } from "./migrations/embedded.ts";
import { runItemvarBackfill } from "./migrations/itemvar-backfill.ts";

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
 * locked together (review W3).
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
   *  different binary lineage — actionable signal for #149. */
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
}

interface AppliedState {
  hashes: Set<string>;
  /**
   * Count of applied migrations — used as a positional fallback for
   * migrations whose file was edited after they were applied (hash no
   * longer matches). The drizzle table's `id` is a SERIAL that
   * increments in journal-idx order, so the Nth-inserted row
   * corresponds to journal idx `N-1`.
   */
  count: number;
}

async function readAppliedHashes(db: Db): Promise<AppliedState> {
  const rows = (await db.execute(
    sql`SELECT hash FROM "drizzle"."__drizzle_migrations"`,
  )) as unknown as { rows: Array<{ hash: string }> };
  const hashes = new Set((rows.rows ?? []).map((r) => r.hash));
  return { hashes, count: hashes.size };
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
    if (applied.hashes.has(m.hash)) {
      skippedCount++;
      continue;
    }
    // Positional fallback: the drizzle.__drizzle_migrations table's
    // SERIAL id increments in journal-idx order, so if `count` already
    // covers this migration's idx, it was applied under a different
    // file hash (someone edited the .sql after it was applied). Treat
    // as applied but backfill the current hash so subsequent runs see
    // hash parity.
    if (applied.count > m.idx) {
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
        sql`UPDATE "drizzle"."__drizzle_migrations" SET hash = ${m.hash} WHERE id = ${m.idx + 1}`,
      );
      applied.hashes.add(m.hash);
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
        sql`INSERT INTO "drizzle"."__drizzle_migrations" ("hash", "created_at") VALUES (${m.hash}, ${m.when})`,
      );
    });
    applied.hashes.add(m.hash);
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
      error: err instanceof Error ? err.message : String(err),
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
 * a binary lineage this engine doesn't recognise. That is the #149
 * symptom: prod had 27 such rows and three subsystems failed because
 * the schema state didn't match the engine's expectations. Operators
 * should treat this as a deploy-time alarm.
 *
 * Side effect (review R2-S5): the function calls `ensureMigrationsTable`
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
