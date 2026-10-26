import { and, desc, eq, gte, inArray, isNull, max, ne, sql } from "drizzle-orm";
import { SYSTEM_TENANT_ID } from "../audit/types.ts";
import { getConfig, installRuntimeConfig, modelSettingMismatch } from "../config/loader.ts";
import { type Config, ConfigSchema } from "../config/schema.ts";
import { dottedPath, findLeafByPath, listConfigLeaves } from "../config/walk.ts";
import { decryptSecret, encryptSecret } from "../crypto/aes-gcm.ts";
import type { Db, Executor } from "../db/client.ts";
import {
  runtimeConfigReplicas,
  runtimeConfigRevisions,
  runtimeConfigState,
  runtimeSecretVersions,
} from "../db/schema/index.ts";
import { logger } from "../logging/logger.ts";
import { failRuntimeActivation } from "./activation-failure.ts";
import { type AppBoundaryActor, recordAppBoundaryActivation } from "./app-boundary-audit.ts";
import {
  ACTIVATION_TIMEOUT_MS,
  CONFIG_STATE_KEY,
  defaultReplicaInstanceId,
  REPLICA_LEASE_MS,
  type RevisionStatus,
  RuntimeConfigConflictError,
  RuntimeConfigNotFoundError,
  RuntimeConfigPendingError,
  type RuntimeConfigStateView,
  RuntimeConfigValidationError,
  type RuntimeRevision,
  RuntimeSecretInUseError,
} from "./contracts.ts";
import {
  clone,
  configDigest,
  getDeep,
  restartFieldsDiffering,
  revisionChangesOnlyTenant,
  setDeep,
} from "./document.ts";
import { assertNoHostedTenantOverlays } from "./hosted-overlays.ts";
import { hasPendingSecretColumns, secretVersionProjection } from "./secret-columns.ts";
import {
  assertSecretName,
  containsSecretReference,
  ownsTenantSettingSecret,
  parseSecretReference,
  secretReference,
} from "./secret-reference.ts";
import { insertRuntimeSecretVersion } from "./secret-write.ts";
import { ensureRuntimeState, runtimeStateColumns } from "./state-columns.ts";

export { runtimeStateColumns } from "./state-columns.ts";

import { assertTenantRuntimeSecretAllowed } from "./tenant-secret-policy.ts";

export {
  ACTIVATION_TIMEOUT_MS,
  CONFIG_STATE_KEY,
  REPLICA_HEARTBEAT_MS,
  REPLICA_LEASE_MS,
  type RevisionStatus,
  RuntimeConfigConflictError,
  RuntimeConfigNotFoundError,
  RuntimeConfigPendingError,
  type RuntimeConfigStateView,
  RuntimeConfigValidationError,
  type RuntimeRevision,
  RuntimeSecretInUseError,
} from "./contracts.ts";
export { revisionChangesOnlyTenant } from "./document.ts";
export { assertNoPendingEngineChange } from "./pending-engine-change.ts";
export {
  parseSecretReference,
  secretReference,
  settingSecretName,
} from "./secret-reference.ts";

export const DATABASE_URL_BOOTSTRAP_SENTINEL = "bootstrap://DATABASE_URL";

export interface PendingSecretVersionInput {
  prepared_by: string;
  bindings: string[];
}

async function createSecretVersionInTransaction(
  tx: Executor,
  name: string,
  plaintext: string,
  createdBy: string | null,
  pending: PendingSecretVersionInput | null = null,
): Promise<{
  name: string;
  version: number;
  reference: string;
  created_at: Date;
}> {
  assertSecretName(name);
  await assertTenantRuntimeSecretAllowed(tx, name);
  if (plaintext.length === 0) {
    throw new RuntimeConfigValidationError("secret value must not be empty");
  }
  await tx.execute(sql`SELECT pg_advisory_xact_lock(hashtext(${name}))`);
  // tenant-filter:exempt — secret names and versions are product-global operator state.
  const [latest] = await tx
    .select({ version: max(runtimeSecretVersions.version) })
    .from(runtimeSecretVersions)
    .where(eq(runtimeSecretVersions.name, name));
  const version = (latest?.version ?? 0) + 1;
  const aad = `runtime-secret:${name}:${version}`;
  const encrypted = encryptSecret(plaintext, aad);
  const created = await insertRuntimeSecretVersion(tx, {
    name,
    version,
    ciphertext: encrypted.ciphertext,
    iv: encrypted.iv,
    auth_tag: encrypted.auth_tag,
    created_by: createdBy,
    pending,
  });
  return {
    name,
    version,
    reference: secretReference(name, version),
    created_at: created.created_at,
  };
}

