import { afterAll, beforeAll, expect, test } from "bun:test";
import { auditLog } from "../../db/schema/index.ts";
import { createHttpTestServer, type HttpTestServer } from "../../http/tests/setup.ts";
import { seedMcpConnector } from "../../mcp/client/test-fixtures.ts";
import { getTestNow } from "../../test-helpers/determinism/clock.ts";
import { waitFor } from "../../test-helpers/determinism/wait.ts";
import { seedTenant } from "../../test-helpers/seed.ts";
import { runMcpOAuthCleanup } from "../mcp-oauth-cleanup-runner.ts";

let srv: HttpTestServer;
let connectorId: string;
let neighbor: string;

beforeAll(async () => {
  srv = await createHttpTestServer("oauth-cleanup-bounds");
  connectorId = (
    await seedMcpConnector(srv.db, {
      tenant_id: srv.tenantId,
      slug: "cleanup-bounds",
      url: "https://connector.example/mcp",
    })
  ).id;
  const row = await seedTenant(srv.db, {
    slug: "oauth-retention-neighbor",
    display_name: "Neighbor",
  });
  neighbor = row.id;
});
afterAll(async () => {
  await srv?.cleanup();
});

async function reset() {
  await srv.testDb.pool.query(
    "DELETE FROM subkit.mcp_oauth_access_tokens; UPDATE subkit.mcp_oauth_refresh_tokens SET rotated_to_id=NULL; DELETE FROM subkit.mcp_oauth_refresh_tokens; DELETE FROM subkit.mcp_oauth_authorization_codes; DELETE FROM subkit.mcp_oauth_clients; DELETE FROM subkit.mcp_oauth_states; DELETE FROM subkit.connector_oauth_start_grants; DELETE FROM subkit.connector_oauth_states",
  );
  await srv.db.delete(auditLog);
}

const tables = [
  "mcp_oauth_access_tokens",
  "mcp_oauth_refresh_tokens",
  "mcp_oauth_authorization_codes",
  "mcp_oauth_clients",
  "mcp_oauth_states",
  "connector_oauth_start_grants",
  "connector_oauth_states",
];
async function count(table: string) {
  const r = await srv.testDb.pool.query(`SELECT count(*)::int n FROM subkit.${table}`);
  return r.rows[0].n as number;
}
async function seedCodes(n: number) {
  await srv.testDb.pool.query(
    "INSERT INTO subkit.mcp_oauth_authorization_codes(tenant_id,client_id,user_id,code_sha256,code_challenge,code_challenge_method,redirect_uri,scope,expires_at) SELECT $1,'batch-client',$2,'code-'||g,'challenge','S256','https://client.example/callback','mcp:read',now()-interval '2 days' FROM generate_series(1,$3::int)g",
    [srv.tenantId, srv.userId, n],
  );
}

test("all eight units make bounded repeated progress across more than two pages", async () => {
  await reset();
  const n = 513;
  for (const table of ["mcp_oauth_access_tokens", "mcp_oauth_refresh_tokens"]) {
    await srv.testDb.pool.query(
      `INSERT INTO subkit.${table}(tenant_id,client_id,user_id,prefix,token_sha256,scope,expires_at) SELECT $1,'proof-client',$2,'prefix','token-'||g,'mcp:read',now()-interval '8 days' FROM generate_series(1,$3::int)g`,
      [srv.tenantId, srv.userId, n],
    );
  }
  await seedCodes(n);
  await srv.testDb.pool.query(
    "INSERT INTO subkit.mcp_oauth_clients(client_id,created_at) SELECT 'delete-'||g,now()-interval '31 days' FROM generate_series(1,$1::int)g;",
    [n],
  );
  await srv.testDb.pool.query(
    "INSERT INTO subkit.mcp_oauth_clients(client_id,created_at) SELECT 'retire-'||g,now()-interval '10 days' FROM generate_series(1,$1::int)g;",
    [n],
  );
  for (const table of ["mcp_oauth_states", "connector_oauth_states"]) {
    await srv.testDb.pool.query(
      `INSERT INTO subkit.${table}(tenant_id,connector_id,state,code_verifier,redirect_uri,expires_at) SELECT $1,$2,'state-'||g,'verifier','https://client.example/callback',now()-interval '1 second' FROM generate_series(1,$3::int)g`,
      [srv.tenantId, connectorId, n],
    );
  }
  await srv.testDb.pool.query(
    "INSERT INTO subkit.connector_oauth_start_grants(tenant_id,connector_id,token_sha256,expires_at) SELECT $1,$2,'grant-'||g,now()-interval '1 second' FROM generate_series(1,$3::int)g",
    [srv.tenantId, connectorId, n],
  );
  for (let tick = 0; tick < 5; tick++) {
    const before = await Promise.all(tables.map(count));
    await runMcpOAuthCleanup(new Date(getTestNow()), srv.db);
    const after = await Promise.all(tables.map(count));
    for (let i = 0; i < tables.length; i++) {
      const previous = before[i];
      const current = after[i];
      if (previous === undefined || current === undefined)
        throw new Error("cleanup_count_fixture_missing");
      expect(previous - current).toBeGreaterThanOrEqual(0);
      expect(previous - current).toBeLessThanOrEqual(256);
    }
  }
  for (const table of tables.filter((t) => t !== "mcp_oauth_clients"))
    expect(await count(table)).toBe(0);
  const clients = await srv.testDb.pool.query(
    "SELECT count(*)::int n FROM subkit.mcp_oauth_clients WHERE disabled_at IS NULL OR retired_at IS NULL",
  );
  expect(clients.rows[0].n).toBe(0);
  const audits = await srv.db.select().from(auditLog);
  expect(audits.length).toBeGreaterThan(0);
  for (const row of audits) {
    expect(JSON.stringify(row.metadata)).not.toContain("client_names");
    expect(JSON.stringify(row.metadata)).not.toContain('"ids"');
  }
});

