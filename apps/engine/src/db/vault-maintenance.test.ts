import { afterAll, beforeAll, beforeEach, expect, test } from "bun:test";
import { createHash } from "node:crypto";
import { readFileSync } from "node:fs";
import { eq } from "drizzle-orm";
import { drizzle } from "drizzle-orm/node-postgres";
import pg from "pg";
import { decryptSecretBytesWithKey, encryptSecretBytesWithKey } from "../crypto/aes-gcm.ts";
import { provisionSelfServiceTenant } from "../identity/self-service.ts";
import { rewrapRegistryWithMaintenance } from "../preflight/rewrap-maintenance.ts";
import { createVaultOps } from "../preflight/vault-ops.ts";
import { createDeterministicUuidFactory } from "../test-helpers/determinism/ids.ts";
import { configureHostedPolicyForTests } from "../test-helpers/hosted-policy.ts";
import { createMigrationDbFromUrl } from "./client.ts";
import { runMigrations } from "./migrate.ts";
import { EMBEDDED_MIGRATIONS } from "./migrations/embedded.ts";
import * as schema from "./schema/index.ts";
import {
  auditLog,
  hostedTenantUsage,
  runtimeConfigState,
  runtimeSecretVersions,
} from "./schema/index.ts";
import { createTestDb, type TestDb } from "./tests/setup.ts";
import { renderVaultMaintenanceSql } from "./vault-maintenance-sql.ts";
import { VAULT_STOCK_TABLES } from "./vault-stock-sql.ts";

let fixture: TestDb;
let runtimeRole: string;
let maintenanceRole: string;
let runtime: pg.Pool;
let maintenance: pg.Pool;
let binding: Record<string, unknown>;
let tenantId: string;
let sourceEpoch = 0;
const ids = createDeterministicUuidFactory(519832);
const oldKey = Buffer.alloc(32, 19);
const newKey = Buffer.alloc(32, 27);
const digest = (value: Uint8Array) => createHash("sha256").update(value).digest("hex");
const evidence = digest(Buffer.from("operator reviewed every producer origin stopped"));
const previousEnvKey = process.env.MASTER_KEY;
const acknowledgement = {
  all_producers_stopped: true as const,
  evidence:
    "All engine workers, application replicas, scheduled processes, command-line credential writers and remote automation origins were individually stopped and reviewed before this operation.",
};
const statusSignature = "subkit.vault_maintenance_status()";
const snapshotSignature =
  "subkit.vault_maintenance_snapshot(uuid,bigint,text,text,text,integer,integer)";
const applySignature =
  "subkit.vault_maintenance_apply(uuid,text,subkit.vault_cipher_replacement[],boolean)";