export async function createSecretVersion(
  db: Executor,
  args: {
    name: string;
    value: string;
    created_by: string | null;
    pending?: PendingSecretVersionInput;
  },
): Promise<{
  name: string;
  version: number;
  reference: string;
  created_at: Date;
}> {
  return db.transaction((tx) =>
    createSecretVersionInTransaction(
      tx,
      args.name,
      args.value,
      args.created_by,
      args.pending ?? null,
    ),
  );
}

export async function listSecretVersions(db: Executor): Promise<
  Array<{
    name: string;
    versions: Array<{
      version: number;
      reference: string;
      created_at: Date;
      revoked_at: Date | null;
    }>;
  }>
> {
  const withPending = await hasPendingSecretColumns(db);
  // tenant-filter:exempt — the registry is product-global operator state;
  // routes require settings:read and never return ciphertext.
  const rows = await db
    .select({
      name: runtimeSecretVersions.name,
      version: runtimeSecretVersions.version,
      created_at: runtimeSecretVersions.created_at,
      revoked_at: runtimeSecretVersions.revoked_at,
    })
    .from(runtimeSecretVersions)
    .where(withPending ? isNull(runtimeSecretVersions.pending_since) : undefined)
    .orderBy(runtimeSecretVersions.name, desc(runtimeSecretVersions.version));
  const grouped = new Map<
    string,
    Array<{
      version: number;
      reference: string;
      created_at: Date;
      revoked_at: Date | null;
    }>
  >();
  for (const row of rows) {
    const versions = grouped.get(row.name) ?? [];
    versions.push({
      version: row.version,
      reference: secretReference(row.name, row.version),
      created_at: row.created_at,
      revoked_at: row.revoked_at,
    });
    grouped.set(row.name, versions);
  }
  return [...grouped].map(([name, versions]) => ({ name, versions }));
}

async function readSecret(db: Executor, name: string, version: number): Promise<string> {
  if (name.startsWith("connection.")) await assertTenantRuntimeSecretAllowed(db, name);
  const projection = await secretVersionProjection(db);
  // tenant-filter:exempt — references address the product-global secret registry.
  const [found] = await db
    .select(projection.columns)
    .from(runtimeSecretVersions)
    .where(
      and(
        eq(runtimeSecretVersions.name, name),
        eq(runtimeSecretVersions.version, version),
        isNull(runtimeSecretVersions.revoked_at),
      ),
    )
    .limit(1);
  const row = found ? projection.complete(found) : null;
  if (!row) {
    throw new RuntimeConfigValidationError(
      `secret version is missing or revoked: ${name}/${version}`,
    );
  }
  if (row.pending_since) {
    throw new RuntimeConfigValidationError(
      `secret version is prepared but not yet approved: ${name}/${version}`,
    );
  }
  return decryptSecret(
    { ciphertext: row.ciphertext, iv: row.iv, auth_tag: row.auth_tag },
    `runtime-secret:${name}:${version}`,
  );
}

export async function readSecretVersion(
  db: Executor,
  name: string,
  version: number,
): Promise<string> {
  return readSecret(db, name, version);
}

async function resolveSecretReferences(db: Executor, value: unknown): Promise<unknown> {
  if (typeof value === "string") {
    const ref = parseSecretReference(value);
    return ref ? readSecret(db, ref.name, ref.version) : value;
  }
  if (Array.isArray(value))
    return Promise.all(value.map((child) => resolveSecretReferences(db, child)));
  if (value === null || typeof value !== "object") return value;
  const entries = await Promise.all(
    Object.entries(value as Record<string, unknown>).map(
      async ([key, child]) => [key, await resolveSecretReferences(db, child)] as const,
    ),
  );
  return Object.fromEntries(entries);
}

async function validateAndResolveDocument(
  db: Executor,
  document: Record<string, unknown>,
): Promise<Config> {
  const resolved = await resolveSecretReferences(db, document);
  const parsed = ConfigSchema.safeParse(resolved);
  if (!parsed.success) {
    const issue = parsed.error.issues[0];
    throw new RuntimeConfigValidationError(
      `${issue?.path.join(".") || "configuration"}: ${issue?.message ?? "invalid document"}`,
    );
  }
  await assertNoHostedTenantOverlays(db, parsed.data);
  return parsed.data;
}

