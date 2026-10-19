import { afterAll, beforeAll, expect, test } from "bun:test";
import { createHash } from "node:crypto";
import { ConfigSchema } from "../../config/schema.ts";
import { createHttpTestServer, type HttpTestServer } from "../../http/tests/setup.ts";
import { runMcpOAuthCleanup } from "../../scheduler/mcp-oauth-cleanup-runner.ts";
import { getTestNow } from "../../test-helpers/determinism/clock.ts";
import { waitFor } from "../../test-helpers/determinism/wait.ts";
import { createMcpOAuthProvider, type McpOAuthProvider } from "./server-provider.ts";

let srv: HttpTestServer;
let provider: McpOAuthProvider;
beforeAll(async () => {
  srv = await createHttpTestServer("oauth-client-cleanup-authority");
  provider = createMcpOAuthProvider({
    db: srv.db,
    config: ConfigSchema.parse({
      database: { url: srv.testDb.url },
      server: { public_base_url: "https://engine.example" },
      auth: { mcp_oauth: { enabled: true } },
    }),
  });
});
afterAll(async () => {
  await srv?.cleanup();
});

async function seed(clientId: string, ageDays = 31) {
  await srv.testDb.pool.query(
    "INSERT INTO subkit.mcp_oauth_clients(client_id,redirect_uris,created_at) VALUES($1,'[\"https://client.example/callback\"]'::jsonb,now()-make_interval(days=>$2::int))",
    [clientId, ageDays],
  );
}
function issue(clientId: string, codeChallenge = "challenge") {
  return provider.issueAuthorizationCode({
    clientId,
    tenantId: srv.tenantId,
    userId: srv.userId,
    redirectUri: "https://client.example/callback",
    codeChallenge,
    scope: "mcp:read",
    requestSource: "ui",
  });
}
async function codeCount(clientId: string) {
  return (
    await srv.testDb.pool.query(
      "SELECT count(*)::int n FROM subkit.mcp_oauth_authorization_codes WHERE client_id=$1",
      [clientId],
    )
  ).rows[0].n as number;
}
async function auditCount(action: string, clientId: string) {
  return (
    await srv.testDb.pool.query(
      "SELECT count(*)::int n FROM subkit.audit_log WHERE action=$1 AND metadata->>'client_id'=$2",
      [action, clientId],
    )
  ).rows[0].n as number;
}
async function waitAdvisory() {
  await waitFor(
    async () => {
      const r = await srv.testDb.pool.query(
        "SELECT 1 FROM pg_stat_activity WHERE datname=current_database() AND wait_event='advisory' AND pid<>pg_backend_pid()",
      );
      return r.rowCount === 1;
    },
    { label: "OAuth transaction barrier" },
  );
}
async function waitClientLock() {
  await waitFor(
    async () => {
      const r = await srv.testDb.pool.query(
        "SELECT 1 FROM pg_stat_activity WHERE datname=current_database() AND wait_event_type='Lock' AND wait_event<>'advisory' AND query ILIKE '%mcp_oauth_clients%' AND pid<>pg_backend_pid()",
      );
      return (r.rowCount ?? 0) > 0;
    },
    { label: "OAuth client authority lock" },
  );
}

test("missing and explicitly revoked clients cannot receive codes or be reactivated", async () => {
  await expect(issue("missing-client")).rejects.toMatchObject({ oauth_error: "invalid_client" });
  expect(await codeCount("missing-client")).toBe(0);
  await seed("revoked-client", 10);
  await srv.testDb.pool.query(
    "UPDATE subkit.mcp_oauth_clients SET disabled_at=now() WHERE client_id='revoked-client'",
  );
  await expect(issue("revoked-client")).rejects.toMatchObject({ oauth_error: "invalid_client" });
  expect(await codeCount("revoked-client")).toBe(0);
  expect(await auditCount("mcp_oauth.client_reactivated", "revoked-client")).toBe(0);
  const row = await srv.testDb.pool.query(
    "SELECT disabled_at,retired_at FROM subkit.mcp_oauth_clients WHERE client_id='revoked-client'",
  );
  expect(row.rows[0].disabled_at).not.toBeNull();
  expect(row.rows[0].retired_at).toBeNull();
});

