import { afterAll, beforeAll, beforeEach, expect } from "bun:test";
import { createHash } from "node:crypto";
import { eq } from "drizzle-orm";
import pg from "pg";
import { decryptSecretBytesWithKey, encryptSecretBytesWithKey } from "../crypto/aes-gcm.ts";
import { provisionSelfServiceTenant } from "../identity/self-service.ts";
import { createDeterministicUuidFactory } from "../test-helpers/determinism/ids.ts";
import { configureHostedPolicyForTests } from "../test-helpers/hosted-policy.ts";
import { hostedTenantUsage, runtimeConfigState, runtimeSecretVersions } from "./schema/index.ts";
import { createTestDb, type TestDb } from "./tests/setup.ts";
import { VAULT_STOCK_TABLES } from "./vault-stock-sql.ts";

export let fixture: TestDb;

export let runtimeRole: string;

export let maintenanceRole: string;

export let runtime: pg.Pool;

export let maintenance: pg.Pool;

export let binding: Record<string, unknown>;

export let tenantId: string;

export let sourceEpoch = 0;

export const ids = createDeterministicUuidFactory(519832);

export const oldKey = Buffer.alloc(32, 19);

export const newKey = Buffer.alloc(32, 27);

export const digest = (value: Uint8Array) => createHash("sha256").update(value).digest("hex");

export const evidence = digest(Buffer.from("operator reviewed every producer origin stopped"));

const previousEnvKey = process.env.MASTER_KEY;

export const statusSignature = "subkit.vault_maintenance_status()";

export const snapshotSignature =
  "subkit.vault_maintenance_snapshot(uuid,bigint,text,text,text,integer,integer)";

const applySignature =
  "subkit.vault_maintenance_apply(uuid,text,subkit.vault_cipher_replacement[],boolean)";

export interface SnapshotRow {
  name: string;
  version: number;
  tenant_id: string | null;
  ciphertext: string;
  iv: string;
  auth_tag: string;
  metadata_sha256: string;
}

interface Page {
  operation_id: string;
  page_number: number;
  source_epoch: number;
  page_sha256: string;
  has_more: boolean;
  rows: SnapshotRow[];
}

export async function seed(count = 1) {
  for (let i = 0; i < count; i++) {
    const name = `connection.${tenantId}.fixture-${i}.access_token`;
    const value = Buffer.from([0, 255, 19, i, 128]);
    const encrypted = encryptSecretBytesWithKey(oldKey, value, `runtime-secret:${name}:1`);
    await fixture.db
      .insert(runtimeSecretVersions)
      .values({ name, version: 1, ...encrypted, revoked_at: i === 1 ? new Date(1000) : null });
  }
  await fixture.pool.query("UPDATE subkit.tenants SET status='suspended' WHERE id=$1", [tenantId]);
  const [usage] = await fixture.db
    .select()
    .from(hostedTenantUsage)
    .where(eq(hostedTenantUsage.tenant_id, tenantId));
  if (!usage) throw new Error("usage missing");
  await fixture.pool.query(
    "UPDATE subkit.runtime_config_revisions SET document=jsonb_set(document,'{storage,hosted,tenant_bytes}',to_jsonb($1::text)) WHERE revision=(SELECT active_revision FROM subkit.runtime_config_state WHERE key='runtime')",
    [usage.logical_bytes.toString()],
  );
  return usage;
}

export async function snapshot(
  client: pg.PoolClient,
  op: string,
  after: SnapshotRow | null = null,
  limit = 128,
): Promise<Page> {
  const result = await client.query<{ page: Page }>(
    "SELECT to_jsonb(subkit.vault_maintenance_snapshot($1,$7,$2,$3,$4,$5,$6)) AS page",
    [op, digest(newKey), evidence, after?.name ?? null, after?.version ?? null, limit, sourceEpoch],
  );
  return result.rows[0]!.page;
}

export function replacements(page: Page) {
  return page.rows.map((row) => {
    const payload = {
      ciphertext: Buffer.from(row.ciphertext.slice(2), "hex"),
      iv: Buffer.from(row.iv.slice(2), "hex"),
      auth_tag: Buffer.from(row.auth_tag.slice(2), "hex"),
    };
    const plaintext = decryptSecretBytesWithKey(
      oldKey,
      payload,
      `runtime-secret:${row.name}:${row.version}`,
    );
    const next = encryptSecretBytesWithKey(
      newKey,
      plaintext,
      `runtime-secret:${row.name}:${row.version}`,
    );
    expect(
      decryptSecretBytesWithKey(newKey, next, `runtime-secret:${row.name}:${row.version}`),
    ).toEqual(plaintext);
    return {
      name: row.name,
      version: row.version,
      expected_ciphertext: row.ciphertext,
      expected_iv: row.iv,
      expected_auth_tag: row.auth_tag,
      replacement_ciphertext: `\\x${Buffer.from(next.ciphertext).toString("hex")}`,
      replacement_iv: `\\x${Buffer.from(next.iv).toString("hex")}`,
      replacement_auth_tag: `\\x${Buffer.from(next.auth_tag).toString("hex")}`,
      unchanged: false,
    };
  });
}

export async function apply(
  client: pg.PoolClient,
  page: Page,
  rows = replacements(page),
  finish = !page.has_more,
) {
  return client.query(
    "SELECT * FROM subkit.vault_maintenance_apply($1,$2,ARRAY(SELECT x FROM jsonb_populate_recordset(NULL::subkit.vault_cipher_replacement,$3::jsonb) x),$4)",
    [page.operation_id, page.page_sha256, JSON.stringify(rows), finish],
  );
}

export async function state() {
  return (
    await fixture.db.select().from(runtimeConfigState).where(eq(runtimeConfigState.key, "runtime"))
  )[0]!;
}