async function externalizeSeedSecrets(
  tx: Executor,
  document: Record<string, unknown>,
): Promise<Record<string, unknown>> {
  const stored = clone(document);
  for (const leaf of listConfigLeaves()) {
    if (!leaf.meta.secret) continue;
    if (dottedPath(leaf) === "database.url") continue;
    const globalValue = getDeep(stored, leaf.path);
    if (typeof globalValue === "string" && globalValue && !parseSecretReference(globalValue)) {
      const name = `settings.${dottedPath(leaf)}`;
      const created = await createSecretVersionInTransaction(tx, name, globalValue, null);
      setDeep(stored, leaf.path, created.reference);
    }
    const tenants = getDeep(stored, ["tenants"]);
    if (!tenants || typeof tenants !== "object" || Array.isArray(tenants)) continue;
    for (const [tenantId, overlay] of Object.entries(tenants as Record<string, unknown>)) {
      const tenantValue = getDeep(overlay, leaf.path);
      if (typeof tenantValue !== "string" || !tenantValue || parseSecretReference(tenantValue)) {
        continue;
      }
      const name = `tenants.${tenantId}.settings.${dottedPath(leaf)}`;
      const created = await createSecretVersionInTransaction(tx, name, tenantValue, null);
      setDeep(overlay as Record<string, unknown>, leaf.path, created.reference);
    }
  }
  return stored;
}

function toRevision(row: typeof runtimeConfigRevisions.$inferSelect): RuntimeRevision {
  return {
    revision: row.revision,
    document: row.document,
    digest: row.digest,
    status: row.status,
    pending_restart_fields: row.pending_restart_fields,
    failure_reason: row.failure_reason,
    created_at: row.created_at,
    activated_at: row.activated_at,
  };
}

async function requireRevision(db: Executor, revision: number): Promise<RuntimeRevision> {
  // tenant-filter:exempt — revision numbers are product-global configuration state.
  const [row] = await db
    .select()
    .from(runtimeConfigRevisions)
    .where(eq(runtimeConfigRevisions.revision, revision))
    .limit(1);
  if (!row) throw new RuntimeConfigNotFoundError(`runtime config revision ${revision} not found`);
  return toRevision(row);
}

class HealthyLeaseConflictError extends RuntimeConfigConflictError {}

export const BOOT_LEASE_WAIT_MS = REPLICA_LEASE_MS + 5_000;

export interface BootLeaseWait {
  maxWaitMs?: number;
  sleep?: (ms: number) => Promise<void>;
  instanceId?: string;
}

export async function initializeRuntimeConfig(
  db: Db,
  seed: Config,
  leaseWait: BootLeaseWait = {},
): Promise<RuntimeConfigStateView> {
  const maxWaitMs = leaseWait.maxWaitMs ?? BOOT_LEASE_WAIT_MS;
  const sleep = leaseWait.sleep ?? ((ms: number) => Bun.sleep(ms));
  const ownInstanceId = leaseWait.instanceId ?? defaultReplicaInstanceId();
  const startedAt = Date.now();
  let backoffMs = 500;
  for (;;) {
    try {
      return await initializeRuntimeConfigOnce(db, seed, ownInstanceId);
    } catch (error) {
      if (!(error instanceof HealthyLeaseConflictError)) throw error;
      const waited = Date.now() - startedAt;
      if (waited >= maxWaitMs) throw error;
      logger.warn({
        module: "runtime_config",
        action: "boot.lease_wait",
        msg: "a restart-required revision waits for another replica's lease to expire",
        waited_ms: waited,
        next_attempt_ms: backoffMs,
      });
      await sleep(Math.min(backoffMs, Math.max(0, maxWaitMs - waited)));
      backoffMs = Math.min(backoffMs * 2, 5_000);
    }
  }
}

