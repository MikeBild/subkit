// Standalone migration runner. Invoked by `bun run db:migrate`. Reads the
// migration bundle produced by `drizzle-kit generate` at
// apps/engine/src/db/migrations and applies it to the target database.

import path from "node:path";
import { fileURLToPath } from "node:url";
import { migrate } from "drizzle-orm/node-postgres/migrator";
import { env } from "../env.ts";
import { logger } from "../logging/logger.ts";
import { createDbFromUrl } from "./client.ts";

const HERE = path.dirname(fileURLToPath(import.meta.url));
const MIGRATIONS_FOLDER = path.join(HERE, "migrations");

export async function runMigrations(url: string = env.DATABASE_URL): Promise<void> {
  logger.info({
    module: "db",
    action: "migrate.started",
    msg: "applying migrations",
    migrations_folder: MIGRATIONS_FOLDER,
  });

  const { pool, db } = createDbFromUrl(url);
  try {
    // Ensure pgcrypto is available for gen_random_uuid() defaults. Drizzle
    // does not emit this automatically when we use `.defaultRandom()`.
    await pool.query('CREATE EXTENSION IF NOT EXISTS "pgcrypto"');
    await migrate(db, { migrationsFolder: MIGRATIONS_FOLDER });
    logger.info({
      module: "db",
      action: "migrate.applied",
      msg: "migrations applied successfully",
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