export async function envelopes() {
  return fixture.db.select().from(runtimeSecretVersions).orderBy(runtimeSecretVersions.name);
}

export async function failure(operation: () => Promise<unknown>) {
  try {
    await operation();
    return null;
  } catch (error) {
    return { code: (error as { code?: string }).code, message: (error as Error).message };
  }
}

export function useVaultMaintenanceDb(): void {
  beforeAll(async () => {
    fixture = await createTestDb("vault-maintenance");
    await configureHostedPolicyForTests(fixture.db, fixture.url);
    const suffix = fixture.dbName.replace(/[^a-z0-9_]/g, "").slice(-28);
    runtimeRole = `vault_runtime_${suffix}`;
    maintenanceRole = `vault_maint_${suffix}`;
    await fixture.pool.query(
      `CREATE ROLE "${runtimeRole}" LOGIN PASSWORD 'synthetic-vault-test-only'`,
    );
    await fixture.pool.query(
      `CREATE ROLE "${maintenanceRole}" LOGIN PASSWORD 'synthetic-vault-test-only'`,
    );
    await fixture.pool.query(
      `GRANT USAGE ON SCHEMA subkit,public TO "${runtimeRole}","${maintenanceRole}"`,
    );
    await fixture.pool.query(
      `GRANT SELECT,INSERT,UPDATE,DELETE ON ALL TABLES IN SCHEMA subkit TO "${runtimeRole}"`,
    );
    await fixture.pool.query(
      `GRANT USAGE,SELECT ON ALL SEQUENCES IN SCHEMA subkit TO "${runtimeRole}"`,
    );
    await fixture.pool.query(
      `GRANT EXECUTE ON FUNCTION ${snapshotSignature},${applySignature},${statusSignature} TO "${maintenanceRole}"`,
    );
    const url = new URL(fixture.url);
    const pool = (user: string) =>
      new pg.Pool({
        host: url.hostname,
        port: Number(url.port),
        database: url.pathname.slice(1),
        user,
        password: "synthetic-vault-test-only",
        max: 2,
      });
    runtime = pool(runtimeRole);
    maintenance = pool(maintenanceRole);
    const roles = await fixture.pool.query<{ oid: number; rolname: string }>(
      "SELECT oid,rolname FROM pg_roles WHERE rolname=ANY($1::text[]) OR rolname=current_user",
      [[runtimeRole, maintenanceRole]],
    );
    const entry = (name: string) => {
      const role = roles.rows.find((row) => row.rolname === name);
      if (!role) throw new Error("test role missing");
      return { oid: String(role.oid), name: role.rolname };
    };
    const owner = (await fixture.pool.query<{ name: string }>("SELECT current_user::text AS name"))
      .rows[0]!.name;
    binding = {
      binding_id: ids(),
      maintenance_login: entry(maintenanceRole),
      definer: entry(owner),
      runtime_logins: [entry(runtimeRole)],
      inventory_evidence_sha256: evidence,
    };
    const owned = await provisionSelfServiceTenant(
      {
        issuer_url: "https://identity.example.test",
        subject: "vault-owner",
        email: "vault@example.test",
        email_verified: true,
      },
      fixture.db,
    );
    tenantId = owned.tenant.id;
  });
  afterAll(async () => {
    if (previousEnvKey === undefined) delete process.env.MASTER_KEY;
    else process.env.MASTER_KEY = previousEnvKey;
    await runtime?.end();
    await maintenance?.end();
    const adminUrl = fixture?.url;
    if (fixture) await fixture.cleanup();
    if (adminUrl) {
      const url = new URL(adminUrl);
      url.pathname = "/postgres";
      const admin = new pg.Client({ connectionString: url.toString() });
      await admin.connect();
      try {
        if (runtimeRole) await admin.query(`DROP ROLE "${runtimeRole}"`);
        if (maintenanceRole) await admin.query(`DROP ROLE "${maintenanceRole}"`);
      } finally {
        await admin.end();
      }
    }
  });
  beforeEach(async () => {
    process.env.MASTER_KEY = newKey.toString("hex");
    await fixture.pool.query(
      "UPDATE subkit.runtime_config_revisions SET document=jsonb_set(jsonb_set(document,'{storage,hosted,tenant_bytes}','\"50000000\"'::jsonb),'{storage,hosted,retained_rows_per_resource}','1000'::jsonb) WHERE revision=(SELECT active_revision FROM subkit.runtime_config_state WHERE key='runtime')",
    );
    await fixture.pool.query("UPDATE subkit.tenants SET status='active' WHERE id=$1", [tenantId]);
    await fixture.pool.query("DELETE FROM subkit.runtime_secret_versions");
    await fixture.pool.query(
      "DELETE FROM subkit.audit_log WHERE action='secret.master_key_rewrapped'",
    );
    const client = await fixture.pool.connect();
    try {
      await client.query("BEGIN");
      await client.query(
        "SELECT pg_advisory_xact_lock(hashtextextended('subkit.runtime.vault-maintenance',0))",
      );
      await client.query(
        `LOCK TABLE ${VAULT_STOCK_TABLES.map((table) => `subkit.${table}`).join(",")} IN SHARE MODE`,
      );
      await client.query(
        "UPDATE subkit.runtime_config_state SET vault_maintenance_binding=$1::jsonb,master_key_epoch=master_key_epoch+CASE WHEN master_key_digest IS NOT NULL AND master_key_digest<>$2 THEN 1 ELSE 0 END,master_key_digest=$2 WHERE key='runtime'",
        [JSON.stringify(binding), digest(oldKey)],
      );
      await client.query("COMMIT");
      sourceEpoch = (await state()).master_key_epoch;
    } finally {
      client.release();
    }
  });
}
