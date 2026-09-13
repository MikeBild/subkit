// The production `VaultOps` — the only place the host-side commands touch
// the database, the crypto or the audit log.
//
// SubKit's vault is `runtime_secret_versions`: immutable, monotonically
// versioned rows addressed as `secret://<name>/<version>`, each encrypted
// with AES-256-GCM under the AAD `runtime-secret:<name>:<version>`. That
// shape decides two things about these operations:
//
//   * `--vault-set` MINTS a new version rather than overwriting one. The
//     versions are immutable and a stored revision holds the literal
//     reference string, so overwriting would silently change what an
//     existing revision resolves to.
//   * `--rewrap-master-key` does the opposite: it rewrites `ciphertext`,
//     `iv` and `auth_tag` IN PLACE for every existing `(name, version)`,
//     preserving the AAD. Minting new versions there would orphan every
//     `secret://name/version` the active revision holds.
//
// The whole rewrap is one transaction. A sweep that stopped half way would
// leave rows split across two keys with no record of which is which, and
// there is no way back from that but a backup.

import { createHash } from "node:crypto";

import { and, asc, desc, eq, gte } from "drizzle-orm";

import { auditAwait } from "../audit/audit.ts";
import { AuditAction, SYSTEM_TENANT_ID } from "../audit/types.ts";
import {
  decryptSecret,
  decryptSecretWithKey,
  encryptSecretWithKey,
  parseMasterKeyHex,
} from "../crypto/aes-gcm.ts";
import type { Db } from "../db/client.ts";
import {
  runtimeConfigReplicas,
  runtimeConfigRevisions,
  runtimeConfigState,
  runtimeSecretVersions,
} from "../db/schema/index.ts";
import { logger } from "../logging/logger.ts";
import { CONFIG_STATE_KEY, REPLICA_LEASE_MS } from "../runtime-config/contracts.ts";
import {
  hasPendingSecretColumns,
  secretVersionProjection,
} from "../runtime-config/secret-columns.ts";
import {
  createSecretVersion,
  getRuntimeConfigState,
  saveRuntimeConfigPatch,
  secretReference,
} from "../runtime-config/service.ts";
import { secretAad } from "./environment.ts";
import type { Rebound, VaultOps, VersionProbe } from "./vault-cli.ts";

/** First 8 hex of sha256(key) — the same fingerprint shape `crypto.key.loaded` logs. */
function keyFingerprint(keyHex: string): string {
  return createHash("sha256").update(Buffer.from(keyHex, "hex")).digest("hex").slice(0, 8);
}

export async function probeCurrentVersion(db: Db, name: string): Promise<VersionProbe> {
  // This runs on the host against a schema that may be one release old, so
  // the prepared-version column is read only where it exists.
  const projection = await secretVersionProjection(db);
  // tenant-filter:exempt — secret names and versions are product-global operator state.
  const found = await db
    .select(projection.columns)
    .from(runtimeSecretVersions)
    .where(eq(runtimeSecretVersions.name, name))
    .orderBy(desc(runtimeSecretVersions.version));
  const rows = found.map(projection.complete);
  if (rows.length === 0) return { version: null, readable: false, absent: true };
  // A prepared version is not current until a person approves it.
  const current = rows.find((row) => row.revoked_at === null && row.pending_since === null);
  if (!current) return { version: null, readable: false, absent: false };
  try {
    decryptSecret(
      { ciphertext: current.ciphertext, iv: current.iv, auth_tag: current.auth_tag },
      secretAad(name, current.version),
    );
    return { version: current.version, readable: true, absent: false };
  } catch {
    return { version: current.version, readable: false, absent: false };
  }
}

/**
 * Instance ids whose replica lease is still healthy — the same window the
 * activation coordinator uses (`REPLICA_LEASE_MS`), so "serving" means the
 * same thing here as it does there rather than being a second opinion.
 */
export async function servingReplicas(db: Db): Promise<string[]> {
  const cutoff = new Date(Date.now() - REPLICA_LEASE_MS);
  // tenant-filter:exempt — replica leases are product-global runtime state.
  const rows = await db
    .select({ instance_id: runtimeConfigReplicas.instance_id })
    .from(runtimeConfigReplicas)
    .where(gte(runtimeConfigReplicas.last_seen_at, cutoff));
  return rows.map((row) => row.instance_id).sort();
}

/**
 * Re-encrypt every stored version under the running MASTER_KEY, reading
 * with `previousKeyHex`. A version that already decrypts under the running
 * key is left untouched — a rewrap must be re-runnable after an interrupted
 * one without needing to know how far the first got.
 *
 * Revoked versions are included: a revoked version is retained history, and
 * leaving it behind under the old key would make it unreadable forever.
 */