async function initializeRuntimeConfigOnce(
  db: Db,
  seed: Config,
  ownInstanceId: string,
): Promise<RuntimeConfigStateView> {
  await validateAndResolveDocument(db, seed);
  let bootActivation: { before: RuntimeRevision; after: RuntimeRevision } | null = null;
  const state = await db.transaction(async (tx) => {
    bootActivation = null;
    await ensureRuntimeState(tx);
    // tenant-filter:exempt — the canonical active/desired pointer is product-global.
    const [locked] = await tx
      .select(runtimeStateColumns)
      .from(runtimeConfigState)
      .where(eq(runtimeConfigState.key, CONFIG_STATE_KEY))
      .for("update");
    if (!locked) throw new Error("runtime config state row missing after insert");

    if (locked.active_revision !== null) {
      let active = await requireRevision(tx, locked.active_revision);
      const savedRevision = locked.desired_revision ?? active.revision;
      if (savedRevision !== active.revision) {
        const desired = await requireRevision(tx, savedRevision);
        if (desired.status === "restart_required") {
          const cutoff = new Date(Date.now() - REPLICA_LEASE_MS);
          // tenant-filter:exempt — replica leases are product-global runtime state.
          const healthy = await tx
            .select({ instance_id: runtimeConfigReplicas.instance_id })
            .from(runtimeConfigReplicas)
            .where(
              and(
                gte(runtimeConfigReplicas.last_seen_at, cutoff),
                ne(runtimeConfigReplicas.instance_id, ownInstanceId),
              ),
            )
            .limit(1);
          if (healthy.length > 0) {
            throw new HealthyLeaseConflictError(
              `revision ${savedRevision} requires a coordinated restart; a prior replica lease is still healthy`,
            );
          }
          const activatedAt = new Date();
          await tx
            .update(runtimeConfigRevisions)
            .set({
              status: "active",
              activated_at: activatedAt,
              failure_reason: null,
            })
            .where(eq(runtimeConfigRevisions.revision, savedRevision));
          await tx
            .update(runtimeConfigState)
            .set({ active_revision: savedRevision, updated_at: activatedAt })
            .where(eq(runtimeConfigState.key, CONFIG_STATE_KEY));
          bootActivation = { before: active, after: desired };
          active = { ...desired, status: "active", activated_at: activatedAt };
        }
      }
      return { active, savedRevision };
    }

    const parsed = ConfigSchema.parse(seed);
    parsed.database.url = DATABASE_URL_BOOTSTRAP_SENTINEL;
    const document = await externalizeSeedSecrets(
      tx,
      clone(parsed) as unknown as Record<string, unknown>,
    );
    const digest = configDigest(document);
    const [created] = await tx
      .insert(runtimeConfigRevisions)
      .values({
        document,
        digest,
        status: "active",
        pending_restart_fields: [],
        activated_at: new Date(),
      })
      .returning();
    if (!created) throw new Error("initial runtime config revision insert returned no row");
    await tx
      .update(runtimeConfigState)
      .set({
        active_revision: created.revision,
        desired_revision: created.revision,
        updated_at: new Date(),
      })
      .where(eq(runtimeConfigState.key, CONFIG_STATE_KEY));
    return { active: toRevision(created), savedRevision: created.revision };
  });

  const resolved = await validateAndResolveDocument(db, state.active.document);
  resolved.database.url = seed.database.url;
  const { preflightObjectStoreConfig } = await import("../storage/object-store.ts");
  await preflightObjectStoreConfig(resolved.storage);
  await applyRuntimeConfig(resolved);
  const activated = bootActivation as { before: RuntimeRevision; after: RuntimeRevision } | null;
  if (activated) {
    await recordAppBoundaryActivation(db, {
      before: activated.before.document,
      after: activated.after.document,
      actor: { tenant_id: SYSTEM_TENANT_ID, actor_type: "system", actor_id: null },
      revision: activated.after.revision,
      previous_revision: activated.before.revision,
      source: "boot",
    });
  }
  return {
    saved_revision: state.savedRevision,
    active_revision: state.active.revision,
    activation_status: state.active.status,
    pending_restart_fields: state.active.pending_restart_fields,
  };
}

export async function getRuntimeConfigState(db: Executor): Promise<RuntimeConfigStateView> {
  // tenant-filter:exempt — the canonical active/desired pointer is product-global.
  const [state] = await db
    .select(runtimeStateColumns)
    .from(runtimeConfigState)
    .where(eq(runtimeConfigState.key, CONFIG_STATE_KEY))
    .limit(1);
  if (!state?.active_revision)
    throw new RuntimeConfigNotFoundError("runtime config is not initialized");
  const savedRevision = state.desired_revision ?? state.active_revision;
  const [active, saved] = await Promise.all([
    requireRevision(db, state.active_revision),
    requireRevision(db, savedRevision),
  ]);
  return {
    saved_revision: saved.revision,
    active_revision: active.revision,
    activation_status: saved.status,
    pending_restart_fields: saved.revision === active.revision ? [] : saved.pending_restart_fields,
  };
}

