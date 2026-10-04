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

function keyFingerprint(keyHex: string): string {
  return createHash("sha256").update(Buffer.from(keyHex, "hex")).digest("hex").slice(0, 8);
}

export async function probeCurrentVersion(db: Db, name: string): Promise<VersionProbe> {
  const projection = await secretVersionProjection(db);
  // tenant-filter:exempt — secret names and versions are product-global operator state.
  const found = await db
    .select(projection.columns)
    .from(runtimeSecretVersions)
    .where(eq(runtimeSecretVersions.name, name))
    .orderBy(desc(runtimeSecretVersions.version));
  const rows = found.map(projection.complete);
  if (rows.length === 0) return { version: null, readable: false, absent: true };
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

export async function servingReplicas(db: Db): Promise<string[]> {
  const cutoff = new Date(Date.now() - REPLICA_LEASE_MS);
  // tenant-filter:exempt — replica leases are product-global runtime state.
  const rows = await db
    .select({ instance_id: runtimeConfigReplicas.instance_id })
    .from(runtimeConfigReplicas)
    .where(gte(runtimeConfigReplicas.last_seen_at, cutoff));
  return rows.map((row) => row.instance_id).sort();
}

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
        decryptSecretWithKey(runningKey, payload, aad);
        continue;
      } catch {}
      try {
        plaintext = decryptSecretWithKey(previousKey, payload, aad);
      } catch (error) {
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
