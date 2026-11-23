import { afterAll, beforeAll, describe, expect, test } from "bun:test";
import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { and, eq } from "drizzle-orm";
import { _resetConfigForTests, loadConfig, setConfigKey } from "../../config/loader.ts";
import { closeAllPools } from "../../connectors/drivers/postgres.ts";
import { connectors, executionSteps, executions } from "../../db/schema/index.ts";
import { runExecution } from "../engine.ts";
import {
  createEngineCtx,
  createMockServer,
  createWorkflowRow,
  type EngineTestCtx,
  jsonResponse,
  type MockServer,
} from "./setup.ts";

let ctx: EngineTestCtx;
let storage: MockServer;
let configDir: string;
let pgConnectorId: string;
let s3ConnectorId: string;
const storageHits: Array<{ method: string; stamped: boolean }> = [];

const BUMP_ATTEMPT =
  "UPDATE subkit.executions SET attempt = attempt + 1 WHERE id = (SELECT execution_id FROM subkit.execution_steps WHERE step_key = 'bump' AND status = 'running' LIMIT 1)";

async function stampedRunningRows(): Promise<number> {
  const rows = await ctx.testDb.pool.query(
    "SELECT count(*)::int AS n FROM subkit.execution_steps WHERE status = 'running' AND write_dispatched_at IS NOT NULL AND step_key = 'put'",
  );
  return rows.rows[0]?.n ?? 0;
}

beforeAll(async () => {
  ctx = await createEngineCtx("write-stamp");
  configDir = mkdtempSync(join(tmpdir(), "subkit-write-stamp-"));
  _resetConfigForTests();
  await loadConfig({
    env: { NODE_ENV: "test", DATABASE_URL: ctx.testDb.url },
    configPathOverride: join(configDir, "subkit.config.json"),
  });
  await setConfigKey("egress.provider_hosts_extra", ["127.0.0.1"], { force: true });
  storage = await createMockServer(async (req, res) => {
    storageHits.push({ method: req.method ?? "", stamped: (await stampedRunningRows()) === 1 });
    jsonResponse(res, 200, {});
  });
  const [pg] = await ctx.testDb.db
    .insert(connectors)
    .values({
      tenant_id: ctx.tenantId,
      slug: "stamp-pg",
      display_name: "Stamp PG",
      driver: "postgres",
      environment: "dev",
      auth_type: "none",
      base_url: ctx.testDb.url,
      dsn: ctx.testDb.url,
      config: {},
    })
    .returning();
  const [s3] = await ctx.testDb.db
    .insert(connectors)
    .values({
      tenant_id: ctx.tenantId,
      slug: "stamp-store",
      display_name: "Stamp Store",
      driver: "s3",
      auth_type: "none",
      environment: "dev",
      config: {
        endpoint: storage.baseUrl,
        region: "us-east-1",
        bucket: "stamp-bucket",
        force_path_style: true,
      },
    })
    .returning();
  if (!pg || !s3) throw new Error("connector fixture missing");
  pgConnectorId = pg.id;
  s3ConnectorId = s3.id;
  await ctx.testDb.pool.query(
    "CREATE TABLE IF NOT EXISTS public.write_stamp_seen (label text PRIMARY KEY, stamped int NOT NULL)",
  );
});

afterAll(async () => {
  await closeAllPools();
  await storage?.close();
  await ctx?.cleanup();
  _resetConfigForTests();
  rmSync(configDir, { recursive: true, force: true });
});

async function run(slug: string, steps: unknown[]) {
  const { workflow_id } = await createWorkflowRow(ctx, { name: slug, slug, steps });
  return runExecution({
    db: ctx.testDb.db,
    tenant_id: ctx.tenantId,
    source: { kind: "saved", workflow_id },
    input: null,
  });
}

async function stepRow(execution_id: string, step_key: string) {
  const [row] = await ctx.testDb.db
    .select()
    .from(executionSteps)
    .where(
      and(
        eq(executionSteps.tenant_id, ctx.tenantId),
        eq(executionSteps.execution_id, execution_id),
        eq(executionSteps.step_key, step_key),
      ),
    );
  return row;
}

function sql(id: string, method: string, query: string) {
  return {
    id,
    kind: "request",
    protocol: "sql",
    method,
    connector_id: pgConnectorId,
    sql: { query },
  };
}

describe("a write step marks its dispatch before it is sent", () => {
  test("postgres: the statement already sees its own mark", async () => {
    const result = await run("stamp-sql", [
      sql(
        "insert",
        "INSERT",
        "INSERT INTO public.write_stamp_seen (label, stamped) SELECT 'sql', count(*) FROM subkit.execution_steps WHERE step_key = 'insert' AND status = 'running' AND write_dispatched_at IS NOT NULL",
      ),
    ]);
    expect(result.status).toBe("succeeded");
    const seen = await ctx.testDb.pool.query(
      "SELECT stamped FROM public.write_stamp_seen WHERE label = 'sql'",
    );
    expect(seen.rows[0]?.stamped).toBe(1);
    expect((await stepRow(result.execution_id, "insert"))?.write_dispatched_at).not.toBeNull();
  });

  test("postgres: a read is not marked", async () => {
    const result = await run("stamp-sql-read", [
      sql("read", "SELECT", "SELECT label FROM public.write_stamp_seen"),
    ]);
    expect(result.status).toBe("succeeded");
    expect((await stepRow(result.execution_id, "read"))?.write_dispatched_at).toBeNull();
  });

  test("postgres: a copy whose run was taken over sends no statement", async () => {
    const result = await run("stamp-sql-fenced", [
      sql("bump", "UPDATE", BUMP_ATTEMPT),
      sql(
        "insert",
        "INSERT",
        "INSERT INTO public.write_stamp_seen (label, stamped) VALUES ('fenced', 1)",
      ),
    ]);
    expect(result.error?.code).toBe("execution_superseded");
    const seen = await ctx.testDb.pool.query(
      "SELECT stamped FROM public.write_stamp_seen WHERE label = 'fenced'",
    );
    expect(seen.rows).toEqual([]);
    const [row] = await ctx.testDb.db
      .select({ status: executions.status, attempt: executions.attempt })
      .from(executions)
      .where(and(eq(executions.tenant_id, ctx.tenantId), eq(executions.id, result.execution_id)));
    expect(row).toEqual({ status: "running", attempt: 1 });
  });

  test("s3 without a scope: the upload is marked before the storage sees it", async () => {
    storageHits.length = 0;
    const result = await run("stamp-s3", [
      {
        id: "put",
        kind: "request",
        protocol: "s3",
        connector_id: s3ConnectorId,
        method: "PUT",
        body: { hello: "world" },
        s3: { key: "notes/one.json", content_type: "application/json" },
      },
    ]);
    expect(result.status).toBe("succeeded");
    expect(storageHits).toEqual([{ method: "PUT", stamped: true }]);
  });

  test("s3 without a scope: a copy whose run was taken over uploads nothing", async () => {
    storageHits.length = 0;
    const result = await run("stamp-s3-fenced", [
      sql("bump", "UPDATE", BUMP_ATTEMPT),
      {
        id: "put",
        kind: "request",
        protocol: "s3",
        connector_id: s3ConnectorId,
        method: "PUT",
        body: { hello: "world" },
        s3: { key: "notes/two.json", content_type: "application/json" },
      },
    ]);
    expect(result.error?.code).toBe("execution_superseded");
    expect(storageHits).toEqual([]);
  });
});