export async function getRuntimeRevision(db: Executor, revision: number): Promise<RuntimeRevision> {
  return requireRevision(db, revision);
}

export async function listRuntimeRevisions(db: Executor, limit = 50): Promise<RuntimeRevision[]> {
  // tenant-filter:exempt — revision history is product-global operator state.
  const rows = await db
    .select()
    .from(runtimeConfigRevisions)
    .orderBy(desc(runtimeConfigRevisions.revision))
    .limit(Math.max(1, Math.min(limit, 200)));
  return rows.map(toRevision);
}

function normalizeChanges(changes: Record<string, unknown>): Array<[string, unknown]> {
  const entries = Object.entries(changes);
  if (entries.length === 0) {
    throw new RuntimeConfigValidationError("changes must contain at least one dotted setting path");
  }
  return entries;
}

export async function saveRuntimeConfigPatch(
  db: Db,
  args: {
    expected_revision: number;
    changes: Record<string, unknown>;
    scope: "global" | "tenant";
    tenant_id?: string;
    created_by: string | null;
    restrict_to_tenant?: string;
  },
): Promise<RuntimeConfigStateView> {
  if (args.scope === "tenant" && !args.tenant_id) {
    throw new RuntimeConfigValidationError("tenant_id is required when scope=tenant");
  }
  if (
    args.restrict_to_tenant !== undefined &&
    (args.scope !== "tenant" || args.tenant_id !== args.restrict_to_tenant)
  ) {
    throw new RuntimeConfigValidationError(
      "a tenant-restricted change may only write that tenant's own settings",
    );
  }
  if (args.scope === "global" && args.tenant_id) {
    throw new RuntimeConfigValidationError("tenant_id is only valid when scope=tenant");
  }
  const entries = normalizeChanges(args.changes);

  const result = await db.transaction(async (tx) => {
    // tenant-filter:exempt — the canonical active/desired pointer is product-global.
    const [state] = await tx
      .select(runtimeStateColumns)
      .from(runtimeConfigState)
      .where(eq(runtimeConfigState.key, CONFIG_STATE_KEY))
      .for("update");
    if (!state?.active_revision) {
      throw new RuntimeConfigNotFoundError("runtime config is not initialized");
    }
    const baseRevision = state.desired_revision ?? state.active_revision;
    if (args.restrict_to_tenant !== undefined && baseRevision !== state.active_revision) {
      throw new RuntimeConfigPendingError();
    }
    if (baseRevision !== args.expected_revision) {
      throw new RuntimeConfigConflictError(
        `expected revision ${args.expected_revision}, current saved revision is ${baseRevision}`,
      );
    }
    const base = await requireRevision(tx, baseRevision);
    const document = clone(base.document);

    for (const [path, value] of entries) {
      const leaf = findLeafByPath(path);
      if (!leaf) throw new RuntimeConfigValidationError(`unknown setting path: ${path}`);
      if (path === "database.url") {
        throw new RuntimeConfigValidationError(
          "database.url is a bootstrap-only process binding; rotate DATABASE_URL and restart replicas instead",
        );
      }
      const leafScope = leaf.meta.scope ?? "global";
      if (args.scope === "tenant" && leafScope !== "tenant") {
        throw new RuntimeConfigValidationError(
          `${path} has scope=${leafScope} and cannot be changed with scope=${args.scope}`,
        );
      }
      if (leaf.meta.secret && (typeof value !== "string" || !parseSecretReference(value))) {
        throw new RuntimeConfigValidationError(
          `${path} is secret; create a secret version and pass its immutable secret:// reference`,
        );
      }
      if (
        leaf.meta.secret &&
        args.restrict_to_tenant !== undefined &&
        !ownsTenantSettingSecret(value, args.restrict_to_tenant, leaf.path)
      ) {
        throw new RuntimeConfigValidationError(
          `${path} is secret; send the plaintext value so the engine stores it as this workspace's own secret`,
        );
      }
      if (!leaf.meta.secret && containsSecretReference(value)) {
        throw new RuntimeConfigValidationError(
          `${path} is not secret and cannot contain a secret:// reference`,
        );
      }
      const targetPath =
        args.scope === "tenant" ? ["tenants", args.tenant_id!, ...leaf.path] : leaf.path;
      setDeep(document, targetPath, value);
    }

    const active =
      state.active_revision === base.revision
        ? base
        : await requireRevision(tx, state.active_revision);
    const pendingRestart = restartFieldsDiffering(active.document, document);

    const resolved = await validateAndResolveDocument(tx, document);
    for (const [path, value] of entries) {
      const mismatch = modelSettingMismatch(resolved, path.split("."), value, args.tenant_id);
      if (mismatch) throw new RuntimeConfigValidationError(mismatch);
    }
    const digest = configDigest(document);
    const [created] = await tx
      .insert(runtimeConfigRevisions)
      .values({
        document,
        digest,
        status: "saved",
        pending_restart_fields: pendingRestart,
        created_by: args.created_by,
      })
      .returning();
    if (!created) throw new Error("runtime config revision insert returned no row");
    const saved = toRevision(created);
    await tx
      .update(runtimeConfigState)
      .set({ desired_revision: saved.revision, updated_at: new Date() })
      .where(eq(runtimeConfigState.key, CONFIG_STATE_KEY));
    return { activeRevision: state.active_revision, saved };
  });

  return {
    saved_revision: result.saved.revision,
    active_revision: result.activeRevision,
    activation_status: result.saved.status,
    pending_restart_fields: result.saved.pending_restart_fields,
  };
}