test("human code issuance reactivates retirement and mandatory audit failure rolls back both changes", async () => {
  await seed("retired-client", 10);
  await seed("rollback-client", 10);
  await srv.testDb.pool.query(
    "UPDATE subkit.mcp_oauth_clients SET disabled_at=now(),retired_at=now() WHERE client_id IN ('retired-client','rollback-client')",
  );
  expect(await issue("retired-client")).toBeString();
  expect(await codeCount("retired-client")).toBe(1);
  expect(await auditCount("mcp_oauth.client_reactivated", "retired-client")).toBe(1);
  expect(await auditCount("mcp_oauth.code_issued", "retired-client")).toBe(1);
  const before = (
    await srv.testDb.pool.query(
      "SELECT disabled_at,retired_at FROM subkit.mcp_oauth_clients WHERE client_id='rollback-client'",
    )
  ).rows[0];
  await srv.testDb.pool.query(
    "CREATE FUNCTION subkit.test_code_audit_failure() RETURNS trigger LANGUAGE plpgsql AS $$ BEGIN IF NEW.action='mcp_oauth.code_issued' THEN RAISE EXCEPTION 'synthetic_code_audit_failure'; END IF; RETURN NEW; END $$; CREATE TRIGGER test_code_audit_failure BEFORE INSERT ON subkit.audit_log FOR EACH ROW EXECUTE FUNCTION subkit.test_code_audit_failure()",
  );
  try {
    await expect(issue("rollback-client")).rejects.toThrow();
    expect(await codeCount("rollback-client")).toBe(0);
    expect(await auditCount("mcp_oauth.client_reactivated", "rollback-client")).toBe(0);
    expect(
      (
        await srv.testDb.pool.query(
          "SELECT disabled_at,retired_at FROM subkit.mcp_oauth_clients WHERE client_id='rollback-client'",
        )
      ).rows[0],
    ).toEqual(before);
  } finally {
    await srv.testDb.pool.query(
      "DROP TRIGGER test_code_audit_failure ON subkit.audit_log; DROP FUNCTION subkit.test_code_audit_failure()",
    );
  }
});

test("code issuance first holds the client authority until code and audit commit", async () => {
  await seed("code-first");
  const barrier = await srv.testDb.pool.connect();
  await barrier.query("SELECT pg_advisory_lock(81197011)");
  await srv.testDb.pool.query(
    "CREATE FUNCTION subkit.test_code_barrier() RETURNS trigger LANGUAGE plpgsql AS $$ BEGIN IF NEW.client_id='code-first' THEN PERFORM pg_advisory_xact_lock(81197011); END IF; RETURN NEW; END $$; CREATE TRIGGER test_code_barrier BEFORE INSERT ON subkit.mcp_oauth_authorization_codes FOR EACH ROW EXECUTE FUNCTION subkit.test_code_barrier()",
  );
  const issuance = issue("code-first");
  try {
    await waitAdvisory();
    await runMcpOAuthCleanup(new Date(getTestNow()), srv.db);
    expect(
      (
        await srv.testDb.pool.query(
          "SELECT disabled_at FROM subkit.mcp_oauth_clients WHERE client_id='code-first'",
        )
      ).rows,
    ).toEqual([{ disabled_at: null }]);
    await barrier.query("SELECT pg_advisory_unlock(81197011)");
    await issuance;
    await runMcpOAuthCleanup(new Date(getTestNow()), srv.db);
    expect(await codeCount("code-first")).toBe(1);
    expect(await auditCount("mcp_oauth.code_issued", "code-first")).toBe(1);
  } finally {
    await barrier.query("SELECT pg_advisory_unlock(81197011)");
    await issuance;
    await srv.testDb.pool.query(
      "DROP TRIGGER test_code_barrier ON subkit.mcp_oauth_authorization_codes; DROP FUNCTION subkit.test_code_barrier()",
    );
    barrier.release();
  }
});

