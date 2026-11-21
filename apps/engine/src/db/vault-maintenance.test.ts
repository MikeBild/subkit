import { expect, test } from "bun:test";
import { eq } from "drizzle-orm";
import { decryptSecretBytesWithKey } from "../crypto/index.ts";
import { EMBEDDED_MIGRATIONS } from "./migrations/embedded.ts";
import { auditLog, hostedTenantUsage } from "./schema/index.ts";
import {
  apply,
  digest,
  envelopes,
  evidence,
  failure,
  fixture,
  ids,
  maintenance,
  maintenanceRole,
  newKey,
  oldKey,
  replacements,
  runtime,
  runtimeRole,
  type SnapshotRow,
  seed,
  snapshot,
  snapshotSignature,
  sourceEpoch,
  state,
  tenantId,
  useVaultMaintenanceDb,
} from "./vault-maintenance-fixtures.ts";

useVaultMaintenanceDb();

test("embedded migrations create no role and grant no maintenance execution", async () => {
  const source = EMBEDDED_MIGRATIONS.flatMap((migration) => migration.statements).join("\n");
  expect(source).toContain("REVOKE ALL ON FUNCTION subkit.vault_maintenance_status() FROM PUBLIC");
  expect(source).not.toContain("CREATE ROLE");
  expect(source).not.toContain("GRANT EXECUTE");
  expect(
    (
      await fixture.pool.query(
        "SELECT EXISTS(SELECT 1 FROM pg_proc p CROSS JOIN LATERAL aclexplode(p.proacl) a WHERE p.oid=$1::regprocedure AND a.grantee=0 AND a.privilege_type='EXECUTE') AS allowed",
        [snapshotSignature],
      )
    ).rows[0].allowed,
  ).toBe(false);
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
