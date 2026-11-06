import { afterAll, beforeAll, beforeEach, expect, test } from "bun:test";
import { and, asc, eq, sql } from "drizzle-orm";
import { AuditAction, SYSTEM_TENANT_ID } from "../../audit/index.ts";
import {
  decryptSecretBytesWithKey,
  decryptSecretWithKey,
  encryptSecretBytesWithKey,
  encryptSecretWithKey,
  parseMasterKeyHex,
} from "../../crypto/aes-gcm.ts";
import {
  auditLog,
  connectors,
  credentials,
  runtimeConfigReplicas,
  runtimeConfigState,
  runtimeSecretVersions,
  tenants,
} from "../../db/schema/index.ts";
import { createTestDb, TEST_DB_HOOK_TIMEOUT, type TestDb } from "../../db/tests/setup.ts";
import { getTestNow } from "../../test-helpers/determinism/clock.ts";
import { waitFor } from "../../test-helpers/determinism/wait.ts";
import { seedTenant } from "../../test-helpers/seed.ts";
import { syntheticVaultStopAcknowledgement } from "../../test-helpers/vault-maintenance.ts";
import { secretAad } from "../environment.ts";
import {
  _withRewrapBeforeWriteForTests,
  REWRAP_INVENTORY_PAGE_SIZE,
  rewrapMasterKey,
} from "../vault-ops.ts";

const targetHex = "41".repeat(32);
const previousHex = "42".repeat(32);
const targetKey = parseMasterKeyHex(targetHex);
const previousKey = parseMasterKeyHex(previousHex);
let ctx: TestDb;
let oldEnv: string | undefined;
let sequence = 0;

beforeAll(async () => {
  oldEnv = process.env.MASTER_KEY;
  process.env.MASTER_KEY = targetHex;
  ctx = await createTestDb("rewrap_atomicity");
}, TEST_DB_HOOK_TIMEOUT);
beforeEach(async () => {
  await ctx.db.delete(credentials);
  await ctx.db.delete(runtimeConfigState);
  await ctx.db.delete(runtimeConfigReplicas);
  await ctx.db.delete(runtimeSecretVersions);
  await ctx.db
    .delete(auditLog)
    .where(
      and(
        eq(auditLog.tenant_id, SYSTEM_TENANT_ID),
        eq(auditLog.action, AuditAction.MASTER_KEY_REWRAPPED),
      ),
    );
});
afterAll(async () => {
  if (oldEnv === undefined) delete process.env.MASTER_KEY;
  else process.env.MASTER_KEY = oldEnv;
  if (ctx) await ctx.cleanup();
}, TEST_DB_HOOK_TIMEOUT);

async function seed(
  name: string,
  bytes = new Uint8Array([0, 255, 195, 40, 128]),
  key = previousKey,
) {
  const payload = encryptSecretBytesWithKey(key, bytes, secretAad(name, 1));
  const [row] = await ctx.db
    .insert(runtimeSecretVersions)
    .values({ name, version: 1, ...payload })
    .returning();
  if (!row) throw new Error("missing secret fixture");
  return row;
}

function inventory() {
  return ctx.db
    .select()
    .from(runtimeSecretVersions)
    .orderBy(asc(runtimeSecretVersions.name), asc(runtimeSecretVersions.version));
}

function receipts() {
  return ctx.db
    .select()
    .from(auditLog)
    .where(
      and(
        eq(auditLog.tenant_id, SYSTEM_TENANT_ID),
        eq(auditLog.action, AuditAction.MASTER_KEY_REWRAPPED),
      ),
    );
}