test("locked keys are skipped and a later tick visits them without deleting fresh foreign rows", async () => {
  await reset();
  await seedCodes(3);
  await srv.testDb.pool.query(
    "INSERT INTO subkit.mcp_oauth_authorization_codes(tenant_id,client_id,user_id,code_sha256,code_challenge,code_challenge_method,redirect_uri,scope,expires_at) VALUES($1,'neighbor',$2,'foreign','challenge','S256','https://client.example/callback','mcp:read',now()+interval '1 hour')",
    [neighbor, srv.userId],
  );
  const client = await srv.testDb.pool.connect();
  try {
    await client.query("BEGIN");
    const locked = await client.query(
      "SELECT id FROM subkit.mcp_oauth_authorization_codes WHERE tenant_id=$1 ORDER BY id LIMIT 1 FOR UPDATE",
      [srv.tenantId],
    );
    await runMcpOAuthCleanup(new Date(getTestNow()), srv.db);
    expect(await count("mcp_oauth_authorization_codes")).toBe(2);
    await client.query("COMMIT");
    await runMcpOAuthCleanup(new Date(getTestNow()), srv.db);
    const remaining = await srv.testDb.pool.query(
      "SELECT id,tenant_id FROM subkit.mcp_oauth_authorization_codes",
    );
    expect(remaining.rows).toHaveLength(1);
    expect(remaining.rows[0].tenant_id).toBe(neighbor);
    expect(remaining.rows[0].id).not.toBe(locked.rows[0].id);
  } finally {
    await client.query("ROLLBACK");
    client.release();
  }
});

