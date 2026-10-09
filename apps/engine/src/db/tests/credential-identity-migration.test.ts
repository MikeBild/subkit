import { expect, test } from "bun:test";
import { createCipheriv } from "node:crypto";
import { createDeterministicUuidFactory } from "../../test-helpers/determinism/ids.ts";
import { runMigrations } from "../migrate.ts";
import { EMBEDDED_MIGRATIONS } from "../migrations/embedded.ts";
import { createTestDb, type TestDb } from "./setup.ts";

const additions = [
  ["credentials", "verified_identity"],
  ["credentials", "credential_generation"],
  ["outbound_connections", "verified_identity"],
  ["execution_steps", "credential_snapshots"],
] as const;

function identityMigration() {
  const candidates = EMBEDDED_MIGRATIONS.filter((migration) =>
    migration.statements.some((statement) =>
      /ALTER TABLE\s+(?:"subkit"\.)?"credentials"\s+ADD COLUMN\s+"credential_generation"/i.test(
        statement,
      ),
    ),
  );
  expect(candidates).toHaveLength(1);
  const migration = candidates[0];
  if (!migration) throw new Error("Credential identity migration must be generated and embedded");
  for (const [table, column] of additions) {
    const pattern = new RegExp(
      `ALTER TABLE\\s+(?:"subkit"\\.)?"${table}"\\s+ADD COLUMN\\s+"${column}"`,
      "i",
    );
    expect(migration.statements.some((statement) => pattern.test(statement))).toBe(true);
  }
  return migration;
}

function encryptedFixture(value: string, nonce: number) {
  const iv = Buffer.alloc(12, nonce);
  const cipher = createCipheriv("aes-256-gcm", Buffer.alloc(32, 17), iv);
  const ciphertext = Buffer.concat([cipher.update(value, "utf8"), cipher.final()]);
  return { ciphertext, iv, authTag: cipher.getAuthTag() };
}

async function storedRows(ctx: TestDb, tenantId: string, omitAdditions: boolean) {
  const result: Record<string, unknown[]> = {};
  for (const table of ["credentials", "outbound_connections", "execution_steps"] as const) {
    const omitted = omitAdditions
      ? additions.filter(([owner]) => owner === table).map(([, column]) => column)
      : [];
    const { rows } = await ctx.pool.query<{ value: Record<string, unknown> }>(
      `SELECT to_jsonb(record) - $2::text[] AS value
         FROM subkit.${table} record WHERE tenant_id = $1 ORDER BY id`,
      [tenantId, omitted],
    );
    result[table] = rows.map(({ value }) => value);
  }
  return result;
}

async function journal(ctx: TestDb) {
  const { rows } = await ctx.pool.query<{
    id: number;
    hash: string;
    created_at: string;
    tag: string;
  }>("SELECT id, hash, created_at, tag FROM subkit.__drizzle_migrations ORDER BY id");
  return rows;
}

async function expectConstraintFailure(
  ctx: TestDb,
  statement: string,
  values: unknown[],
  constraint: string,
) {
  const client = await ctx.pool.connect();
  try {
    await client.query("BEGIN");
    await expect(client.query(statement, values)).rejects.toMatchObject({
      code: "23514",
      constraint,
    });
  } finally {
    try {
      await client.query("ROLLBACK");
    } finally {
      client.release();
    }
  }
}

