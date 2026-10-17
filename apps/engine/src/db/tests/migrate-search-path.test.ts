import { expect, test } from "bun:test";
import { createMigrationDbFromUrl } from "../client.ts";
import { listEmbeddedMigrations, runMigrations } from "../migrate.ts";
import { createTestDb } from "./setup.ts";

test("migration transactions select the owned schema despite connection defaults", async () => {
  const context = await createTestDb("migration_search_path");
  const url = new URL(context.url);
  url.searchParams.set("options", "-c search_path=public,pg_catalog");
  const migration = createMigrationDbFromUrl(url.toString());
  try {
    const before = await migration.pool.query("SHOW search_path");
    expect(before.rows[0]?.search_path).toBe("public,pg_catalog");
    const report = await runMigrations(migration.db, [
      {
        idx: listEmbeddedMigrations().length,
        tag: "search_path_probe",
        when: 1,
        hash: "search-path-probe",
        statements: ["CREATE TABLE migration_scope_probe (id integer PRIMARY KEY)"],
      },
    ]);
    expect(report.applied).toBe(1);
    const tables = await migration.pool.query(
      "SELECT table_schema FROM information_schema.tables WHERE table_name = 'migration_scope_probe'",
    );
    expect(tables.rows).toEqual([{ table_schema: "subkit" }]);
  } finally {
    await migration.pool.end();
    await context.cleanup();
  }
}, 60_000);
