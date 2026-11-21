import { expect, test } from "bun:test";
import { eq } from "drizzle-orm";
import { drizzle } from "drizzle-orm/node-postgres";
import { decryptSecretBytesWithKey, encryptSecretBytesWithKey } from "../crypto/index.ts";
import { createVaultOps, rewrapRegistryWithMaintenance } from "../preflight/index.ts";
import * as schema from "./schema/index.ts";
import { hostedTenantUsage } from "./schema/index.ts";
import {
  apply,
  binding,
  digest,
  envelopes,
  failure,
  fixture,
  ids,
  maintenance,
  maintenanceRole,
  newKey,
  oldKey,
  runtime,
  runtimeRole,
  seed,
  snapshot,
  snapshotSignature,
  sourceEpoch,
  state,
  statusSignature,
  tenantId,
  useVaultMaintenanceDb,
} from "./vault-maintenance-fixtures.ts";
import { VAULT_STOCK_TABLES } from "./vault-stock-sql.ts";

const acknowledgement = {
  all_producers_stopped: true as const,
  evidence:
    "All engine workers, application replicas, scheduled processes, command-line credential writers and remote automation origins were individually stopped and reviewed before this operation.",
};

useVaultMaintenanceDb();

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