test("identity upgrade preserves encrypted rows and history across replay", async () => {
  const migration = identityMigration();
  const ctx = await createTestDb("credential_identity_upgrade", { upToIdx: migration.idx - 1 });
  try {
    const nextId = createDeterministicUuidFactory(713);
    const tenantId = nextId();
    const connectorId = nextId();
    const connectionId = nextId();
    const executionId = nextId();
    const access = encryptedFixture("synthetic-access-token", 1);
    const refresh = encryptedFixture("synthetic-refresh-token", 2);
    await ctx.pool.query(
      `INSERT INTO subkit.tenants (id, slug, display_name)
       VALUES ($1, 'identity-upgrade', 'Identity upgrade')`,
      [tenantId],
    );
    await ctx.pool.query(
      `INSERT INTO subkit.connectors (id, tenant_id, slug, display_name, driver, auth_type)
       VALUES ($1, $2, 'identity-connector', 'Identity connector', 'http', 'oauth2')`,
      [connectorId, tenantId],
    );
    await ctx.pool.query(
      `INSERT INTO subkit.outbound_connections
        (id, tenant_id, name, base_url, issuer, authorization_endpoint, token_endpoint,
         client_id, authority_revision, scopes, granted_scopes, access_token_version,
         refresh_token_version)
       VALUES ($1, $2, 'identity-connection', 'https://example.com', 'https://example.com',
         'https://example.com/authorize', 'https://example.com/token', 'synthetic-client',
         7, '["read"]', '["read"]', 3, 2)`,
      [connectionId, tenantId],
    );
    await ctx.pool.query(
      `INSERT INTO subkit.credentials
        (id, tenant_id, connector_id, environment, mode, authority_revision,
         ciphertext, iv, auth_tag, oauth2_refresh_ciphertext, oauth2_refresh_iv,
         oauth2_refresh_auth_tag, granted_scopes, connection_id)
       VALUES ($1, $2, $3, 'prod', 'oauth2', 9, $4, $5, $6, $7, $8, $9, 'read', $10)`,
      [
        nextId(),
        tenantId,
        connectorId,
        access.ciphertext,
        access.iv,
        access.authTag,
        refresh.ciphertext,
        refresh.iv,
        refresh.authTag,
        connectionId,
      ],
    );
    await ctx.pool.query(
      `INSERT INTO subkit.executions
        (id, tenant_id, source_kind, status, request_source, execution_mode)
       VALUES ($1, $2, 'step', 'succeeded', 'api', 'prod')`,
      [executionId, tenantId],
    );
    await ctx.pool.query(
      `INSERT INTO subkit.execution_steps
        (id, tenant_id, execution_id, step_key, kind, status, output_preview, retry_count)
       VALUES ($1, $2, $3, 'fetch', 'http', 'succeeded', '{"preserved":true}', 2)`,
      [nextId(), tenantId, executionId],
    );
    const before = await storedRows(ctx, tenantId, false);
    const historicalJournal = await journal(ctx);
    const historicalMigrations = EMBEDDED_MIGRATIONS.filter((entry) => entry.idx < migration.idx);
    expect(historicalJournal.map(({ tag, hash }) => ({ tag, hash }))).toEqual(
      historicalMigrations.map(({ tag, hash }) => ({ tag, hash })),
    );
    for (const [table, column] of additions) {
      expect(before[table]).toHaveLength(1);
      expect(before[table]?.[0]).not.toHaveProperty(column);
    }

    const report = await runMigrations(ctx.db);
    expect(report.applied).toBe(EMBEDDED_MIGRATIONS.length - historicalMigrations.length);
    expect(report.hash_drift_backfilled).toBe(0);
    expect(await storedRows(ctx, tenantId, true)).toEqual(before);
    const upgraded = await storedRows(ctx, tenantId, false);
    expect(upgraded.credentials?.[0]).toMatchObject({
      verified_identity: null,
      credential_generation: 1,
    });
    expect(upgraded.outbound_connections?.[0]).toMatchObject({ verified_identity: null });
    expect(upgraded.execution_steps?.[0]).toMatchObject({ credential_snapshots: [] });
    const upgradedJournal = await journal(ctx);
    expect(upgradedJournal.slice(0, historicalJournal.length)).toEqual(historicalJournal);

    for (const generation of [0, -1]) {
      await expectConstraintFailure(
        ctx,
        "UPDATE subkit.credentials SET credential_generation = $2 WHERE tenant_id = $1",
        [tenantId, generation],
        "credentials_credential_generation_positive",
      );
    }
    for (const snapshots of ["{}", '"invalid"', "null", "1"]) {
      await expectConstraintFailure(
        ctx,
        `UPDATE subkit.execution_steps SET credential_snapshots = $2::jsonb
         WHERE tenant_id = $1 AND execution_id = $3`,
        [tenantId, snapshots, executionId],
        "execution_steps_credential_snapshots_array",
      );
    }
    expect(await storedRows(ctx, tenantId, false)).toEqual(upgraded);

    const replay = await runMigrations(ctx.db);
    expect(replay).toEqual({
      applied: 0,
      skipped: EMBEDDED_MIGRATIONS.length,
      hash_drift_backfilled: 0,
      total: EMBEDDED_MIGRATIONS.length,
    });
    expect(await storedRows(ctx, tenantId, false)).toEqual(upgraded);
    expect(await journal(ctx)).toEqual(upgradedJournal);
  } finally {
    await ctx.cleanup();
  }
});
