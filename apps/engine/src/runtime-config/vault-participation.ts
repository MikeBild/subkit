import { createHash } from "node:crypto";
import { eq, ne, sql } from "drizzle-orm";
import { activeMasterKeyDigest } from "../crypto/aes-gcm.ts";
import type { Db, Executor } from "../db/client.ts";
import {
  hostedWorkAdmissions,
  runtimeConfigReplicas,
  runtimeConfigState,
} from "../db/schema/index.ts";
import { CONFIG_STATE_KEY } from "./contracts.ts";
import { hasColumn } from "./secret-columns.ts";
import { ensureRuntimeState } from "./state-columns.ts";

export class VaultParticipationError extends Error {
  constructor(
    readonly code:
      | "vault_maintenance_in_progress"
      | "vault_master_key_mismatch"
      | "vault_producers_unresolved",
  ) {
    super(code);
  }
}

export async function lockVaultParticipation(tx: Executor): Promise<void> {
  const result = await tx.execute<{ locked: boolean }>(
    sql`SELECT pg_try_advisory_xact_lock_shared(hashtextextended('subkit.runtime.vault-maintenance',0)) AS locked`,
  );
  if (result.rows[0]?.locked !== true)
    throw new VaultParticipationError("vault_maintenance_in_progress");
}

export async function lockVaultMaintenance(tx: Executor): Promise<void> {
  const result = await tx.execute<{ locked: boolean }>(
    sql`SELECT pg_try_advisory_xact_lock(hashtextextended('subkit.runtime.vault-maintenance',0)) AS locked`,
  );
  if (result.rows[0]?.locked !== true)
    throw new VaultParticipationError("vault_maintenance_in_progress");
}

export function withVaultStartupGate<T>(
  db: Db,
  operation: (tx: Executor) => Promise<T>,
): Promise<T> {
  return db.transaction(async (tx) => {
    await lockVaultParticipation(tx);
    return operation(tx);
  });
}

export async function assertVaultMasterKey(tx: Executor): Promise<void> {
  if (!(await hasColumn(tx, "runtime_config_state", "master_key_digest"))) return;
  // tenant-filter:exempt — the master-key pin belongs to the product-wide runtime state.
  const [state] = await tx
    .select({ digest: runtimeConfigState.master_key_digest })
    .from(runtimeConfigState)
    .where(eq(runtimeConfigState.key, CONFIG_STATE_KEY))
    .limit(1);
  if (state?.digest != null && state.digest !== activeMasterKeyDigest())
    throw new VaultParticipationError("vault_master_key_mismatch");
}

export async function pinVaultMasterKey(tx: Executor): Promise<void> {
  await ensureRuntimeState(tx);
  // tenant-filter:exempt — bootstrap pins the selected engine key in the single global state row.
  const [state] = await tx
    .select({ digest: runtimeConfigState.master_key_digest })
    .from(runtimeConfigState)
    .where(eq(runtimeConfigState.key, CONFIG_STATE_KEY))
    .for("update")
    .limit(1);
  if (!state) throw new Error("runtime_config_state_missing");
  const digest = activeMasterKeyDigest();
  if (state.digest !== null && state.digest !== digest)
    throw new VaultParticipationError("vault_master_key_mismatch");
  if (state.digest === null)
    await tx
      .update(runtimeConfigState)
      .set({ master_key_digest: digest })
      .where(eq(runtimeConfigState.key, CONFIG_STATE_KEY));
}

export async function assertVaultProducersStopped(tx: Executor): Promise<void> {
  // tenant-filter:exempt — maintenance refuses every retained global boot registration, including stale ones.
  const replicas = await tx
    .select({ instance_id: runtimeConfigReplicas.instance_id })
    .from(runtimeConfigReplicas)
    .limit(1);
  if (replicas.length > 0) throw new VaultParticipationError("vault_producers_unresolved");
  if (await hasColumn(tx, "hosted_work_admissions", "state")) {
    // tenant-filter:exempt — offline key maintenance requires all product work admissions to be settled.
    const work = await tx
      .select({ id: hostedWorkAdmissions.id })
      .from(hostedWorkAdmissions)
      .where(ne(hostedWorkAdmissions.state, "released"))
      .limit(1);
    if (work.length > 0) throw new VaultParticipationError("vault_producers_unresolved");
  }
}

export async function completeRegistryRewrapEpoch(
  tx: Executor,
  targetKey: Uint8Array,
): Promise<void> {
  if (!(await hasColumn(tx, "runtime_config_state", "master_key_digest"))) return;
  await ensureRuntimeState(tx);
  // tenant-filter:exempt — a completed offline registry operation atomically updates its global key pin.
  const [state] = await tx
    .select({
      epoch: runtimeConfigState.master_key_epoch,
      digest: runtimeConfigState.master_key_digest,
    })
    .from(runtimeConfigState)
    .where(eq(runtimeConfigState.key, CONFIG_STATE_KEY))
    .for("update")
    .limit(1);
  if (!state) throw new Error("runtime_config_state_missing");
  const digest = createHash("sha256").update(targetKey).digest("hex");
  if (state.digest === digest) return;
  await tx
    .update(runtimeConfigState)
    .set({
      master_key_digest: digest,
      master_key_epoch: state.digest === null ? state.epoch : state.epoch + 1,
    })
    .where(eq(runtimeConfigState.key, CONFIG_STATE_KEY));
}
