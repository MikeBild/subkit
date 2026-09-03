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
import { runtimeConfigReplicas, runtimeSecretVersions } from "../db/schema/index.ts";
import { logger } from "../logging/logger.ts";
import { REPLICA_LEASE_MS } from "../runtime-config/contracts.ts";
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
  // tenant-filter:exempt — secret names and versions are product-global operator state.
  const rows = await db
    .select({
      version: runtimeSecretVersions.version,
      ciphertext: runtimeSecretVersions.ciphertext,
      iv: runtimeSecretVersions.iv,
      auth_tag: runtimeSecretVersions.auth_tag,
      revoked_at: runtimeSecretVersions.revoked_at,
    })
    .from(runtimeSecretVersions)
    .where(eq(runtimeSecretVersions.name, name))
    .orderBy(desc(runtimeSecretVersions.version));
  if (rows.length === 0) return { version: null, readable: false, absent: true };
  const current = rows.find((row) => row.revoked_at === null);
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
    // tenant-filter:exempt — the secret registry is product-global operator state.
    const rows = await tx
      .select()
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
 * Re-point one dotted settings path at `secret://<name>/<version>` by
 * saving a new revision. Global scope only: a tenant overlay is re-pinned
 * through the settings API by someone who can name the tenant, and guessing
 * at one from a host shell is how the wrong tenant gets rewritten.
 */
export async function rebindSettingPath(
  db: Db,
  path: string,
  name: string,
  version: number,
): Promise<Rebound> {
  const state = await getRuntimeConfigState(db);
  await saveRuntimeConfigPatch(db, {
    expected_revision: state.saved_revision,
    changes: { [path]: secretReference(name, version) },
    scope: "global",
    created_by: null,
  });
  return { path, name, version };
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
    rebind: (path, name, version) => rebindSettingPath(db, path, name, version),
    servingReplicas: () => servingReplicas(db),
    rewrap: (previousKeyHex) => rewrapMasterKey(db, previousKeyHex),
    preflight,
  };
}