interface SnapshotRow {
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
async function seed(count = 1) {
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
async function snapshot(
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
function replacements(page: Page) {
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
async function apply(
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
async function state() {
  return (
    await fixture.db.select().from(runtimeConfigState).where(eq(runtimeConfigState.key, "runtime"))
  )[0]!;
}
async function envelopes() {
  return fixture.db.select().from(runtimeSecretVersions).orderBy(runtimeSecretVersions.name);
}
async function failure(operation: () => Promise<unknown>) {
  try {
    await operation();
    return null;
  } catch (error) {
    return { code: (error as { code?: string }).code, message: (error as Error).message };
  }
}

test("generated maintenance SQL is embedded without automatic role creation or grants", () => {
  const migration = EMBEDDED_MIGRATIONS.find((item) => item.tag.endsWith("_vault_maintenance"));
  if (!migration) throw new Error("migration missing");
  const source = readFileSync(
    new URL(`./migrations/${migration.tag}.sql`, import.meta.url),
    "utf8",
  );
  expect(source).toBe(renderVaultMaintenanceSql());
  expect(digest(Buffer.from(source))).toBe(migration.hash);
  expect(source).not.toContain("CREATE ROLE");
  expect(source).not.toContain("GRANT EXECUTE");
});
test("distinct authenticated runtime cannot execute maintenance or forge private binding/context", async () => {
  const auth = await runtime.query("SELECT session_user,current_user");
  expect(auth.rows[0].session_user).toBe(runtimeRole);
  expect(
    (
      await failure(() =>
        runtime.query("SELECT subkit.vault_maintenance_snapshot($1,0,$2,$3,NULL,NULL,128)", [
          ids(),
          digest(newKey),
          evidence,
        ]),
      )
    )?.code,
  ).toBe("42501");
  expect((await failure(() => runtime.query(`SET ROLE "${maintenanceRole}"`)))?.code).toBe("42501");
  expect(
    (
      await failure(() =>
        runtime.query(
          "UPDATE subkit.runtime_config_state SET vault_maintenance_binding=NULL WHERE key='runtime'",
        ),
      )
    )?.code,
  ).toBe("42501");
  await seed();
  const before = await envelopes();
  await runtime.query("SELECT set_config('subkit.vault_maintenance','true',false)");
  expect(
    (
      await failure(() =>
        runtime.query(
          "UPDATE subkit.runtime_secret_versions SET iv=decode(repeat('01',12),'hex') WHERE tenant_id=$1",
          [tenantId],
        ),
      )
    )?.message,
  ).toBe("runtime_secret_owner_inactive");
  expect(await envelopes()).toEqual(before);
  expect(
    (await failure(() => maintenance.query("SELECT * FROM subkit.runtime_secret_versions")))?.code,
  ).toBe("42501");
});
test("runtime cannot poison or reset the key marker even with an actual advisory gate", async () => {
  const client = await runtime.connect();
  try {
    for (const statement of [
      "UPDATE subkit.runtime_config_state SET master_key_digest=repeat('a',64),master_key_epoch=master_key_epoch+1 WHERE key='runtime'",
      "UPDATE subkit.runtime_config_state SET master_key_digest=NULL WHERE key='runtime'",
      "DELETE FROM subkit.runtime_config_state WHERE key='runtime'",
      "UPDATE subkit.runtime_config_state SET key='replacement' WHERE key='runtime'",
    ]) {
      await client.query("BEGIN");
      await client.query(
        "SELECT pg_advisory_xact_lock(hashtextextended('subkit.runtime.vault-maintenance',0))",
      );
      expect((await failure(() => client.query(statement)))?.message).toBe(
        "vault_key_marker_forbidden",
      );
      await client.query("ROLLBACK");
    }
  } finally {
    client.release();
  }
  expect((await state()).master_key_digest).toBe(digest(oldKey));
  expect((await state()).master_key_epoch).toBe(sourceEpoch);
});
test("initial trusted key pin requires a held startup gate and preserves epoch zero", async () => {
  const client = await fixture.pool.connect();
  try {
    await client.query("BEGIN");
    const previous = (
      await client.query(
        "SELECT active_revision,desired_revision FROM subkit.runtime_config_state WHERE key='runtime'",
      )
    ).rows[0]!;
    await client.query("DELETE FROM subkit.runtime_config_state WHERE key='runtime'");
    await client.query(
      "INSERT INTO subkit.runtime_config_state(key,active_revision,desired_revision) VALUES('runtime',$1,$2)",
      [previous.active_revision, previous.desired_revision],
    );
    await client.query("SAVEPOINT missing_gate");
    expect(
      (
        await failure(() =>
          client.query(
            "UPDATE subkit.runtime_config_state SET master_key_digest=$1 WHERE key='runtime'",
            [digest(oldKey)],
          ),
        )
      )?.message,
    ).toBe("vault_key_marker_forbidden");
    await client.query("ROLLBACK TO SAVEPOINT missing_gate");
    await client.query(
      "SELECT pg_advisory_xact_lock_shared(hashtextextended('subkit.runtime.vault-maintenance',0))",
    );
    const result = await client.query(
      "UPDATE subkit.runtime_config_state SET master_key_digest=$1 WHERE key='runtime' RETURNING master_key_epoch,master_key_digest",
      [digest(oldKey)],
    );
    expect(result.rows[0].master_key_epoch).toBe("0");
    expect(result.rows[0].master_key_digest).toBe(digest(oldKey));
    await client.query("ROLLBACK");
  } finally {
    client.release();
  }
});
test("trusted key promotion requires the exclusive gate and no unresolved producer marker", async () => {
  const client = await fixture.pool.connect();
  const statement =
    "UPDATE subkit.runtime_config_state SET master_key_digest=$1,master_key_epoch=master_key_epoch+1 WHERE key='runtime'";
  try {
    await client.query("BEGIN");
    await client.query(
      "SELECT pg_advisory_xact_lock_shared(hashtextextended('subkit.runtime.vault-maintenance',0))",
    );
    expect((await failure(() => client.query(statement, [digest(newKey)])))?.message).toBe(
      "vault_key_marker_forbidden",
    );
    await client.query("ROLLBACK");
    await fixture.pool.query(
      "INSERT INTO subkit.runtime_config_replicas(instance_id,product_version,last_seen_at) VALUES('pin-blocker','test',to_timestamp(0))",
    );
    await client.query("BEGIN");
    await client.query(
      "SELECT pg_advisory_xact_lock(hashtextextended('subkit.runtime.vault-maintenance',0))",
    );
    expect((await failure(() => client.query(statement, [digest(newKey)])))?.message).toBe(
      "vault_key_marker_forbidden",
    );
    await client.query("ROLLBACK");
    await fixture.pool.query(
      "DELETE FROM subkit.runtime_config_replicas WHERE instance_id='pin-blocker'",
    );
    expect((await state()).master_key_digest).toBe(digest(oldKey));
  } finally {
    client.release();
  }
});
test("complete bounded pages rewrap inactive retained bytes and audit atomically at full quota", async () => {
  const baseline = await seed(3);
  const before = await envelopes();
  const client = await maintenance.connect();
  try {
    await client.query("BEGIN");
    let tail: SnapshotRow | null = null;
    const op = ids();
    let pages = 0;
    for (;;) {
      const page = await snapshot(client, op, tail, 2);
      pages++;
      expect(page.rows.length).toBeLessThanOrEqual(2);
      await apply(client, page);
      tail = page.rows.at(-1) ?? null;
      if (!page.has_more) break;
    }
    await client.query("COMMIT");
    expect(pages).toBe(2);
  } catch (error) {
    await client.query("ROLLBACK");
    throw error;
  } finally {
    client.release();
  }
  const after = await envelopes();
  expect(after).toHaveLength(3);
  for (let i = 0; i < after.length; i++) {
    const row = after[i]!;
    const previous = before[i];
    if (!previous) throw new Error("expected registry fixture row missing");
    expect(
      decryptSecretBytesWithKey(newKey, row, `runtime-secret:${row.name}:${row.version}`),
    ).toEqual(Buffer.from([0, 255, 19, i, 128]));
    expect({ ...row, ciphertext: undefined, iv: undefined, auth_tag: undefined }).toEqual({
      ...previous,
      ciphertext: undefined,
      iv: undefined,
      auth_tag: undefined,
    });
  }
  const current = await state();
  expect(current.master_key_epoch).toBe(sourceEpoch + 1);
  expect(current.master_key_digest).toBe(digest(newKey));
  expect(current.vault_maintenance_context).toBeNull();
  const [usage] = await fixture.db
    .select()
    .from(hostedTenantUsage)
    .where(eq(hostedTenantUsage.tenant_id, tenantId));
  expect(usage?.logical_bytes).toBe(baseline.logical_bytes);
  expect(usage?.resource_counts).toEqual(baseline.resource_counts);
  const audits = await fixture.db
    .select()
    .from(auditLog)
    .where(eq(auditLog.action, "secret.master_key_rewrapped"));
  expect(audits).toHaveLength(2);
  expect(JSON.stringify(audits)).not.toContain("fixture-");
});
test("committing a snapshot or a nonterminal batch is refused and rolls back all data", async () => {
  await seed(2);
  const before = await envelopes();
  const client = await maintenance.connect();
  try {
    for (const mutate of [false, true]) {
      await client.query("BEGIN");
      const page = await snapshot(client, ids(), null, 1);
      if (mutate) await apply(client, page);
      expect((await failure(() => client.query("COMMIT")))?.message).toBe(
        "vault_maintenance_incomplete",
      );
      await client.query("ROLLBACK");
      expect(await envelopes()).toEqual(before);
      expect((await state()).master_key_epoch).toBe(sourceEpoch);
    }
  } finally {
    client.release();
  }
});
test("tampered CAS, page coverage and nonce envelopes refuse without changing epoch or ciphertext", async () => {
  await seed(2);
  const before = await envelopes();
  const client = await maintenance.connect();
  try {
    for (const kind of ["cas", "subset", "nonce", "finish"]) {
      await client.query("BEGIN");
      const page = await snapshot(client, ids());
      const rows = replacements(page);
      if (kind === "cas") rows[0]!.expected_ciphertext = "\\x00";
      if (kind === "subset") rows.pop();
      if (kind === "nonce") rows[0]!.replacement_iv = rows[0]!.expected_iv;
      const result = await failure(() => apply(client, page, rows, kind !== "finish"));
      expect(result).not.toBeNull();
      await client.query("ROLLBACK");
      expect(await envelopes()).toEqual(before);
      expect((await state()).master_key_epoch).toBe(sourceEpoch);
    }
  } finally {
    client.release();
  }
});
test("missing or unsafe binding and stale producers remain unavailable", async () => {
  await seed();
  const variants = [
    null,
    { ...binding, runtime_logins: [binding.definer] },
    { ...binding, runtime_logins: [] },
  ];
  const client = await maintenance.connect();
  try {
    for (const value of variants) {
      await fixture.pool.query(
        "UPDATE subkit.runtime_config_state SET vault_maintenance_binding=$1::jsonb WHERE key='runtime'",
        [JSON.stringify(value)],
      );
      await client.query("BEGIN");
      expect((await failure(() => snapshot(client, ids())))?.message).toBe(
        "vault_maintenance_capability_unavailable",
      );
      await client.query("ROLLBACK");
    }
    await fixture.pool.query(
      "UPDATE subkit.runtime_config_state SET vault_maintenance_binding=$1::jsonb WHERE key='runtime'",
      [JSON.stringify(binding)],
    );
    await fixture.pool.query(
      "INSERT INTO subkit.runtime_config_replicas(instance_id,product_version,last_seen_at) VALUES('stale-producer','test',to_timestamp(0))",
    );
    await client.query("BEGIN");
    expect((await failure(() => snapshot(client, ids())))?.message).toBe(
      "vault_maintenance_producers_unresolved",
    );
    await client.query("ROLLBACK");
    await fixture.pool.query(
      "DELETE FROM subkit.runtime_config_replicas WHERE instance_id='stale-producer'",
    );
  } finally {
    client.release();
  }
});
test("unsupported retained nonregistry stock refuses snapshot and trusted key promotion", async () => {
  const stockId = ids();
  await fixture.pool.query(
    "INSERT INTO subkit.auth_provider_configs(id,tenant_id,provider,priority,config_iv) VALUES($1,$2,'fixture',0,decode('01','hex'))",
    [stockId, tenantId],
  );
  await seed();
  const before = await envelopes();
  const client = await maintenance.connect();
  const owner = await fixture.pool.connect();
  try {
    await client.query("BEGIN");
    expect((await failure(() => snapshot(client, ids())))?.message).toBe(
      "vault_non_registry_stock_unsupported",
    );
    await client.query("ROLLBACK");
    await owner.query("BEGIN");
    await owner.query(
      "SELECT pg_advisory_xact_lock(hashtextextended('subkit.runtime.vault-maintenance',0))",
    );
    await owner.query(
      `LOCK TABLE ${VAULT_STOCK_TABLES.map((table) => `subkit.${table}`).join(",")} IN SHARE MODE`,
    );
    expect(
      (
        await failure(() =>
          owner.query(
            "UPDATE subkit.runtime_config_state SET master_key_epoch=master_key_epoch+1,master_key_digest=$1 WHERE key='runtime'",
            [digest(newKey)],
          ),
        )
      )?.message,
    ).toBe("vault_non_registry_stock_unsupported");
    await owner.query("ROLLBACK");
    expect(await envelopes()).toEqual(before);
    expect((await state()).master_key_digest).toBe(digest(oldKey));
  } finally {
    await client.query("ROLLBACK");
    await owner.query("ROLLBACK");
    client.release();
    owner.release();
    await fixture.pool.query("DELETE FROM subkit.auth_provider_configs WHERE id=$1", [stockId]);
  }
});
test("frozen registry maintenance blocks new nonregistry encrypted stock until rollback", async () => {
  await seed();
  const client = await maintenance.connect();
  const writer = await runtime.connect();
  try {
    await client.query("BEGIN");
    await snapshot(client, ids());
    await writer.query("BEGIN");
    await writer.query("SET LOCAL lock_timeout='100ms'");
    expect(
      (
        await failure(() =>
          writer.query(
            "INSERT INTO subkit.auth_provider_configs(tenant_id,provider,priority,config_iv) VALUES($1,'fixture',0,decode('01','hex'))",
            [tenantId],
          ),
        )
      )?.code,
    ).toBe("55P03");
    await writer.query("ROLLBACK");
    await client.query("ROLLBACK");
  } finally {
    await writer.query("ROLLBACK");
    await client.query("ROLLBACK");
    writer.release();
    client.release();
  }
});
test("effective inherited, public and table privileges invalidate the declared maintenance separation", async () => {
  const grants = [
    [
      `GRANT SELECT ON subkit.runtime_secret_versions TO "${maintenanceRole}"`,
      `REVOKE SELECT ON subkit.runtime_secret_versions FROM "${maintenanceRole}"`,
    ],
    [
      `GRANT EXECUTE ON FUNCTION ${snapshotSignature} TO "${runtimeRole}"`,
      `REVOKE EXECUTE ON FUNCTION ${snapshotSignature} FROM "${runtimeRole}"`,
    ],
    [
      `GRANT EXECUTE ON FUNCTION ${snapshotSignature} TO PUBLIC`,
      `REVOKE EXECUTE ON FUNCTION ${snapshotSignature} FROM PUBLIC`,
    ],
    [
      `GRANT "${runtimeRole}" TO "${maintenanceRole}"`,
      `REVOKE "${runtimeRole}" FROM "${maintenanceRole}"`,
    ],
    [
      `GRANT "${maintenanceRole}" TO "${runtimeRole}"`,
      `REVOKE "${maintenanceRole}" FROM "${runtimeRole}"`,
    ],
  ];
  const client = await maintenance.connect();
  try {
    for (const [grant, revoke] of grants) {
      await fixture.pool.query(grant!);
      try {
        await client.query("BEGIN");
        expect((await failure(() => snapshot(client, ids())))?.message).toBe(
          "vault_maintenance_capability_unavailable",
        );
        await client.query("ROLLBACK");
      } finally {
        await fixture.pool.query(revoke!);
      }
    }
  } finally {
    client.release();
  }
});
test("audit insertion failure rolls back rewritten inactive ciphertext and key marker", async () => {
  await seed();
  const before = await envelopes();
  await fixture.pool.query(
    "CREATE FUNCTION subkit.test_vault_audit_failure() RETURNS trigger LANGUAGE plpgsql AS $$ BEGIN IF NEW.action='secret.master_key_rewrapped' THEN RAISE EXCEPTION 'synthetic_audit_failure'; END IF; RETURN NEW; END $$; CREATE TRIGGER test_vault_audit_failure BEFORE INSERT ON subkit.audit_log FOR EACH ROW EXECUTE FUNCTION subkit.test_vault_audit_failure()",
  );
  const client = await maintenance.connect();
  try {
    await client.query("BEGIN");
    const page = await snapshot(client, ids());
    expect((await failure(() => apply(client, page)))?.message).toBe("synthetic_audit_failure");
    await client.query("ROLLBACK");
    expect(await envelopes()).toEqual(before);
    expect((await state()).master_key_epoch).toBe(sourceEpoch);
  } finally {
    client.release();
    await fixture.pool.query(
      "DROP TRIGGER test_vault_audit_failure ON subkit.audit_log; DROP FUNCTION subkit.test_vault_audit_failure()",
    );
  }
});

test("execute-only status returns the bound key marker and never grants runtime or table reads", async () => {
  expect((await maintenance.query("SELECT * FROM subkit.vault_maintenance_status()")).rows).toEqual(
    [{ key_epoch: String(sourceEpoch), key_digest: digest(oldKey) }],
  );
  expect(
    (await failure(() => runtime.query("SELECT * FROM subkit.vault_maintenance_status()")))?.code,
  ).toBe("42501");
  expect(
    (
      await failure(() =>
        maintenance.query("SELECT master_key_epoch FROM subkit.runtime_config_state"),
      )
    )?.code,
  ).toBe("42501");
  await fixture.pool.query(`GRANT EXECUTE ON FUNCTION ${statusSignature} TO PUBLIC`);
  try {
    expect(
      (await failure(() => maintenance.query("SELECT * FROM subkit.vault_maintenance_status()")))
        ?.message,
    ).toBe("vault_maintenance_capability_unavailable");
  } finally {
    await fixture.pool.query(`REVOKE EXECUTE ON FUNCTION ${statusSignature} FROM PUBLIC`);
  }
  await fixture.pool.query(`GRANT EXECUTE ON FUNCTION ${statusSignature} TO "${runtimeRole}"`);
  try {
    expect(
      (await failure(() => maintenance.query("SELECT * FROM subkit.vault_maintenance_status()")))
        ?.message,
    ).toBe("vault_maintenance_capability_unavailable");
  } finally {
    await fixture.pool.query(`REVOKE EXECUTE ON FUNCTION ${statusSignature} FROM "${runtimeRole}"`);
  }
});
async function insertGlobalEnvelope(name: string, key: Buffer) {
  const encrypted = encryptSecretBytesWithKey(
    key,
    Buffer.from([0, 255, 128, 17]),
    `runtime-secret:${name}:1`,
  );
  await fixture.pool.query(
    "INSERT INTO subkit.runtime_secret_versions(name,version,ciphertext,iv,auth_tag) VALUES($1,1,$2,$3,$4)",
    [name, encrypted.ciphertext, encrypted.iv, encrypted.auth_tag],
  );
}
test("execute-only client rewraps bounded mixed-key pages at full quota and repeats as a no-op", async () => {
  const baseline = await seed(129);
  await insertGlobalEnvelope("zz.already-current", newKey);
  const db = drizzle(maintenance, { schema });
  expect(await rewrapRegistryWithMaintenance(db, oldKey.toString("hex"), acknowledgement)).toEqual({
    names: 129,
    versions: 129,
  });
  const after = await envelopes();
  expect(after).toHaveLength(130);
  for (const row of after)
    expect(() =>
      decryptSecretBytesWithKey(newKey, row, `runtime-secret:${row.name}:${row.version}`),
    ).not.toThrow();
  const marker = await state();
  expect(marker.master_key_epoch).toBe(sourceEpoch + 1);
  const [usage] = await fixture.db
    .select()
    .from(hostedTenantUsage)
    .where(eq(hostedTenantUsage.tenant_id, tenantId));
  expect(usage?.logical_bytes).toBe(baseline.logical_bytes);
  expect(usage?.resource_counts).toEqual(baseline.resource_counts);
  const auditsBefore = (
    await fixture.pool.query(
      "SELECT id FROM subkit.audit_log WHERE action='secret.master_key_rewrapped'",
    )
  ).rows;
  expect(auditsBefore).toHaveLength(2);
  expect(await rewrapRegistryWithMaintenance(db, oldKey.toString("hex"), acknowledgement)).toEqual({
    names: 0,
    versions: 0,
  });
  expect(await envelopes()).toEqual(after);
  expect((await state()).master_key_epoch).toBe(marker.master_key_epoch);
  expect(
    (
      await fixture.pool.query(
        "SELECT id FROM subkit.audit_log WHERE action='secret.master_key_rewrapped'",
      )
    ).rows,
  ).toEqual(auditsBefore);
});
test("selected execute-only database dispatches maintenance vault operations without table reads", async () => {
  await seed();
  const ops = createVaultOps(drizzle(maintenance, { schema }), async () => {
    throw new Error("unexpected_preflight_read");
  });
  expect(
    await ops.rewrap(oldKey.toString("hex"), { ...acknowledgement, maintenance: true }),
  ).toEqual({ names: 1, versions: 1 });
  const rows = await envelopes();
  const row = rows[0];
  if (!row) throw new Error("expected registry fixture row missing");
  expect(
    decryptSecretBytesWithKey(newKey, row, `runtime-secret:${row.name}:${row.version}`),
  ).toEqual(Buffer.from([0, 255, 19, 0, 128]));
  expect((await state()).master_key_epoch).toBe(sourceEpoch + 1);
  expect(
    (await failure(() => maintenance.query("SELECT * FROM subkit.runtime_config_replicas")))?.code,
  ).toBe("42501");
});
test("unreadable later client page rolls back earlier rewritten pages, audits and epoch", async () => {
  await seed(129);
  await insertGlobalEnvelope("zz.unreadable-canary", Buffer.alloc(32, 83));
  const before = await envelopes();
  const db = drizzle(maintenance, { schema });
  const denied = await failure(() =>
    rewrapRegistryWithMaintenance(db, oldKey.toString("hex"), acknowledgement),
  );
  expect(denied?.message).toBe("rewrap_unreadable_version");
  expect(JSON.stringify(denied)).not.toContain("unreadable-canary");
  expect(await envelopes()).toEqual(before);
  expect((await state()).master_key_epoch).toBe(sourceEpoch);
  expect(
    (
      await fixture.pool.query(
        "SELECT id FROM subkit.audit_log WHERE action='secret.master_key_rewrapped'",
      )
    ).rows,
  ).toHaveLength(0);
});
test("execute-only client audit failure rolls back envelopes and returns no raw SQL payload", async () => {
  await seed();
  const before = await envelopes();
  await fixture.pool.query(
    "CREATE FUNCTION subkit.test_client_audit_failure() RETURNS trigger LANGUAGE plpgsql AS $$ BEGIN IF NEW.action='secret.master_key_rewrapped' THEN RAISE EXCEPTION 'private-audit-canary'; END IF; RETURN NEW; END $$; CREATE TRIGGER test_client_audit_failure BEFORE INSERT ON subkit.audit_log FOR EACH ROW EXECUTE FUNCTION subkit.test_client_audit_failure()",
  );
  try {
    const denied = await failure(() =>
      rewrapRegistryWithMaintenance(
        drizzle(maintenance, { schema }),
        oldKey.toString("hex"),
        acknowledgement,
      ),
    );
    expect(denied?.message).toBe("rewrap_maintenance_failed");
    expect(JSON.stringify(denied)).not.toContain("private-audit-canary");
    expect(await envelopes()).toEqual(before);
    expect((await state()).master_key_epoch).toBe(sourceEpoch);
  } finally {
    await fixture.pool.query(
      "DROP TRIGGER test_client_audit_failure ON subkit.audit_log; DROP FUNCTION subkit.test_client_audit_failure()",
    );
  }
});

test("forward migration preserves existing registry bytes and initializes an unbound key marker", async () => {
  const maintenanceMigration = EMBEDDED_MIGRATIONS.find((entry) =>
    entry.tag.endsWith("_vault_maintenance"),
  );
  if (!maintenanceMigration) throw new Error("maintenance migration missing");
  const historical = await createTestDb("vault-maintenance-forward", {
    upToIdx: maintenanceMigration.idx - 1,
  });
  const migration = createMigrationDbFromUrl(historical.url);
  try {
    await historical.pool.query("INSERT INTO subkit.runtime_config_state(key) VALUES('runtime')");
    const encrypted = encryptSecretBytesWithKey(
      oldKey,
      Buffer.from([0, 255, 128]),
      "runtime-secret:platform.fixture:1",
    );
    await historical.pool.query(
      "INSERT INTO subkit.runtime_secret_versions(name,version,ciphertext,iv,auth_tag) VALUES('platform.fixture',1,$1,$2,$3)",
      [encrypted.ciphertext, encrypted.iv, encrypted.auth_tag],
    );
    const before = (await historical.pool.query("SELECT * FROM subkit.runtime_secret_versions"))
      .rows;
    await runMigrations(migration.db, EMBEDDED_MIGRATIONS, true);
    expect(
      (await historical.pool.query("SELECT * FROM subkit.runtime_secret_versions")).rows,
    ).toEqual(before);
    const marker = (
      await historical.pool.query(
        "SELECT master_key_epoch,master_key_digest,vault_maintenance_binding,vault_maintenance_context FROM subkit.runtime_config_state WHERE key='runtime'",
      )
    ).rows[0];
    expect(marker).toEqual({
      master_key_epoch: "0",
      master_key_digest: null,
      vault_maintenance_binding: null,
      vault_maintenance_context: null,
    });
    expect(
      (
        await historical.pool.query(
          "SELECT EXISTS(SELECT 1 FROM pg_proc p CROSS JOIN LATERAL aclexplode(p.proacl) a WHERE p.oid=$1::regprocedure AND a.grantee=0 AND a.privilege_type='EXECUTE') AS allowed",
          [snapshotSignature],
        )
      ).rows[0].allowed,
    ).toBe(false);
  } finally {
    await migration.pool.end();
    await historical.cleanup();
  }
});
