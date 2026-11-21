import { parseSecretReference, secretReference } from "@shared/vault-handle.ts";
import { auditAwait } from "../audit/audit.ts";
import { AuditAction, type AuditActorType } from "../audit/types.ts";
import { getConfig, setConfigKey } from "../config/loader.ts";
import type { Db } from "../db/client.ts";
import { readEnv } from "../env.ts";
import { logger } from "../logging/index.ts";
import {
  RuntimeConfigConflictError,
  RuntimeConfigNotFoundError,
  RuntimeConfigPendingError,
} from "./contracts.ts";
import { getDeep } from "./document.ts";
import { HOSTED_WORKSPACE_ALLOWLIST } from "./hosted-workspace-allowlist.ts";
import { waitOutWorkspaceChange } from "./pending-engine-change.ts";
import { settingSecretName } from "./secret-reference.ts";
import { removeUnreferencedSecretVersion } from "./secret-removal.ts";
import {
  activateRuntimeRevision,
  createSecretVersion,
  getRuntimeConfigState,
  getRuntimeRevision,
  saveRuntimeConfigPatch,
} from "./service.ts";
import { maskedSettingValue } from "./settings-read.ts";

export interface LlmAccessChange {
  provider: string;
  api_key?: string;
  model?: string;
}

interface LlmAccessActor {
  tenant_id: string;
  actor_type: AuditActorType;
  actor_id: string | null;
}

interface PersistLlmAccess {
  tenant_id?: string;
  restricted?: boolean;
  change: LlmAccessChange;
  actor: LlmAccessActor;
  source: string;
}

type SecretVersion = Awaited<ReturnType<typeof createSecretVersion>>;

const RACED_SAVE_ATTEMPTS = 5;
const RACED_SAVE_BACKOFF_MS = 50;

function auditSecret(
  db: Db,
  input: PersistLlmAccess,
  action: typeof AuditAction.SECRET_VERSION_CREATED | typeof AuditAction.SECRET_VERSION_REVOKED,
  secret: { name: string; version: number },
  reason?: string,
): Promise<unknown> {
  return auditAwait(
    {
      tenant_id: input.actor.tenant_id,
      actor_type: input.actor.actor_type,
      actor_id: input.actor.actor_id,
      action,
      resource_type: "runtime_secret",
      resource_id: secretReference(secret.name, secret.version),
      ...(reason ? { reason } : {}),
      metadata: { name: secret.name, version: secret.version, source: input.source },
    },
    db,
  );
}

async function removeSecret(
  db: Db,
  input: PersistLlmAccess,
  secret: { name: string; version: number },
  reason: "not_activated" | "superseded",
): Promise<void> {
  try {
    if (await removeUnreferencedSecretVersion(db, secret)) {
      await auditSecret(db, input, AuditAction.SECRET_VERSION_REVOKED, secret, reason);
    }
  } catch (error) {
    logger.error({
      module: "runtime_config",
      action: "llm_access.secret_not_removed",
      msg: "a provider key version that is no longer used could not be removed",
      name: secret.name,
      version: secret.version,
      reason,
      error: error instanceof Error ? error.message : String(error),
    });
  }
}

async function storedKeyVersion(
  db: Db,
  revision: number,
  tenantId: string,
): Promise<{ name: string; version: number } | null> {
  const { document } = await getRuntimeRevision(db, revision);
  const stored = getDeep(document, ["tenants", tenantId, "llm", "api_key"]);
  const parsed = typeof stored === "string" ? parseSecretReference(stored) : null;
  return parsed?.name === settingSecretName(tenantId, ["llm", "api_key"]) ? parsed : null;
}

async function saveLlmAccess(
  db: Db,
  input: PersistLlmAccess,
  restricted: boolean,
  keyVersion: () => Promise<SecretVersion | null>,
) {
  const { change, actor, tenant_id: tenantId } = input;
  for (let attempt = 1; ; attempt += 1) {
    if (restricted) await waitOutWorkspaceChange(db);
    const state = await getRuntimeConfigState(db);
    const previousKey = tenantId
      ? await storedKeyVersion(db, state.saved_revision, tenantId)
      : null;
    const changes: Record<string, unknown> = { "llm.provider": change.provider };
    if (change.model !== undefined) changes["llm.model"] = change.model;
    const key = await keyVersion();
    if (key) changes["llm.api_key"] = key.reference;
    try {
      const saved = await saveRuntimeConfigPatch(db, {
        expected_revision: state.saved_revision,
        changes,
        scope: tenantId ? "tenant" : "global",
        created_by: actor.actor_id,
        ...(tenantId ? { tenant_id: tenantId } : {}),
        ...(restricted ? { restrict_to_tenant: tenantId } : {}),
      });
      return { saved, previousKey };
    } catch (error) {
      const raced =
        error instanceof RuntimeConfigConflictError || error instanceof RuntimeConfigPendingError;
      if (!restricted || !raced || attempt >= RACED_SAVE_ATTEMPTS) throw error;
      await Bun.sleep(RACED_SAVE_BACKOFF_MS * attempt);
    }
  }
}

