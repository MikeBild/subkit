import { afterAll, beforeAll, expect, test } from "bun:test";
import pg from "pg";
import { createDbFromUrl } from "../client.ts";
import { databaseConnectionSettings, databasePoolOptions } from "../connection-options.ts";
import { createTestDb, type TestDb } from "./setup.ts";

let context: TestDb;

beforeAll(async () => {
  context = await createTestDb("connection_sessions");
});

afterAll(async () => {
  await context?.cleanup();
});

test("every new application connection initializes the owned schema and statement deadline", async () => {
  const url = new URL(context.url);
  url.searchParams.set("options", "-c search_path=public,pg_catalog");
  const application = createDbFromUrl(url.toString());
  try {
    const clients = await Promise.all([
      application.pool.connect(),
      application.pool.connect(),
      application.pool.connect(),
    ]);
    try {
      for (const client of clients) {
        const result = await client.query(
          "SELECT current_schema() AS schema, setting FROM pg_settings WHERE name = 'statement_timeout'",
        );
        expect(result.rows).toEqual([{ schema: "subkit", setting: "120000" }]);
      }
    } finally {
      for (const client of clients) client.release(true);
    }
    const replacement = await application.pool.query("SELECT current_schema() AS schema");
    expect(replacement.rows).toEqual([{ schema: "subkit" }]);
  } finally {
    await application.pool.end();
  }
});

test("pool acquisition and PostgreSQL statements have bounded deadlines", async () => {
  const pool = new pg.Pool(
    databasePoolOptions(context.url, {
      ...databaseConnectionSettings(),
      pool_max: 1,
      connect_timeout_ms: 100,
      query_timeout_ms: 2_000,
      statement_timeout_ms: 100,
    }),
  );
  try {
    const held = await pool.connect();
    try {
      await expect(pool.connect()).rejects.toThrow(/timeout/i);
    } finally {
      held.release();
    }
    await expect(pool.query("SELECT pg_sleep(1)")).rejects.toMatchObject({ code: "57014" });
    const recovered = await pool.query("SELECT 1 AS value");
    expect(recovered.rows).toEqual([{ value: 1 }]);
  } finally {
    await pool.end();
  }
});