test("raw invalid UTF-8 bytes survive rewrap with revoked and pending metadata intact", async () => {
  const bytes = new Uint8Array([0, 255, 195, 40, 128]);
  const row = await seed("settings.raw-bytes", bytes);
  await ctx.db
    .update(runtimeSecretVersions)
    .set({
      revoked_at: new Date(getTestNow()),
      pending_since: new Date(getTestNow()),
      prepared_by: "synthetic fixture",
      pending_bindings: ["llm.providers.openai.api_key"],
    })
    .where(eq(runtimeSecretVersions.name, row.name));
  const [before] = await inventory();
  expect(await rewrapMasterKey(ctx.db, previousHex, syntheticVaultStopAcknowledgement)).toEqual({
    names: 1,
    versions: 1,
  });
  const [after] = await inventory();
  if (!before || !after) throw new Error("missing rewritten fixture");
  expect(decryptSecretBytesWithKey(targetKey, after, secretAad(row.name, 1))).toEqual(bytes);
  expect({
    ...after,
    ciphertext: before.ciphertext,
    iv: before.iv,
    auth_tag: before.auth_tag,
  }).toEqual(before);
  expect(after.ciphertext.length).toBe(before.ciphertext.length);
  const audit = await receipts();
  expect(audit).toHaveLength(1);
  expect(audit[0]?.metadata).toHaveProperty(
    "evidence_sha256",
    expect.stringMatching(/^[a-f0-9]{64}$/),
  );
  expect(JSON.stringify(audit)).not.toContain(syntheticVaultStopAcknowledgement.evidence);
});

test("the bounded keyset walk includes every retained page and target-key rows remain a no-op", async () => {
  for (let i = 0; i < REWRAP_INVENTORY_PAGE_SIZE + 1; i++)
    await seed(`settings.page.${String(i).padStart(4, "0")}`, new Uint8Array([i % 256]));
  const target = await seed("settings.target", new Uint8Array([17]), targetKey);
  expect(await rewrapMasterKey(ctx.db, previousHex, syntheticVaultStopAcknowledgement)).toEqual({
    names: 129,
    versions: 129,
  });
  const [unchanged] = await ctx.db
    .select()
    .from(runtimeSecretVersions)
    .where(eq(runtimeSecretVersions.name, target.name));
  expect(unchanged).toEqual(target);
  expect(await rewrapMasterKey(ctx.db, previousHex, syntheticVaultStopAcknowledgement)).toEqual({
    names: 0,
    versions: 0,
  });
  expect(await receipts()).toHaveLength(2);
});

test("a later unreadable third-key version rolls back earlier ciphertext changes and aggregate audit", async () => {
  await seed("settings.a-good");
  await seed("settings.z-third", new Uint8Array([2]), parseMasterKeyHex("43".repeat(32)));
  const before = await inventory();
  await expect(
    rewrapMasterKey(ctx.db, previousHex, syntheticVaultStopAcknowledgement),
  ).rejects.toThrow("decrypts under neither");
  expect(await inventory()).toEqual(before);
  expect(await receipts()).toHaveLength(0);
});

test("an old-cipher mismatch causes CAS refusal and rolls back every replacement", async () => {
  const first = await seed("settings.a-before-conflict");
  const conflicted = await seed("settings.z-conflict");
  const concurrent = encryptSecretBytesWithKey(
    previousKey,
    new Uint8Array([77]),
    secretAad(conflicted.name, 1),
  );
  let calls = 0;
  await _withRewrapBeforeWriteForTests(
    async (tx) => {
      calls++;
      if (calls !== 2) return;
      await tx
        .update(runtimeSecretVersions)
        .set(concurrent)
        .where(
          and(
            eq(runtimeSecretVersions.name, conflicted.name),
            eq(runtimeSecretVersions.version, 1),
          ),
        );
    },
    async () => {
      await expect(
        rewrapMasterKey(ctx.db, previousHex, syntheticVaultStopAcknowledgement),
      ).rejects.toThrow("rewrap_ciphertext_changed");
    },
  );
  const [afterFirst] = await ctx.db
    .select()
    .from(runtimeSecretVersions)
    .where(eq(runtimeSecretVersions.name, first.name));
  const [afterConflict] = await ctx.db
    .select()
    .from(runtimeSecretVersions)
    .where(eq(runtimeSecretVersions.name, conflicted.name));
  expect(afterFirst).toEqual(first);
  expect(afterConflict).toEqual(conflicted);
  expect(await receipts()).toHaveLength(0);
});

