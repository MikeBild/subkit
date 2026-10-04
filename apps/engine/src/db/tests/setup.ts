import { setDefaultTimeout } from "bun:test";
import { randomBytes } from "node:crypto";
import { drizzle, type NodePgDatabase } from "drizzle-orm/node-postgres";
import pg from "pg";
import { seedBuiltinRolesAndPermissions } from "../../rbac/seed.ts";
import { createMigrationDbFromUrl } from "../client.ts";
import { runMigrations } from "../migrate.ts";
import { EMBEDDED_MIGRATIONS } from "../migrations/embedded.ts";
import * as schema from "../schema/index.ts";

const { Client, Pool } = pg;

export const TEST_DB_HOOK_TIMEOUT = 120_000;
setDefaultTimeout(TEST_DB_HOOK_TIMEOUT);

let _preflightPromise: Promise<void> | null = null;
async function preflightPostgres(adminUrl: string): Promise<void> {
  const probe = new Client({
    connectionString: adminUrl,
    connectionTimeoutMillis: 2_000,
  });
  try {
    await probe.connect();
  } catch (err) {
    const cause = err instanceof Error ? err.message : String(err);
    throw new Error(
      `PostgreSQL is not reachable at ${adminUrl.replace(/\/\/[^@]*@/, "//<credentials>@")} — ` +
        `database-backed tests need it. Run \`bun run compose:up\` first, ` +
        `or point DATABASE_URL at a running server.` +
        (cause ? ` (probe error: ${cause})` : ""),
    );
  } finally {
    await probe.end().catch(() => {});
  }
}
function ensurePreflight(adminUrl: string): Promise<void> {
  if (!_preflightPromise) _preflightPromise = preflightPostgres(adminUrl);
  return _preflightPromise;
}

let _orphanSweepPromise: Promise<void> | null = null;
export function owningPidFromTestDbName(datname: string): number | null {
  const parts = datname.split("_");
  if (parts.length < 4) return null;
  const candidate = parts[parts.length - 2] ?? "";
  if (!/^\d+$/.test(candidate)) return null;
  const pid = Number(candidate);
  return Number.isSafeInteger(pid) && pid > 0 ? pid : null;
}

export function isPidAlive(pid: number): boolean {
  try {
    process.kill(pid, 0);
    return true;
  } catch (err) {
    return (err as NodeJS.ErrnoException).code === "EPERM";
  }
}

async function sweepOrphanTestDatabases(adminUrl: string): Promise<void> {
  const admin = new Client({ connectionString: adminUrl });
  await admin.connect();
  try {
    const { rows } = await admin.query<{ datname: string }>(
      `SELECT datname FROM pg_database
        WHERE datname LIKE 'test\\_%' ESCAPE '\\'
          AND NOT EXISTS (
            SELECT 1 FROM pg_stat_activity WHERE pg_stat_activity.datname = pg_database.datname
          )`,
    );
    for (const { datname } of rows) {
      const pid = owningPidFromTestDbName(datname);
      if (pid !== null && isPidAlive(pid)) continue;
      await admin.query(`DROP DATABASE IF EXISTS "${datname}"`).catch(() => {});
    }
  } finally {
    await admin.end().catch(() => {});
  }
}
function ensureOrphanSweep(adminUrl: string): Promise<void> {
  if (!_orphanSweepPromise) _orphanSweepPromise = sweepOrphanTestDatabases(adminUrl);
  return _orphanSweepPromise;
}

function getAdminUrl(): string {
  return process.env.DATABASE_URL ?? "postgres://subkit:subkit@localhost:5432/subkit";
}

function rewriteDbName(url: string, newName: string): string {
  const parsed = new URL(url);
  parsed.pathname = `/${newName}`;
  return parsed.toString();
}

export interface CreateTestDbOptions {
  upToIdx?: number;
}

export type TestDb = {
  dbName: string;
  url: string;
  pool: pg.Pool;
  db: NodePgDatabase<typeof schema>;
  cleanup: () => Promise<void>;
};

export async function createTestDb(
  label: string,
  options: CreateTestDbOptions = {},
): Promise<TestDb> {
  const rand = randomBytes(6).toString("hex");
  const dbName = `test_${label}_${process.pid}_${rand}`.toLowerCase().replace(/[^a-z0-9_]/g, "_");

  const adminUrl = getAdminUrl();
  await ensurePreflight(adminUrl);
  await ensureOrphanSweep(adminUrl);
  const admin = new Client({ connectionString: adminUrl });
  await admin.connect();
  try {
    await admin.query(`DROP DATABASE IF EXISTS "${dbName}"`);
    await admin.query(`CREATE DATABASE "${dbName}"`);
  } finally {
    await admin.end();
  }

  const url = rewriteDbName(adminUrl, dbName);
  const upToIdx = options.upToIdx;
  const migration = createMigrationDbFromUrl(url);
  try {
    await runMigrations(
      migration.db,
      upToIdx === undefined
        ? EMBEDDED_MIGRATIONS
        : EMBEDDED_MIGRATIONS.filter((m) => m.idx <= upToIdx),
      true,
    );
  } finally {
    await migration.pool.end();
  }

  const pool = new Pool({
    connectionString: url,
    options: "-c search_path=subkit,pg_catalog,public",
  });
  pool.on("error", () => {});

  const db = drizzle(pool, { schema });

  await seedBuiltinRolesAndPermissions(db);

  const cleanup = async () => {
    const admin2 = new Client({ connectionString: getAdminUrl() });
    await admin2.connect();
    try {
      await admin2.query(
        "SELECT pg_terminate_backend(pid) FROM pg_stat_activity WHERE datname = $1 AND pid <> pg_backend_pid()",
        [dbName],
      );
      const internalPool = pool as pg.Pool & {
        _clients?: pg.PoolClient[];
        _remove?: (client: pg.PoolClient, callback?: () => void) => void;
      };
      const endPromise = pool.end().catch(() => {});
      const endedNormally = await Promise.race([
        endPromise.then(() => true),
        new Promise<false>((resolve) => setTimeout(() => resolve(false), 250)),
      ]);
      if (!endedNormally && internalPool._clients && internalPool._remove) {
        for (const client of [...internalPool._clients]) internalPool._remove(client);
        await endPromise;
      }
      await admin2.query(`DROP DATABASE IF EXISTS "${dbName}"`);
    } finally {
      await admin2.end();
    }
  };

  return { dbName, url, pool, db, cleanup };
}
