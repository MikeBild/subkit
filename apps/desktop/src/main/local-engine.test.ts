import { afterAll, describe, expect, test } from "bun:test";
import { existsSync } from "node:fs";
import { mkdtemp, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join, resolve } from "node:path";
import { SQL } from "bun";
import { targetFor } from "../shared/local/postgres-bundle.ts";
import { localLayout } from "../shared/local/supervisor-model.ts";
import { LocalEngine } from "./local-engine.ts";

const target = targetFor(process.platform, process.arch);
const postgresDir = resolve(import.meta.dir, `../../resources/postgres/${target}`);
const bundled = target !== null && existsSync(join(postgresDir, ".bundle.json"));
const PASSWORD = "local-engine-test-password";

let workspace: string | null = null;

afterAll(async () => {
  if (workspace) await rm(workspace, { recursive: true, force: true });
});

function query(engine: LocalEngine): SQL {
  const endpoint = engine.databaseEndpointInUse();
  if (endpoint?.kind !== "socket") throw new Error("expected a socket endpoint");
  return new SQL({
    path: join(endpoint.directory, ".s.PGSQL.5432"),
    username: "subkit",
    password: PASSWORD,
    database: "postgres",
    max: 1,
  });
}

describe.skipIf(!bundled || target?.startsWith("win32"))("bundled PostgreSQL", () => {
  test("initializes, starts on its socket, backs up, restores and stops", async () => {
    workspace = await mkdtemp(join(tmpdir(), "sk-local-"));
    const layout = localLayout(workspace, "default");
    const statuses: string[] = [];
    const engine = new LocalEngine({
      postgresDir,
      target: target ?? "darwin-arm64",
      engineCommand: [],
      appVersion: "11.3.0",
      layout,
      databasePassword: PASSWORD,
      masterKey: "0".repeat(64),
      preferredPort: null,
      onStatus: (state) => statuses.push(state.phase),
    });
    await engine.prepare();
    const started = performance.now();
    expect(await engine.initCluster()).toBe(true);
    expect(await engine.initCluster()).toBe(false);
    await engine.startDatabase();
    const coldStartMs = performance.now() - started;
    expect(coldStartMs).toBeLessThan(10_000);

    const sql = query(engine);
    const [settings] = await sql`select current_setting('shared_buffers') as buffers,
        current_setting('max_connections') as connections, current_setting('jit') as jit`;
    expect(settings).toEqual({ buffers: "64MB", connections: "50", jit: "off" });
    await sql`create extension if not exists pgcrypto`;
    const [crypto] = await sql`select encode(digest('a', 'sha256'), 'hex') as hash`;
    expect(crypto.hash).toBe("ca978112ca1bbdcafac231b39a23dc4da786eff8147c4e72b9807785afee48bb");
    await sql`create table notes (body text, tsv tsvector generated always as
        (to_tsvector('english'::regconfig, body)) stored)`;
    await sql`insert into notes (body) values ('Invoices were running late')`;
    const [match] = await sql`select count(*)::int as hits from notes
        where tsv @@ plainto_tsquery('english', 'invoice run')`;
    expect(match.hits).toBe(1);

    const name = await engine.backup("manual");
    expect(await engine.listBackups()).toEqual([name]);
    await sql`delete from notes`;
    await sql`insert into notes (body) values ('changed after the backup')`;
    await sql.close();
    expect(await engine.restore(name)).toBeNull();
    expect(
      (await engine.listBackups()).filter((backup) => backup.endsWith("-restore")),
    ).toHaveLength(1);
    const after = query(engine);
    const rows = await after`select body from notes`;
    expect(rows.map((row: { body: string }) => row.body)).toEqual(["Invoices were running late"]);
    await after.close();

    await engine.stop();
    expect(existsSync(join(layout.pgdata, "postmaster.pid"))).toBe(false);
    expect(statuses.at(-1)).toBe("stopped");
  }, 60_000);
});