test("mandatory audit failure rolls back the entire rewrap transaction", async () => {
  await seed("settings.audit-rollback");
  const before = await inventory();
  await ctx.db.execute(
    sql.raw(
      "CREATE FUNCTION subkit.reject_rewrap_audit() RETURNS trigger LANGUAGE plpgsql AS $$ BEGIN IF NEW.action='secret.master_key_rewrapped' THEN RAISE EXCEPTION 'synthetic_audit_failure'; END IF; RETURN NEW; END $$; CREATE TRIGGER reject_rewrap_audit BEFORE INSERT ON subkit.audit_log FOR EACH ROW EXECUTE FUNCTION subkit.reject_rewrap_audit()",
    ),
  );
  try {
    await expect(
      rewrapMasterKey(ctx.db, previousHex, syntheticVaultStopAcknowledgement),
    ).rejects.toThrow();
    expect(await inventory()).toEqual(before);
    expect(await receipts()).toHaveLength(0);
  } finally {
    await ctx.db.execute(
      sql.raw(
        "DROP TRIGGER reject_rewrap_audit ON subkit.audit_log; DROP FUNCTION subkit.reject_rewrap_audit()",
      ),
    );
  }
});

test("direct domain rewrap refuses a healthy replica without the CLI wrapper", async () => {
  await seed("settings.serving-refusal");
  const before = await inventory();
  await ctx.db.insert(runtimeConfigReplicas).values({
    instance_id: "synthetic-serving",
    product_version: "fixture",
    last_seen_at: new Date(getTestNow()),
  });
  await expect(
    rewrapMasterKey(ctx.db, previousHex, syntheticVaultStopAcknowledgement),
  ).rejects.toThrow("rewrap_serving_replicas");
  expect(await inventory()).toEqual(before);
  expect(await receipts()).toHaveLength(0);
});

test("inactive owners remain refused and earlier global replacements are rolled back", async () => {
  await seed("a-global");
  const owner = await seedTenant(ctx.db, {
    slug: `rewrap-inactive-${++sequence}`,
    display_name: "Inactive owner",
  });
  await seed(`connection.${owner.id}.fixture.access_token`);
  await ctx.db.update(tenants).set({ status: "suspended" }).where(eq(tenants.id, owner.id));
  const before = await inventory();
  await expect(
    rewrapMasterKey(ctx.db, previousHex, syntheticVaultStopAcknowledgement),
  ).rejects.toThrow("rewrap_inactive_owner_requires_maintenance");
  expect(await inventory()).toEqual(before);
  expect(await receipts()).toHaveLength(0);
});

test("active self-hosted owned secrets retain the existing UTF-8 string API", async () => {
  const owner = await seedTenant(ctx.db, {
    slug: `rewrap-active-${++sequence}`,
    display_name: "Active owner",
  });
  const name = `connection.${owner.id}.fixture.access_token`;
  const value = "synthetic-UTF8-🔐";
  const payload = encryptSecretWithKey(previousKey, value, secretAad(name, 1));
  await ctx.db.insert(runtimeSecretVersions).values({ name, version: 1, ...payload });
  expect(await rewrapMasterKey(ctx.db, previousHex, syntheticVaultStopAcknowledgement)).toEqual({
    names: 1,
    versions: 1,
  });
  const [row] = await inventory();
  if (!row) throw new Error("missing active fixture");
  expect(decryptSecretWithKey(targetKey, row, secretAad(name, 1))).toBe(value);
  expect(row.tenant_id).toBe(owner.id);
});

