import { afterAll, afterEach, beforeAll, describe, expect, spyOn, test } from "bun:test";
import { sql } from "drizzle-orm";
import { getContext, withContext } from "../logging/context.ts";
import { logger } from "../logging/logger.ts";
import { createDbFromUrl } from "./client.ts";
import { createTestDb, TEST_DB_HOOK_TIMEOUT, type TestDb } from "./tests/setup.ts";

let fixture: TestDb;
let database: ReturnType<typeof createDbFromUrl>;
const priorDiagnostics = process.env.SUBKIT_DIAGNOSTICS;

beforeAll(async () => {
  process.env.SUBKIT_DIAGNOSTICS = "1";
  fixture = await createTestDb("client_diagnostics");
  database = createDbFromUrl(fixture.url);
}, TEST_DB_HOOK_TIMEOUT);

afterEach(() => {
  if (priorDiagnostics === undefined) delete process.env.SUBKIT_DIAGNOSTICS;
  else process.env.SUBKIT_DIAGNOSTICS = priorDiagnostics;
  process.env.SUBKIT_DIAGNOSTICS = "1";
});

afterAll(async () => {
  await database?.pool.end();
  await fixture?.cleanup();
  if (priorDiagnostics === undefined) delete process.env.SUBKIT_DIAGNOSTICS;
  else process.env.SUBKIT_DIAGNOSTICS = priorDiagnostics;
}, TEST_DB_HOOK_TIMEOUT);

describe("instrumented createDbFromUrl", () => {
  test("preserves transaction return and rejection while correlating two query timings", async () => {
    const info = spyOn(logger, "info").mockImplementation(() => {});
    const trace_id = "diagnostic-tx-trace";
    const captured: Array<Record<string, unknown>> = [];
    info.mockImplementation((fields) => {
      captured.push({ ...getContext(), ...fields });
    });
    try {
      const value = await withContext({ trace_id }, () =>
        database.db.transaction(async (tx) => {
          await tx.execute(sql`SELECT 1`);
          await tx.execute(sql`SELECT 2`);
          return "transaction-value";
        }),
      );
      expect(value).toBe("transaction-value");

      const events = captured;
      const transaction = events.find((event) => event.action === "db.transaction.completed");
      expect(transaction).toMatchObject({ trace_id, module: "diagnostics" });
      expect(typeof transaction?.db_tx_id).toBe("string");
      const txId = transaction?.db_tx_id;
      const queries = events.filter(
        (event) => event.action === "db.query.completed" && event.db_tx_id === txId,
      );
      expect(queries.length).toBeGreaterThanOrEqual(2);
      expect(typeof queries.at(-1)?.interquery_gap_ms).toBe("number");
      for (const event of events) {
        expect("sql" in event).toBe(false);
        expect("params" in event).toBe(false);
        expect("error" in event).toBe(false);
      }

      await expect(
        database.db.transaction(async (tx) => {
          await tx.execute(sql`CREATE TABLE subkit.diagnostic_tx_probe (id integer PRIMARY KEY)`);
          await tx.execute(sql`INSERT INTO subkit.diagnostic_tx_probe (id) VALUES (1)`);
          await tx.execute(sql`SELECT 3`);
          throw new Error("rollback sentinel");
        }),
      ).rejects.toThrow("rollback sentinel");
      const rollbackCheck = await database.db.execute<{
        table_name: string | null;
      }>(sql`SELECT to_regclass('subkit.diagnostic_tx_probe') AS table_name`);
      expect(rollbackCheck.rows[0]?.table_name).toBeNull();
    } finally {
      info.mockRestore();
    }
  });
});
