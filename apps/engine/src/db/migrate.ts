// Standalone migration runner. Invoked by `bun run db:migrate`. Reads the
// migration bundle produced by `drizzle-kit generate` at
// apps/engine/src/db/migrations and applies it to the target database.
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
// already in the table?") instead of a timestamp watermark. That's the
// semantics everyone expects from a migration runner anyway.

import { createHash } from "node:crypto";
import fs from "node:fs";
import path from "node:path";
import { fileURLToPath } from "node:url";
import { sql } from "drizzle-orm";
import { logger } from "../logging/logger.ts";
import { createDbFromUrl, type Db } from "./client.ts";

// Migrate runs as a standalone binary (`bun run apps/engine/src/db/migrate.ts`)
// without going through loadConfig — it would be circular to require a config
// file just to migrate the database the config file may eventually live in.
function bootstrapDatabaseUrl(): string {
  const url = process.env.DATABASE_URL;
  if (!url) {
    throw new Error("DATABASE_URL is required for `db:migrate`");
  }
  return url;
}

const HERE = path.dirname(fileURLToPath(import.meta.url));
const MIGRATIONS_FOLDER = path.join(HERE, "migrations");

interface Migration {
  idx: number;
  tag: string;
  when: number;
  hash: string;
  statements: string[];
}

function readMigrations(folder: string): Migration[] {
  const journalPath = path.join(folder, "meta", "_journal.json");
  if (!fs.existsSync(journalPath)) {
    throw new Error(`Can't find meta/_journal.json at ${journalPath}`);
  }
  const journal = JSON.parse(fs.readFileSync(journalPath, "utf8")) as {
    entries: Array<{ idx: number; tag: string; when: number; breakpoints?: boolean }>;
  };
  // Apply in journal order (idx-ascending) regardless of `when` values —
  // `when` only informs the row `created_at` we write, never the order.
  const entries = [...journal.entries].sort((a, b) => a.idx - b.idx);
  return entries.map((e) => {
    const sqlPath = path.join(folder, `${e.tag}.sql`);
    const raw = fs.readFileSync(sqlPath, "utf8");
    const statements = raw
      .split("--> statement-breakpoint")
      .map((s) => s.trim())
      .filter((s) => s.length > 0);
    const hash = createHash("sha256").update(raw).digest("hex");
    return { idx: e.idx, tag: e.tag, when: e.when, hash, statements };
  });
}

async function ensureMigrationsTable(db: Db): Promise<void> {
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

async function readAppliedState(db: Db): Promise<AppliedState> {
  const rows = (await db.execute(
    sql`SELECT hash FROM "drizzle"."__drizzle_migrations"`,
  )) as unknown as { rows: Array<{ hash: string }> };
  const hashes = new Set((rows.rows ?? []).map((r) => r.hash));
  return { hashes, count: hashes.size };
}

export async function runMigrations(url: string = bootstrapDatabaseUrl()): Promise<void> {
  logger.info({
    module: "db",
    action: "migrate.started",
    msg: "applying migrations",
    migrations_folder: MIGRATIONS_FOLDER,
  });

  const { pool, db } = createDbFromUrl(url);
  try {
    // pgcrypto is required for `gen_random_uuid()` defaults. Drizzle
    // does not emit this automatically when schemas use `.defaultRandom()`.
    await pool.query('CREATE EXTENSION IF NOT EXISTS "pgcrypto"');

    const migrations = readMigrations(MIGRATIONS_FOLDER);
    await ensureMigrationsTable(db);
    const applied = await readAppliedState(db);

    let appliedCount = 0;
    let skippedCount = 0;
    let hashDriftCount = 0;
    for (const m of migrations) {
      if (applied.hashes.has(m.hash)) {
        skippedCount++;
        continue;
      }
      // Positional fallback: the drizzle.__drizzle_migrations table's
      // SERIAL id increments in journal-idx order, so if `count` already
      // covers this migration's idx, it was applied under a different
      // file hash (someone edited the .sql after it was applied).
      // Treat as applied but backfill the current hash so subsequent
      // runs see hash parity.
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
      await db.transaction(async (tx) => {
        for (const stmt of m.statements) {
          await tx.execute(sql.raw(stmt));
        }
        await tx.execute(
          sql`INSERT INTO "drizzle"."__drizzle_migrations" ("hash", "created_at") VALUES (${m.hash}, ${m.when})`,
        );
      });
      applied.hashes.add(m.hash);
      applied.count += 1;
      appliedCount++;
    }

    logger.info({
      module: "db",
      action: "migrate.applied",
      msg: "migrations applied successfully",
      applied: appliedCount,
      skipped: skippedCount,
      hash_drift_backfilled: hashDriftCount,
      total: migrations.length,
    });
  } catch (err) {
    logger.error({
      module: "db",
      action: "migrate.failed",
      msg: "migration failed",
      error: err instanceof Error ? err.message : String(err),
      stack: err instanceof Error ? err.stack : undefined,
    });
    throw err;
  } finally {
    await pool.end();
  }
}

// Entrypoint when run as a script.
if (import.meta.main) {
  runMigrations().catch((err) => {
    logger.fatal({
      module: "db",
      action: "migrate.crashed",
      msg: "migrate script crashed",
      error: err instanceof Error ? err.message : String(err),
    });
    process.exit(1);
  });
}