test("cleanup deletion first rejects the waiting issuer without an orphaned code", async () => {
  await seed("cleanup-first");
  const barrier = await srv.testDb.pool.connect();
  await barrier.query("SELECT pg_advisory_lock(81197012)");
  await srv.testDb.pool.query(
    "CREATE FUNCTION subkit.test_client_delete_barrier() RETURNS trigger LANGUAGE plpgsql AS $$ BEGIN IF OLD.client_id='cleanup-first' THEN PERFORM pg_advisory_xact_lock(81197012); END IF; RETURN OLD; END $$; CREATE TRIGGER test_client_delete_barrier BEFORE DELETE ON subkit.mcp_oauth_clients FOR EACH ROW EXECUTE FUNCTION subkit.test_client_delete_barrier()",
  );
  const cleanup = runMcpOAuthCleanup(new Date(getTestNow()), srv.db);
  let issuance: Promise<unknown> | undefined;
  try {
    await waitAdvisory();
    issuance = issue("cleanup-first").then(
      () => ({ oauth_error: "accepted" }),
      (error: unknown) => error,
    );
    await waitClientLock();
    await barrier.query("SELECT pg_advisory_unlock(81197012)");
    await cleanup;
    expect(await issuance).toMatchObject({ oauth_error: "invalid_client" });
    expect(await codeCount("cleanup-first")).toBe(0);
    expect(await auditCount("mcp_oauth.code_issued", "cleanup-first")).toBe(0);
    expect(
      (
        await srv.testDb.pool.query(
          "SELECT id FROM subkit.mcp_oauth_clients WHERE client_id='cleanup-first'",
        )
      ).rows,
    ).toHaveLength(0);
  } finally {
    await barrier.query("SELECT pg_advisory_unlock(81197012)");
    await cleanup;
    await issuance;
    await srv.testDb.pool.query(
      "DROP TRIGGER test_client_delete_barrier ON subkit.mcp_oauth_clients; DROP FUNCTION subkit.test_client_delete_barrier()",
    );
    barrier.release();
  }
});

test("cleanup retirement first permits the waiting human issuer to reactivate under the same lock", async () => {
  await seed("retire-first", 10);
  const barrier = await srv.testDb.pool.connect();
  await barrier.query("SELECT pg_advisory_lock(81197013)");
  await srv.testDb.pool.query(
    "CREATE FUNCTION subkit.test_client_retire_barrier() RETURNS trigger LANGUAGE plpgsql AS $$ BEGIN IF NEW.client_id='retire-first' AND NEW.retired_at IS NOT NULL THEN PERFORM pg_advisory_xact_lock(81197013); END IF; RETURN NEW; END $$; CREATE TRIGGER test_client_retire_barrier BEFORE UPDATE ON subkit.mcp_oauth_clients FOR EACH ROW EXECUTE FUNCTION subkit.test_client_retire_barrier()",
  );
  const cleanup = runMcpOAuthCleanup(new Date(getTestNow()), srv.db);
  let issuance: Promise<string> | undefined;
  try {
    await waitAdvisory();
    issuance = issue("retire-first");
    await waitClientLock();
    await barrier.query("SELECT pg_advisory_unlock(81197013)");
    await cleanup;
    await issuance;
    expect(await codeCount("retire-first")).toBe(1);
    expect(await auditCount("mcp_oauth.client_reactivated", "retire-first")).toBe(1);
    expect(
      (
        await srv.testDb.pool.query(
          "SELECT disabled_at,retired_at FROM subkit.mcp_oauth_clients WHERE client_id='retire-first'",
        )
      ).rows,
    ).toEqual([{ disabled_at: null, retired_at: null }]);
  } finally {
    await barrier.query("SELECT pg_advisory_unlock(81197013)");
    await cleanup;
    await issuance;
    await srv.testDb.pool.query(
      "DROP TRIGGER test_client_retire_barrier ON subkit.mcp_oauth_clients; DROP FUNCTION subkit.test_client_retire_barrier()",
    );
    barrier.release();
  }
});

test("a retained authorization code whose global client is absent cannot mint orphaned tokens", async () => {
  await seed("absent-exchange-client", 0);
  const verifier = "dBjftJeZ4CVP-mB92K27uhbUJU1p1r_wW1gFWFOEjXk";
  const code = await issue(
    "absent-exchange-client",
    createHash("sha256").update(verifier).digest("base64url"),
  );
  await srv.testDb.pool.query(
    "DELETE FROM subkit.mcp_oauth_clients WHERE client_id='absent-exchange-client'",
  );
  await expect(
    provider.exchangeAuthorizationCode({
      clientId: "absent-exchange-client",
      code,
      codeVerifier: verifier,
      redirectUri: "https://client.example/callback",
    }),
  ).rejects.toMatchObject({ oauth_error: "invalid_grant" });
  for (const table of ["mcp_oauth_access_tokens", "mcp_oauth_refresh_tokens", "mcp_oauth_grants"]) {
    expect(
      (
        await srv.testDb.pool.query(
          `SELECT count(*)::int n FROM subkit.${table} WHERE client_id='absent-exchange-client'`,
        )
      ).rows[0].n,
    ).toBe(0);
  }
  expect(await auditCount("mcp_oauth.token_rejected", "absent-exchange-client")).toBe(1);
});