export async function rewrapMasterKey(
  db: Db,
  previousKeyHex: string,
): Promise<{ names: number; versions: number }> {
  const previousKey = parseMasterKeyHex(previousKeyHex);
  const runningHex = process.env.MASTER_KEY ?? "";
  const runningKey = parseMasterKeyHex(runningHex);
  if (previousKey.equals(runningKey)) {
    throw new Error("the previous key and the running MASTER_KEY are the same — nothing to rewrap");
  }

  const report = await db.transaction(async (tx) => {
    // Only what the rewrap needs, spelled out: this runs before this
    // release's migrations, and a `select()` would name columns the
    // previous schema does not have.
    // tenant-filter:exempt — the secret registry is product-global operator state.
    const rows = await tx
      .select({
        name: runtimeSecretVersions.name,
        version: runtimeSecretVersions.version,
        ciphertext: runtimeSecretVersions.ciphertext,
        iv: runtimeSecretVersions.iv,
        auth_tag: runtimeSecretVersions.auth_tag,
      })
      .from(runtimeSecretVersions)
      .orderBy(asc(runtimeSecretVersions.name), asc(runtimeSecretVersions.version));

    const names = new Set<string>();
    let versions = 0;
    for (const row of rows) {
      const aad = secretAad(row.name, row.version);
      const payload = { ciphertext: row.ciphertext, iv: row.iv, auth_tag: row.auth_tag };
      let plaintext: string;
      try {
        // Already under the running key: a re-run of an interrupted sweep.
        decryptSecretWithKey(runningKey, payload, aad);
        continue;
      } catch {
        /* not under the running key — try the previous one */
      }
      try {
        plaintext = decryptSecretWithKey(previousKey, payload, aad);
      } catch (error) {
        // Refuse the whole sweep. A partial rewrap is unrecoverable, and a
        // version that decrypts under neither key names a THIRD key the
        // operator has not supplied — that is a fact to report, not to
        // work around.
        throw new Error(
          `${row.name}/${row.version} decrypts under neither the running MASTER_KEY nor the key in --from-file; nothing was changed (${error instanceof Error ? error.message : String(error)})`,
          { cause: error },
        );
      }
      const reencrypted = encryptSecretWithKey(runningKey, plaintext, aad);
      await tx
        .update(runtimeSecretVersions)
        .set({
          ciphertext: reencrypted.ciphertext,
          iv: reencrypted.iv,
          auth_tag: reencrypted.auth_tag,
        })
        .where(
          and(
            eq(runtimeSecretVersions.name, row.name),
            eq(runtimeSecretVersions.version, row.version),
          ),
        );
      names.add(row.name);
      versions += 1;
    }
    return { names: names.size, versions };
  });

  await auditAwait(
    {
      tenant_id: SYSTEM_TENANT_ID,
      actor_type: "system",
      actor_id: null,
      action: AuditAction.MASTER_KEY_REWRAPPED,
      resource_type: "runtime_secret",
      resource_id: "*",
      result: "success",
      metadata: {
        names: report.names,
        versions: report.versions,
        from_key_fingerprint: keyFingerprint(previousKeyHex),
        to_key_fingerprint: keyFingerprint(runningHex),
      },
    },
    db,
  );

  return report;
}

/**
 * Re-point one dotted settings path at `secret://<name>/<version>` and make
 * that the ACTIVE revision.
 *
 * The activation is the load-bearing half. `saveRuntimeConfigPatch` writes a
 * revision with status `saved` and moves `desired_revision` only; the
 * preflight — and every boot — reads `active_revision`. A re-pin that
 * stopped at "saved" would print `pinned to … version 3` and leave the
 * engine refusing on the old version, which is the deadlock this command
 * exists to break, with a success line on top of it.
 *
 * The normal activation path is not available here and should not be: it
 * either requires a healthy replica to prepare and ACK, or defers to the
 * next boot via `restart_required`. Neither fits a host shell fixing a
 * process that cannot start. So the pointer is written directly, under the
 * same precondition that makes it safe and that `--rewrap-master-key`
 * already uses: nothing is serving. With a live replica this refuses and
 * says so, because a replica holding the old snapshot must be told to
 * prepare, not overtaken.
 *
 * Global scope only: a tenant overlay is re-pinned through the settings API
 * by someone who can name the tenant, and guessing at one from a host shell
 * is how the wrong tenant gets rewritten.
 */
export async function rebindSettingPath(
  db: Db,
  path: string,
  name: string,
  version: number,
): Promise<Rebound> {
  const serving = await servingReplicas(db);
  if (serving.length > 0) {
    throw new Error(
      `the engine is still serving (${serving.length} replica lease(s): ${serving.slice(0, 3).join(", ")}); stop it, or re-pin through the settings API where replicas are coordinated`,
    );
  }

  const state = await getRuntimeConfigState(db);
  const saved = await saveRuntimeConfigPatch(db, {
    expected_revision: state.saved_revision,
    changes: { [path]: secretReference(name, version) },
    scope: "global",
    created_by: null,
  });

  await activateRevisionOnHost(db, saved.saved_revision);
  return { path, name, version };
}