test("mandatory audit failure rolls back each changed unit and retirement", async () => {
  await reset();
  await seedCodes(1);
  await srv.testDb.pool.query(
    "INSERT INTO subkit.mcp_oauth_clients(client_id,created_at) VALUES('rollback-retire',now()-interval '10 days')",
  );
  const parent = await srv.testDb.pool.query(
    "INSERT INTO subkit.mcp_oauth_refresh_tokens(tenant_id,client_id,user_id,prefix,token_sha256,scope,expires_at) VALUES($1,'rollback-refresh',$2,'prefix','rollback-refresh','mcp:read',now()-interval '8 days') RETURNING id",
    [srv.tenantId, srv.userId],
  );
  await srv.testDb.pool.query(
    "INSERT INTO subkit.mcp_oauth_access_tokens(tenant_id,client_id,user_id,prefix,token_sha256,scope,expires_at,refresh_token_id) VALUES($1,'rollback-refresh',$2,'prefix','rollback-access','mcp:read',now()+interval '1 day',$3)",
    [srv.tenantId, srv.userId, parent.rows[0].id],
  );
  await srv.testDb.pool.query(
    "CREATE FUNCTION subkit.test_oauth_audit_failure() RETURNS trigger LANGUAGE plpgsql AS $$ BEGIN IF NEW.action IN ('mcp_oauth.expired_pruned','mcp_oauth.client_retired') THEN RAISE EXCEPTION 'synthetic_audit_failure'; END IF; RETURN NEW; END $$; CREATE TRIGGER test_oauth_audit_failure BEFORE INSERT ON subkit.audit_log FOR EACH ROW EXECUTE FUNCTION subkit.test_oauth_audit_failure()",
  );
  try {
    await runMcpOAuthCleanup(new Date(getTestNow()), srv.db);
    expect(await count("mcp_oauth_authorization_codes")).toBe(1);
    expect(await count("mcp_oauth_refresh_tokens")).toBe(1);
    const access = await srv.testDb.pool.query(
      "SELECT refresh_token_id FROM subkit.mcp_oauth_access_tokens WHERE token_sha256='rollback-access'",
    );
    expect(access.rows[0].refresh_token_id).toBe(parent.rows[0].id);
    const client = await srv.testDb.pool.query(
      "SELECT disabled_at,retired_at FROM subkit.mcp_oauth_clients WHERE client_id='rollback-retire'",
    );
    expect(client.rows[0]).toEqual({ disabled_at: null, retired_at: null });
    expect(await srv.db.select().from(auditLog)).toHaveLength(0);
  } finally {
    await srv.testDb.pool.query(
      "DROP TRIGGER test_oauth_audit_failure ON subkit.audit_log; DROP FUNCTION subkit.test_oauth_audit_failure()",
    );
  }
});

test("large live access fanout is detached within the aggregate mutation cap and does not pin independent refresh cleanup", async () => {
  await reset();
  const parent = await srv.testDb.pool.query(
    "INSERT INTO subkit.mcp_oauth_refresh_tokens(tenant_id,client_id,user_id,prefix,token_sha256,scope,expires_at) VALUES($1,'fanout',$2,'prefix','fanout-parent','mcp:read',now()-interval '8 days') RETURNING id",
    [srv.tenantId, srv.userId],
  );
  const parentId = parent.rows[0].id;
  await srv.testDb.pool.query(
    "INSERT INTO subkit.mcp_oauth_access_tokens(tenant_id,client_id,user_id,prefix,token_sha256,scope,expires_at,refresh_token_id) SELECT $1,'fanout',$2,'prefix','fanout-'||g,'mcp:read',now()+interval '1 day',$3 FROM generate_series(1,400)g",
    [srv.tenantId, srv.userId, parentId],
  );
  await srv.testDb.pool.query(
    "INSERT INTO subkit.mcp_oauth_refresh_tokens(tenant_id,client_id,user_id,prefix,token_sha256,scope,expires_at) VALUES($1,'independent',$2,'prefix','independent-parent','mcp:read',now()-interval '8 days')",
    [srv.tenantId, srv.userId],
  );
  for (let tick = 0; tick < 4; tick++) {
    await runMcpOAuthCleanup(new Date(getTestNow()), srv.db);
    const linked = await srv.testDb.pool.query(
      "SELECT count(*)::int n FROM subkit.mcp_oauth_access_tokens WHERE refresh_token_id=$1",
      [parentId],
    );
    expect(linked.rows[0].n).toBe(Math.max(0, 400 - 128 * (tick + 1)));
    expect(await count("mcp_oauth_access_tokens")).toBe(400);
    if (tick === 0) expect(await count("mcp_oauth_refresh_tokens")).toBe(1);
  }
  expect(await count("mcp_oauth_refresh_tokens")).toBe(0);
  const audit = await srv.testDb.pool.query(
    "SELECT metadata FROM subkit.audit_log WHERE action='mcp_oauth.expired_pruned' AND metadata->>'sweep'='refresh_tokens_deleted'",
  );
  expect(audit.rows).toHaveLength(4);
  for (const row of audit.rows) {
    expect(
      row.metadata.refresh_tokens_deleted + row.metadata.access_references_detached,
    ).toBeLessThanOrEqual(256);
  }
});