function documentContainsReference(value: unknown, reference: string): boolean {
  if (value === reference) return true;
  if (Array.isArray(value))
    return value.some((child) => documentContainsReference(child, reference));
  if (value === null || typeof value !== "object") return false;
  return Object.values(value as Record<string, unknown>).some((child) =>
    documentContainsReference(child, reference),
  );
}

export async function revokeSecretVersion(
  db: Executor,
  args: { name: string; version: number },
): Promise<{ name: string; version: number; revoked_at: Date }> {
  const reference = secretReference(args.name, args.version);
  return db.transaction(async (tx) => {
    // tenant-filter:exempt — secret revocation checks the product-global pointers.
    const [state] = await tx
      .select(runtimeStateColumns)
      .from(runtimeConfigState)
      .where(eq(runtimeConfigState.key, CONFIG_STATE_KEY))
      .for("update");
    const revisions = [state?.active_revision, state?.desired_revision].filter(
      (revision): revision is number => revision !== null && revision !== undefined,
    );
    if (revisions.length > 0) {
      // tenant-filter:exempt — referenced revisions are product-global operator state.
      const documents = await tx
        .select({ document: runtimeConfigRevisions.document })
        .from(runtimeConfigRevisions)
        .where(inArray(runtimeConfigRevisions.revision, [...new Set(revisions)]));
      if (documents.some((row) => documentContainsReference(row.document, reference))) {
        throw new RuntimeSecretInUseError(`${reference} is referenced by saved or active settings`);
      }
    }
    const revokedAt = new Date();
    const [revoked] = await tx
      .update(runtimeSecretVersions)
      .set({ revoked_at: revokedAt })
      .where(
        and(
          eq(runtimeSecretVersions.name, args.name),
          eq(runtimeSecretVersions.version, args.version),
          isNull(runtimeSecretVersions.revoked_at),
        ),
      )
      .returning({ revoked_at: runtimeSecretVersions.revoked_at });
    if (!revoked?.revoked_at) {
      throw new RuntimeConfigNotFoundError(
        `active secret version not found: ${args.name}/${args.version}`,
      );
    }
    return {
      name: args.name,
      version: args.version,
      revoked_at: revoked.revoked_at,
    };
  });
}

export async function prepareRuntimeConfig(
  db: Executor,
  revision: RuntimeRevision,
): Promise<Config> {
  const config = await validateAndResolveDocument(db, revision.document);
  config.database.url = getConfig().database.url;
  const { preflightObjectStoreConfig } = await import("../storage/object-store.ts");
  await preflightObjectStoreConfig(config.storage);
  return config;
}

export async function applyRuntimeConfig(config: Config): Promise<void> {
  installRuntimeConfig(config);
  const { reconfigureLogger, reconfigureObservability } = await import("../logging/logger.ts");
  reconfigureLogger({ level: config.log.level, format: config.log.format });
  reconfigureObservability({
    field_truncation_chars: config.observability.field_truncation_chars,
    service_name: config.observability.otlp.service_name,
    deployment_environment: config.observability.deployment_environment,
  });
  const { reconfigureTracing } = await import("../observability/tracing.ts");
  try {
    await reconfigureTracing();
  } catch (error) {
    logger.warn({
      module: "runtime_config",
      action: "observability.reconfigure_failed",
      msg: "runtime configuration applied but tracing hot reload failed",
      error: error instanceof Error ? error.message : String(error),
    });
  }
  try {
    const { resetLangfuseCacheForReload } = await import("../observability/langfuse-spans.ts");
    resetLangfuseCacheForReload();
  } catch {}
  const { resetObjectStoreForRuntimeConfig } = await import("../storage/object-store.ts");
  resetObjectStoreForRuntimeConfig();
}