/**
 * Point `runtime_config_state.active_revision` at a saved revision, the way
 * `initializeRuntimeConfig` does for a `restart_required` one when no
 * replica lease is healthy. Re-checks the lease inside the transaction, so
 * a replica that came back between the check above and here loses the race
 * rather than being overtaken.
 */
async function activateRevisionOnHost(db: Db, revision: number): Promise<void> {
  await db.transaction(async (tx) => {
    // tenant-filter:exempt — the canonical active pointer is product-global.
    const [state] = await tx
      .select()
      .from(runtimeConfigState)
      .where(eq(runtimeConfigState.key, CONFIG_STATE_KEY))
      .for("update");
    if (!state) throw new Error("runtime config is not initialized");
    if (state.desired_revision !== revision) {
      throw new Error(
        `revision ${revision} is no longer the saved revision (${state.desired_revision}); someone else saved settings in between`,
      );
    }
    const cutoff = new Date(Date.now() - REPLICA_LEASE_MS);
    // tenant-filter:exempt — replica leases are product-global runtime state.
    const healthy = await tx
      .select({ instance_id: runtimeConfigReplicas.instance_id })
      .from(runtimeConfigReplicas)
      .where(gte(runtimeConfigReplicas.last_seen_at, cutoff))
      .limit(1);
    if (healthy.length > 0) {
      throw new Error("a replica lease became healthy during the re-pin; nothing was activated");
    }
    const activatedAt = new Date();
    await tx
      .update(runtimeConfigRevisions)
      .set({ status: "active", activated_at: activatedAt, failure_reason: null })
      .where(eq(runtimeConfigRevisions.revision, revision));
    await tx
      .update(runtimeConfigState)
      .set({ active_revision: revision, updated_at: activatedAt })
      .where(eq(runtimeConfigState.key, CONFIG_STATE_KEY));
  });
}

/** The production wiring. `preflight` is injected so this module stays free of the check set. */
export function createVaultOps(
  db: Db,
  preflight: () => Promise<{ exitCode: 0 | 1 | 3; lines: string[] }>,
): VaultOps {
  return {
    probeCurrentVersion: (name) => probeCurrentVersion(db, name),
    createVersion: async (name, value, purpose) => {
      const created = await createSecretVersion(db, { name, value, created_by: null });
      await auditAwait(
        {
          tenant_id: SYSTEM_TENANT_ID,
          actor_type: "system",
          actor_id: null,
          action: AuditAction.SECRET_VERSION_CREATED,
          resource_type: "runtime_secret",
          resource_id: created.reference,
          result: "success",
          // `runtime_secret_versions` has no description column and this
          // release adds no migration, so `--purpose` lives in the audit
          // row. That is where an operator asking "why does this version
          // exist" will look anyway.
          metadata: { name, version: created.version, purpose },
        },
        db,
      );
      logger.info({
        module: "preflight",
        action: "vault.version_created",
        msg: "host-side rotation minted a runtime secret version",
        name,
        version: created.version,
      });
      return { version: created.version };
    },
    prepareVersion: async (name, value, purpose, bindings) => {
      // A prepared version needs the columns 6.29 added. On the previous
      // schema — the one this command meets when it runs before the new
      // release has migrated — say so, rather than fail on a column name.
      if (!(await hasPendingSecretColumns(db))) {
        throw new Error(
          "this database does not know prepared versions yet; start the new release once (it migrates), then re-run with --pending — or write the version now without --pending",
        );
      }
      const created = await createSecretVersion(db, {
        name,
        value,
        created_by: null,
        pending: { prepared_by: "Host-Kommando (engine --vault-set --pending)", bindings },
      });
      await auditAwait(
        {
          tenant_id: SYSTEM_TENANT_ID,
          actor_type: "system",
          actor_id: null,
          action: AuditAction.SECRET_VERSION_PREPARED,
          resource_type: "runtime_secret",
          resource_id: created.reference,
          result: "success",
          metadata: { name, version: created.version, purpose, bindings },
        },
        db,
      );
      logger.info({
        module: "preflight",
        action: "vault.version_prepared",
        msg: "host-side rotation prepared a runtime secret version for approval",
        name,
        version: created.version,
      });
      return { version: created.version };
    },
    rebind: (path, name, version) => rebindSettingPath(db, path, name, version),
    servingReplicas: () => servingReplicas(db),
    rewrap: (previousKeyHex) => rewrapMasterKey(db, previousKeyHex),
    preflight,
  };
}