test("domain acknowledgement and evidence validation refuse before key parsing or writes", async () => {
  await seed("settings.missing-proof");
  const before = await inventory();
  await expect(rewrapMasterKey(ctx.db, "not-a-key", undefined as never)).rejects.toThrow(
    "rewrap_all_producers_stopped_acknowledgement_required",
  );
  await expect(
    rewrapMasterKey(ctx.db, "not-a-key", { all_producers_stopped: true, evidence: "invalid" }),
  ).rejects.toThrow("rewrap_stop_evidence_invalid");
  expect(await inventory()).toEqual(before);
  expect(await receipts()).toHaveLength(0);
});

test("retained credential ciphertext refuses settings-only rewrite and key promotion without exposing stock", async () => {
  await seed("settings.unsupported-stock");
  const owner = await seedTenant(ctx.db, {
    slug: `rewrap-stock-${++sequence}`,
    display_name: "Synthetic stock owner",
  });
  const [connector] = await ctx.db
    .insert(connectors)
    .values({
      tenant_id: owner.id,
      slug: "unsupported-fixture",
      display_name: "Synthetic credential",
      driver: "http",
      environment: "dev",
      auth_type: "header",
      base_url: "https://example.test",
    })
    .returning();
  if (!connector) throw new Error("missing stock connector");
  const canary = "unsupported-stock-private-content-canary";
  await ctx.db.insert(credentials).values({
    tenant_id: owner.id,
    connector_id: connector.id,
    environment: "dev",
    mode: "header",
    ciphertext: Buffer.from(canary),
    iv: Buffer.alloc(12),
    auth_tag: Buffer.alloc(16),
  });
  const before = await inventory();
  let message = "";
  try {
    await rewrapMasterKey(ctx.db, previousHex, syntheticVaultStopAcknowledgement);
  } catch (error) {
    message = error instanceof Error ? error.message : String(error);
  }
  expect(message).toContain("Settings-only rewrap");
  expect(message).not.toContain(canary);
  expect(message).not.toContain(connector.id);
  expect(message).not.toContain(owner.id);
  expect(await inventory()).toEqual(before);
  expect(await receipts()).toHaveLength(0);
  expect(await ctx.db.select().from(runtimeConfigState)).toHaveLength(0);
});

test("registry stock freezing blocks an actual concurrent writer until the complete transaction commits", async () => {
  const row = await seed("settings.writer-freeze");
  const external = await ctx.pool.connect();
  const identity = await external.query<{ pid: number }>("select pg_backend_pid() as pid");
  const pid = identity.rows[0]?.pid;
  if (!pid) {
    external.release();
    throw new Error("missing concurrent backend");
  }
  let update: Promise<unknown> | undefined;
  let completed = false;
  try {
    await _withRewrapBeforeWriteForTests(
      async () => {
        update = external
          .query(
            "update subkit.runtime_secret_versions set revoked_at=now() where name=$1 and version=1",
            [row.name],
          )
          .then((value) => {
            completed = true;
            return value;
          });
        await waitFor(async () => {
          const blocked = await ctx.db.execute<{ blocked: boolean }>(
            sql`select exists(select 1 from pg_catalog.pg_locks where pid=${pid} and not granted) as blocked`,
          );
          return blocked.rows[0]?.blocked === true;
        });
        expect(completed).toBe(false);
      },
      async () => {
        expect(
          await rewrapMasterKey(ctx.db, previousHex, syntheticVaultStopAcknowledgement),
        ).toEqual({ names: 1, versions: 1 });
      },
    );
    await update;
    expect(completed).toBe(true);
    const [rewritten] = await inventory();
    if (!rewritten) throw new Error("missing rewritten freeze fixture");
    expect(decryptSecretBytesWithKey(targetKey, rewritten, secretAad(row.name, 1))).toEqual(
      new Uint8Array([0, 255, 195, 40, 128]),
    );
  } finally {
    external.release();
  }
});
