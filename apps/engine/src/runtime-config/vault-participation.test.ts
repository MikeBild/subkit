import { afterAll, beforeAll, expect, test } from "bun:test";
import { eq, sql } from "drizzle-orm";
import { activeMasterKeyDigest } from "../crypto/aes-gcm.ts";
import { runtimeConfigReplicas, runtimeConfigState } from "../db/schema/index.ts";
import { createTestDb, type TestDb } from "../db/tests/setup.ts";
import { assertRegistryRewrapScope } from "../preflight/rewrap-stock.ts";
import { FROZEN_NOW } from "../test-helpers/determinism/clock.ts";
import { type EnvHandle, withTestEnv } from "../test-helpers/determinism/env.ts";
import {
  assertVaultMasterKey,
  assertVaultProducersStopped,
  completeRegistryRewrapEpoch,
  lockVaultMaintenance,
  pinVaultMasterKey,
  withVaultStartupGate,
} from "./vault-participation.ts";

let fixture: TestDb;
let environment: EnvHandle;

beforeAll(async () => {
  environment = withTestEnv({ MASTER_KEY: "76".repeat(32) });
  fixture = await createTestDb("vault-participation");
});

afterAll(async () => {
  environment.restore();
  await fixture.cleanup();
});

test("startup holds the shared gate until its key pin and registration commit together", async () => {
  let finish: (() => void) | undefined;
  let entered: (() => void) | undefined;
  const reached = new Promise<void>((resolve) => {
    entered = resolve;
  });
  const held = new Promise<void>((resolve) => {
    finish = resolve;
  });
  const startup = withVaultStartupGate(fixture.db, async (tx) => {
    await pinVaultMasterKey(tx);
    await tx
      .insert(runtimeConfigReplicas)
      .values({ instance_id: "starting-fixture", product_version: "test" });
    entered?.();
    await held;
  });
  try {
    await reached;
    await expect(fixture.db.transaction((tx) => lockVaultMaintenance(tx))).rejects.toMatchObject({
      code: "vault_maintenance_in_progress",
    });
    expect(await fixture.db.select().from(runtimeConfigReplicas)).toHaveLength(0);
  } finally {
    finish?.();
    await startup;
  }
  const [state] = await fixture.db.select().from(runtimeConfigState);
  expect(state?.master_key_digest).toBe(activeMasterKeyDigest());
  expect(state?.master_key_epoch).toBe(0);
  expect(await fixture.db.select().from(runtimeConfigReplicas)).toHaveLength(1);
  await fixture.db
    .delete(runtimeConfigReplicas)
    .where(eq(runtimeConfigReplicas.instance_id, "starting-fixture"));
});

test("an exclusive maintenance gate rejects a new startup before its writes", async () => {
  let entered = false;
  await fixture.db.transaction(async (tx) => {
    await lockVaultMaintenance(tx);
    await expect(
      withVaultStartupGate(fixture.db, async () => {
        entered = true;
      }),
    ).rejects.toMatchObject({ code: "vault_maintenance_in_progress" });
    expect(entered).toBe(false);
  });
});

test("stale registrations remain unresolved producer evidence", async () => {
  await fixture.db.insert(runtimeConfigReplicas).values({
    instance_id: "stale-fixture",
    product_version: "test",
    last_seen_at: new Date(FROZEN_NOW),
  });
  try {
    await expect(
      fixture.db.transaction(async (tx) => {
        await lockVaultMaintenance(tx);
        await assertVaultProducersStopped(tx);
      }),
    ).rejects.toMatchObject({ code: "vault_producers_unresolved" });
    expect(await fixture.db.select().from(runtimeConfigReplicas)).toHaveLength(1);
  } finally {
    await fixture.db
      .delete(runtimeConfigReplicas)
      .where(eq(runtimeConfigReplicas.instance_id, "stale-fixture"));
  }
});

test("empty-registry maintenance advances the pin and refuses an obsolete cached process key", async () => {
  await fixture.db.transaction(async (tx) => {
    await lockVaultMaintenance(tx);
    await assertVaultProducersStopped(tx);
    await assertRegistryRewrapScope(tx);
    await tx.execute(sql`LOCK TABLE subkit.runtime_secret_versions IN SHARE ROW EXCLUSIVE MODE`);
    await completeRegistryRewrapEpoch(tx, Buffer.from("87".repeat(32), "hex"));
  });
  const [state] = await fixture.db.select().from(runtimeConfigState);
  expect(state?.master_key_epoch).toBe(1);
  expect(state?.master_key_digest).not.toBe(activeMasterKeyDigest());
  let writerEntered = false;
  await expect(
    withVaultStartupGate(fixture.db, async (tx) => {
      await assertVaultMasterKey(tx);
      writerEntered = true;
    }),
  ).rejects.toMatchObject({ code: "vault_master_key_mismatch" });
  expect(writerEntered).toBe(false);
});
