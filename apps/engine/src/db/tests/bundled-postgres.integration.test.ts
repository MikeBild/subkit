import { afterAll, describe, expect, test } from "bun:test";
import { type ChildProcess, spawn, spawnSync } from "node:child_process";
import { existsSync, mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import pg from "pg";
import { testEnv } from "../../test-helpers/determinism/env.ts";
import { waitFor } from "../../test-helpers/determinism/wait.ts";
import { createMigrationDbFromUrl } from "../client.ts";
import { listEmbeddedMigrations, runMigrations } from "../migrate.ts";

const bundle = testEnv.SUBKIT_BUNDLED_POSTGRES_DIR ?? "";
const available = bundle !== "" && existsSync(join(bundle, "bin", "postgres"));
const PASSWORD = "bundled-postgres-migration-test";

let server: ChildProcess | null = null;
let folder: string | null = null;

afterAll(() => {
  server?.kill("SIGINT");
  if (folder) rmSync(folder, { recursive: true, force: true });
});

describe.skipIf(!available)("the bundled PostgreSQL runs every engine migration", () => {
  test("initdb, start, migrate, pgcrypto and English full-text search", async () => {
    folder = mkdtempSync(join(tmpdir(), "skpg-"));
    const pgdata = join(folder, "data");
    const init = spawnSync(
      join(bundle, "bin", "initdb"),
      ["-D", pgdata, "-U", "subkit", "--pwfile=/dev/stdin", "-A", "scram-sha-256", "-E", "UTF8"],
      { input: PASSWORD, encoding: "utf8", env: { PATH: testEnv.PATH ?? "", LC_ALL: "C" } },
    );
    expect(init.status).toBe(0);
    server = spawn(
      join(bundle, "bin", "postgres"),
      ["-D", pgdata, "-k", folder, "-c", "listen_addresses=", "-c", "jit=off"],
      { stdio: "ignore", env: { PATH: testEnv.PATH ?? "", LC_ALL: "C" } },
    );
    const url = `postgres://subkit:${PASSWORD}@/postgres?host=${encodeURIComponent(folder)}`;
    await waitFor(
      async () => {
        const client = new pg.Client({ connectionString: url });
        try {
          await client.connect();
          return true;
        } catch {
          return false;
        } finally {
          await client.end().catch(() => {});
        }
      },
      { tries: 100, sleepMs: 100, label: "bundled postgres accepts connections" },
    );

    const migration = createMigrationDbFromUrl(url);
    try {
      await runMigrations(migration.db);
    } finally {
      await migration.pool.end();
    }

    const client = new pg.Client({ connectionString: url });
    await client.connect();
    try {
      const applied = await client.query<{ count: string }>(
        "select count(*) from subkit.__drizzle_migrations",
      );
      expect(Number(applied.rows[0]?.count)).toBe(listEmbeddedMigrations().length);
      const extensions = await client.query<{ extname: string }>(
        "select extname from pg_extension order by extname",
      );
      expect(extensions.rows.map((row) => row.extname)).toContain("pgcrypto");
      const search = await client.query<{ hit: boolean }>(
        "select to_tsvector('english'::regconfig, 'Invoices were running late') @@ plainto_tsquery('english', 'invoice run') as hit",
      );
      expect(search.rows[0]?.hit).toBe(true);
      const generated = await client.query<{ count: string }>(
        "select count(*) from information_schema.columns where column_name = 'tsv' and is_generated = 'ALWAYS'",
      );
      expect(Number(generated.rows[0]?.count)).toBeGreaterThanOrEqual(2);
    } finally {
      await client.end();
    }
  }, 120_000);
});