test("a concurrent uncommitted foreign key writer protects its refresh parent while unrelated keys progress", async () => {
  await reset();
  const parent = await srv.testDb.pool.query(
    "INSERT INTO subkit.mcp_oauth_refresh_tokens(tenant_id,client_id,user_id,prefix,token_sha256,scope,expires_at) VALUES($1,'writer',$2,'prefix','writer-parent','mcp:read',now()-interval '8 days') RETURNING id",
    [srv.tenantId, srv.userId],
  );
  const writer = await srv.testDb.pool.connect();
  try {
    await writer.query("BEGIN");
    await writer.query(
      "INSERT INTO subkit.mcp_oauth_access_tokens(tenant_id,client_id,user_id,prefix,token_sha256,scope,expires_at,refresh_token_id) VALUES($1,'writer',$2,'prefix','writer-child','mcp:read',now()+interval '1 day',$3)",
      [srv.tenantId, srv.userId, parent.rows[0].id],
    );
    await seedCodes(1);
    await runMcpOAuthCleanup(new Date(getTestNow()), srv.db);
    expect(await count("mcp_oauth_refresh_tokens")).toBe(1);
    expect(await count("mcp_oauth_authorization_codes")).toBe(0);
    await writer.query("COMMIT");
    await runMcpOAuthCleanup(new Date(getTestNow()), srv.db);
    expect(await count("mcp_oauth_refresh_tokens")).toBe(0);
    const child = await srv.testDb.pool.query(
      "SELECT refresh_token_id FROM subkit.mcp_oauth_access_tokens WHERE token_sha256='writer-child'",
    );
    expect(child.rows[0].refresh_token_id).toBeNull();
  } finally {
    await writer.query("ROLLBACK");
    writer.release();
  }
});

test("all original grace windows and recent proof guards remain strict", async () => {
  await reset();
  await srv.testDb.pool.query(
    "INSERT INTO subkit.mcp_oauth_access_tokens(tenant_id,client_id,user_id,prefix,token_sha256,scope,expires_at) VALUES($1,'grace',$2,'prefix','inside-token-grace','mcp:read',now()-interval '6 days 23 hours'),($1,'grace',$2,'prefix','outside-token-grace','mcp:read',now()-interval '7 days 1 hour')",
    [srv.tenantId, srv.userId],
  );
  await srv.testDb.pool.query(
    "INSERT INTO subkit.mcp_oauth_authorization_codes(tenant_id,client_id,user_id,code_sha256,code_challenge,code_challenge_method,redirect_uri,scope,expires_at) VALUES($1,'grace',$2,'inside-code-grace','challenge','S256','https://client.example/callback','mcp:read',now()-interval '23 hours'),($1,'grace',$2,'outside-code-grace','challenge','S256','https://client.example/callback','mcp:read',now()-interval '25 hours')",
    [srv.tenantId, srv.userId],
  );
  await srv.testDb.pool.query(
    "INSERT INTO subkit.mcp_oauth_clients(client_id,client_name,created_at,registration_source) VALUES('inside-client-grace','private-client-canary',now()-interval '29 days','manual'),('outside-client-grace','private-client-canary',now()-interval '31 days','manual'),('inside-retire-grace','private-client-canary',now()-interval '6 days 23 hours','dcr'),('outside-retire-grace','private-client-canary',now()-interval '7 days 1 hour','dcr')",
  );
  await runMcpOAuthCleanup(new Date(getTestNow()), srv.db);
  const tokens = await srv.testDb.pool.query(
    "SELECT token_sha256 FROM subkit.mcp_oauth_access_tokens",
  );
  expect(tokens.rows).toEqual([{ token_sha256: "inside-token-grace" }]);
  const codes = await srv.testDb.pool.query(
    "SELECT code_sha256 FROM subkit.mcp_oauth_authorization_codes",
  );
  expect(codes.rows).toEqual([{ code_sha256: "inside-code-grace" }]);
  const clients = await srv.testDb.pool.query(
    "SELECT client_id,disabled_at IS NOT NULL AS disabled FROM subkit.mcp_oauth_clients ORDER BY client_id",
  );
  expect(clients.rows).toEqual([
    { client_id: "inside-client-grace", disabled: false },
    { client_id: "inside-retire-grace", disabled: false },
    { client_id: "outside-retire-grace", disabled: true },
  ]);
  expect(JSON.stringify(await srv.db.select().from(auditLog))).not.toContain(
    "private-client-canary",
  );
});