export async function persistLlmAccess(db: Db, input: PersistLlmAccess): Promise<void> {
  const { change, actor, tenant_id: tenantId } = input;
  const restricted = input.restricted === true && tenantId !== undefined;
  const key: { created: SecretVersion | null } = { created: null };
  const keyVersion = async (): Promise<SecretVersion | null> => {
    if (key.created || change.api_key === undefined) return key.created;
    key.created = await createSecretVersion(db, {
      name: settingSecretName(tenantId, ["llm", "api_key"]),
      value: change.api_key,
      created_by: actor.actor_id,
    });
    await auditSecret(db, input, AuditAction.SECRET_VERSION_CREATED, key.created);
    return key.created;
  };
  let previousKey: { name: string; version: number } | null;
  try {
    const stored = await saveLlmAccess(db, input, restricted, keyVersion);
    previousKey = stored.previousKey;
    const activated = await activateRuntimeRevision(
      db,
      stored.saved.saved_revision,
      { ...actor, source: input.source },
      restricted ? { restrict_to_tenant: tenantId } : {},
    );
    if (activated.activation_status !== "active") {
      throw new Error(`llm access activation failed: ${activated.activation_status}`);
    }
  } catch (error) {
    if (key.created) await removeSecret(db, input, key.created, "not_activated");
    throw error;
  }
  if (key.created && previousKey && previousKey.version !== key.created.version) {
    await removeSecret(db, input, previousKey, "superseded");
  }
  await untilAppliedHere(tenantId, change);
}

const APPLY_WAIT_MS = 5_000;

function appliedHere(tenantId: string | undefined, change: LlmAccessChange): boolean {
  const config = getConfig();
  const llm = tenantId ? config.tenants[tenantId]?.llm : config.llm;
  return (
    llm?.provider === change.provider &&
    (change.api_key === undefined || llm.api_key === change.api_key) &&
    (change.model === undefined || llm.model === change.model)
  );
}

async function untilAppliedHere(
  tenantId: string | undefined,
  change: LlmAccessChange,
): Promise<void> {
  const deadline = Date.now() + APPLY_WAIT_MS;
  while (!appliedHere(tenantId, change) && Date.now() < deadline) await Bun.sleep(50);
}

async function applyWorkspaceLlmAccessInProcess(
  tenantId: string,
  change: LlmAccessChange,
): Promise<void> {
  const options = { tenantId, force: true };
  await setConfigKey(["llm", "provider"], change.provider, options);
  if (change.model !== undefined) await setConfigKey(["llm", "model"], change.model, options);
  if (change.api_key !== undefined) {
    await setConfigKey(["llm", "api_key"], change.api_key, options);
  }
}

function workspaceLlmValues(tenantId: string): Record<string, unknown> {
  const overlay = getConfig().tenants[tenantId]?.llm;
  return {
    "llm.provider": overlay?.provider,
    "llm.model": overlay?.model,
    "llm.api_key": overlay?.api_key,
  };
}

export async function storeWorkspaceLlmAccess(
  db: Db,
  input: { tenant_id: string; change: LlmAccessChange; actor: LlmAccessActor; source: string },
): Promise<void> {
  const { tenant_id: tenantId, change, actor } = input;
  const before = workspaceLlmValues(tenantId);
  let revised = false;
  if (readEnv("NODE_ENV") === "production") {
    try {
      await persistLlmAccess(db, { ...input, restricted: true });
      revised = true;
    } catch (error) {
      if (!(error instanceof RuntimeConfigNotFoundError)) throw error;
    }
  }
  if (!revised) await applyWorkspaceLlmAccessInProcess(tenantId, change);
  const after: Record<string, unknown> = {
    "llm.provider": change.provider,
    "llm.model": change.model,
    "llm.api_key": change.api_key,
  };
  for (const path of HOSTED_WORKSPACE_ALLOWLIST.settings) {
    if (after[path] === undefined) continue;
    const secret = (HOSTED_WORKSPACE_ALLOWLIST.secrets as readonly string[]).includes(path);
    await auditAwait(
      {
        tenant_id: actor.tenant_id,
        actor_type: actor.actor_type,
        actor_id: actor.actor_id,
        action: AuditAction.SETTINGS_CHANGED,
        resource_type: "setting",
        resource_id: path,
        before: maskedSettingValue(secret, before[path]),
        after: maskedSettingValue(secret, after[path]),
        metadata: { scope: `tenant:${tenantId}`, revision_service: revised, source: input.source },
      },
      db,
    );
  }
}