export interface RevisionActivationActor extends AppBoundaryActor {
  source: string;
}

export interface RevisionActivationOptions {
  restrict_to_tenant?: string;
}

export async function activateRuntimeRevision(
  db: Db,
  revisionNumber: number,
  actor: RevisionActivationActor,
  options: RevisionActivationOptions = {},
): Promise<{
  saved_revision: number;
  active_revision: number;
  activation_status: RevisionStatus;
  pending_restart_fields: string[];
  replicas: Array<{
    instance_id: string;
    status: "preparing" | "ack" | "nack";
    digest: string | null;
    reason: string | null;
  }>;
}> {
  const revision = await requireRevision(db, revisionNumber);
  await validateAndResolveDocument(db, revision.document);
  // tenant-filter:exempt — activation commits the product-global desired revision.
  const [state] = await db
    .select(runtimeStateColumns)
    .from(runtimeConfigState)
    .where(eq(runtimeConfigState.key, CONFIG_STATE_KEY))
    .limit(1);
  if (!state?.active_revision)
    throw new RuntimeConfigNotFoundError("runtime config is not initialized");
  if (state.desired_revision !== revisionNumber) {
    throw new RuntimeConfigConflictError(
      `revision ${revisionNumber} is not the current saved revision ${state.desired_revision}`,
    );
  }
  const previous = await requireRevision(db, state.active_revision);
  if (
    options.restrict_to_tenant &&
    !revisionChangesOnlyTenant(previous.document, revision.document, options.restrict_to_tenant)
  ) {
    throw new RuntimeConfigPendingError();
  }
  if (revision.pending_restart_fields.length > 0) {
    await db
      .update(runtimeConfigRevisions)
      .set({ status: "restart_required", failure_reason: null })
      .where(eq(runtimeConfigRevisions.revision, revisionNumber));
    return {
      saved_revision: revisionNumber,
      active_revision: state.active_revision,
      activation_status: "restart_required",
      pending_restart_fields: revision.pending_restart_fields,
      replicas: [],
    };
  }

  const cutoff = new Date(Date.now() - REPLICA_LEASE_MS);
  // tenant-filter:exempt — replica leases are product-global runtime state.
  const healthy = await db
    .select({ instance_id: runtimeConfigReplicas.instance_id })
    .from(runtimeConfigReplicas)
    .where(gte(runtimeConfigReplicas.last_seen_at, cutoff));
  if (healthy.length === 0) {
    await failRuntimeActivation(
      db,
      revisionNumber,
      "no healthy runtime replicas are available for activation",
      options.restrict_to_tenant,
    );
    throw new RuntimeConfigConflictError(
      "no healthy runtime replicas are available for activation",
    );
  }
  const ids = healthy.map((row) => row.instance_id);
  await db.transaction(async (tx) => {
    await tx
      .update(runtimeConfigRevisions)
      .set({ status: "preparing", failure_reason: null })
      .where(eq(runtimeConfigRevisions.revision, revisionNumber));
    await tx
      .update(runtimeConfigReplicas)
      .set({
        desired_revision: revisionNumber,
        ack_revision: null,
        ack_digest: null,
        ack_status: "preparing",
        ack_reason: null,
        updated_at: new Date(),
      })
      .where(inArray(runtimeConfigReplicas.instance_id, ids));
  });

  const deadline = Date.now() + ACTIVATION_TIMEOUT_MS;
  let acknowledgements: Array<typeof runtimeConfigReplicas.$inferSelect> = [];
  while (Date.now() < deadline) {
    // tenant-filter:exempt — ACK/NACK rows are product-global runtime state.
    acknowledgements = await db
      .select()
      .from(runtimeConfigReplicas)
      .where(inArray(runtimeConfigReplicas.instance_id, ids));
    const nack = acknowledgements.find(
      (replica) => replica.ack_revision === revisionNumber && replica.ack_status === "nack",
    );
    if (nack) {
      const reason = `${nack.instance_id}: ${nack.ack_reason ?? "prepare rejected"}`;
      await failRuntimeActivation(db, revisionNumber, reason, options.restrict_to_tenant);
      return {
        saved_revision: revisionNumber,
        active_revision: state.active_revision,
        activation_status: "failed",
        pending_restart_fields: [],
        replicas: acknowledgements.map((replica) => ({
          instance_id: replica.instance_id,
          status:
            replica.ack_revision === revisionNumber && replica.ack_status === "nack"
              ? "nack"
              : replica.ack_revision === revisionNumber && replica.ack_status === "ack"
                ? "ack"
                : "preparing",
          digest: replica.ack_digest,
          reason: replica.ack_reason,
        })),
      };
    }
    const allAck = acknowledgements.every(
      (replica) =>
        replica.ack_revision === revisionNumber &&
        replica.ack_status === "ack" &&
        replica.ack_digest === revision.digest,
    );
    if (allAck && acknowledgements.length === ids.length) break;
    await Bun.sleep(100);
  }

  const allAck =
    acknowledgements.length === ids.length &&
    acknowledgements.every(
      (replica) =>
        replica.ack_revision === revisionNumber &&
        replica.ack_status === "ack" &&
        replica.ack_digest === revision.digest,
    );
  if (!allAck) {
    const reason = "activation timed out waiting for every healthy replica ACK";
    await failRuntimeActivation(db, revisionNumber, reason, options.restrict_to_tenant);
    return {
      saved_revision: revisionNumber,
      active_revision: state.active_revision,
      activation_status: "failed",
      pending_restart_fields: [],
      replicas: acknowledgements.map((replica) => ({
        instance_id: replica.instance_id,
        status:
          replica.ack_revision === revisionNumber && replica.ack_status === "nack"
            ? "nack"
            : replica.ack_revision === revisionNumber && replica.ack_status === "ack"
              ? "ack"
              : "preparing",
        digest: replica.ack_digest,
        reason: replica.ack_reason,
      })),
    };
  }

  await db.transaction(async (tx) => {
    // tenant-filter:exempt — activation locks the product-global pointer.
    const [locked] = await tx
      .select(runtimeStateColumns)
      .from(runtimeConfigState)
      .where(eq(runtimeConfigState.key, CONFIG_STATE_KEY))
      .for("update");
    if (locked?.desired_revision !== revisionNumber) {
      throw new RuntimeConfigConflictError("saved revision changed during activation");
    }
    await tx
      .update(runtimeConfigState)
      .set({ active_revision: revisionNumber, updated_at: new Date() })
      .where(eq(runtimeConfigState.key, CONFIG_STATE_KEY));
    await tx
      .update(runtimeConfigRevisions)
      .set({ status: "active", activated_at: new Date(), failure_reason: null })
      .where(eq(runtimeConfigRevisions.revision, revisionNumber));
  });

  await recordAppBoundaryActivation(db, {
    before: previous.document,
    after: revision.document,
    actor: { tenant_id: actor.tenant_id, actor_type: actor.actor_type, actor_id: actor.actor_id },
    revision: revisionNumber,
    previous_revision: previous.revision,
    source: actor.source,
  });

  return {
    saved_revision: revisionNumber,
    active_revision: revisionNumber,
    activation_status: "active",
    pending_restart_fields: [],
    replicas: acknowledgements.map((replica) => ({
      instance_id: replica.instance_id,
      status: "ack",
      digest: replica.ack_digest,
      reason: null,
    })),
  };
}

export async function getActivationReplicas(
  db: Executor,
  revision: number,
): Promise<
  Array<{
    instance_id: string;
    healthy: boolean;
    status: string;
    digest: string | null;
    reason: string | null;
    last_seen_at: Date;
  }>
> {
  const cutoff = new Date(Date.now() - REPLICA_LEASE_MS);
  // tenant-filter:exempt — activation diagnostics describe product-global replicas.
  const rows = await db
    .select()
    .from(runtimeConfigReplicas)
    .where(eq(runtimeConfigReplicas.desired_revision, revision));
  return rows.map((row) => ({
    instance_id: row.instance_id,
    healthy: row.last_seen_at >= cutoff,
    status: row.ack_revision === revision ? row.ack_status : "preparing",
    digest: row.ack_digest,
    reason: row.ack_reason,
    last_seen_at: row.last_seen_at,
  }));
}

export {
  assertVaultMasterKey,
  assertVaultProducersStopped,
  completeRegistryRewrapEpoch,
  lockVaultMaintenance,
  lockVaultParticipation,
  pinVaultMasterKey,
  VaultParticipationError,
  withVaultStartupGate,
} from "./vault-participation.ts";