test("a writer arriving after parent lock cannot introduce an implicit access fanout", async () => {
  await reset();
  const parent = await srv.testDb.pool.query(
    "INSERT INTO subkit.mcp_oauth_refresh_tokens(tenant_id,client_id,user_id,prefix,token_sha256,scope,expires_at) VALUES($1,'late-writer',$2,'prefix','late-writer-parent','mcp:read',now()-interval '8 days') RETURNING id",
    [srv.tenantId, srv.userId],
  );
  const barrier = await srv.testDb.pool.connect();
  const writer = await srv.testDb.pool.connect();
  await barrier.query("SELECT pg_advisory_lock(81197621)");
  await srv.testDb.pool.query(
    "CREATE FUNCTION subkit.test_oauth_delete_barrier() RETURNS trigger LANGUAGE plpgsql AS $$ BEGIN PERFORM pg_advisory_xact_lock(81197621); RETURN OLD; END $$; CREATE TRIGGER test_oauth_delete_barrier BEFORE DELETE ON subkit.mcp_oauth_refresh_tokens FOR EACH ROW EXECUTE FUNCTION subkit.test_oauth_delete_barrier()",
  );
  const cleanup = runMcpOAuthCleanup(new Date(getTestNow()), srv.db);
  let inserting: Promise<unknown> | undefined;
  try {
    await waitFor(
      async () => {
        const r = await srv.testDb.pool.query(
          "SELECT 1 FROM pg_stat_activity WHERE datname=current_database() AND wait_event='advisory' AND pid<>pg_backend_pid()",
        );
        return r.rowCount === 1;
      },
      { label: "cleanup parent delete barrier" },
    );
    const pid = (await writer.query("SELECT pg_backend_pid() AS pid")).rows[0].pid;
    inserting = writer
      .query(
        "INSERT INTO subkit.mcp_oauth_access_tokens(tenant_id,client_id,user_id,prefix,token_sha256,scope,expires_at,refresh_token_id) VALUES($1,'late-writer',$2,'prefix','late-writer-child','mcp:read',now()+interval '1 day',$3)",
        [srv.tenantId, srv.userId, parent.rows[0].id],
      )
      .then(
        () => ({ code: "accepted" }),
        (error: unknown) => ({
          code: error instanceof Error && "code" in error ? error.code : undefined,
        }),
      );
    await waitFor(
      async () => {
        const r = await srv.testDb.pool.query(
          "SELECT wait_event_type FROM pg_stat_activity WHERE pid=$1",
          [pid],
        );
        return r.rows[0]?.wait_event_type === "Lock";
      },
      { label: "foreign key writer blocked by parent lock" },
    );
    await barrier.query("SELECT pg_advisory_unlock(81197621)");
    await cleanup;
    expect(await inserting).toEqual({ code: "23503" });
    expect(await count("mcp_oauth_refresh_tokens")).toBe(0);
    expect(await count("mcp_oauth_access_tokens")).toBe(0);
  } finally {
    await barrier.query("SELECT pg_advisory_unlock(81197621)");
    await cleanup;
    await inserting;
    await srv.testDb.pool.query(
      "DROP TRIGGER test_oauth_delete_barrier ON subkit.mcp_oauth_refresh_tokens; DROP FUNCTION subkit.test_oauth_delete_barrier()",
    );
    barrier.release();
    writer.release();
  }
});

test("a token exchange holding the global client row preserves new live proof before retirement", async () => {
  await reset();
  await srv.testDb.pool.query(
    "INSERT INTO subkit.mcp_oauth_clients(client_id,created_at) VALUES('mint-race',now()-interval '10 days')",
  );
  const writer = await srv.testDb.pool.connect();
  try {
    await writer.query("BEGIN");
    await writer.query(
      "SELECT id FROM subkit.mcp_oauth_clients WHERE client_id='mint-race' FOR UPDATE",
    );
    await writer.query(
      "INSERT INTO subkit.mcp_oauth_refresh_tokens(tenant_id,client_id,user_id,prefix,token_sha256,scope,expires_at) VALUES($1,'mint-race',$2,'prefix','mint-race-refresh','mcp:read',now()+interval '1 day')",
      [srv.tenantId, srv.userId],
    );
    await runMcpOAuthCleanup(new Date(getTestNow()), srv.db);
    await writer.query("COMMIT");
    await runMcpOAuthCleanup(new Date(getTestNow()), srv.db);
    const client = await srv.testDb.pool.query(
      "SELECT disabled_at,retired_at FROM subkit.mcp_oauth_clients WHERE client_id='mint-race'",
    );
    expect(client.rows).toEqual([{ disabled_at: null, retired_at: null }]);
    expect(await count("mcp_oauth_refresh_tokens")).toBe(1);
  } finally {
    await writer.query("ROLLBACK");
    writer.release();
  }
});
