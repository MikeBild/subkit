import { actorType } from "../audit/actor.ts";
import { auditAwait } from "../audit/audit.ts";
import { AuditAction } from "../audit/types.ts";
import type { ResolvedPrincipal } from "../auth/types.ts";
import {
  getConfig,
  getDiagnostics,
  RestartRequiredError,
  ScopeViolationError,
  setConfigKey,
  ValidationError,
} from "../config/loader.ts";
import { type ConfigLeaf, findLeafByPath } from "../config/walk.ts";
import type { Db } from "../db/client.ts";
import { logger } from "../logging/index.ts";
import {
  RuntimeConfigConflictError,
  RuntimeConfigNotFoundError,
  RuntimeConfigPendingError,
  RuntimeConfigValidationError,
} from "./contracts.ts";
import {
  activateRuntimeRevision,
  assertNoPendingEngineChange,
  createSecretVersion,
  getRuntimeConfigState,
  parseSecretReference,
  saveRuntimeConfigPatch,
  settingSecretName,
} from "./service.ts";
import { resolveSettingWriteTarget } from "./settings-access.ts";
import { maskedSettingValue } from "./settings-read.ts";

type SettingWriteSurface = "api" | "mcp";

interface SettingWriteRequest {
  readonly db: Db;
  readonly principal: ResolvedPrincipal;
  readonly path: string;
  readonly tenant: string | undefined;
  readonly value: unknown;
  readonly force: boolean;
  readonly surface: SettingWriteSurface;
  readonly requestSource: string;
  readonly auditSource: string | null;
  readonly deployVersion: string | null;
}

interface SettingWriteSuccess {
  readonly ok: true;
  readonly path: string;
  readonly value: unknown;
  readonly requiresRestart: boolean;
  readonly pendingRestartKeys: string[];
}

interface SettingWriteFailure {
  readonly ok: false;
  readonly status: 403 | 404 | 409 | 422;
  readonly code: string;
  readonly message: string;
  readonly details?: Record<string, unknown>;
  readonly savedRevision?: number;
  readonly pendingRestartKeys?: string[];
}

type SettingWriteOutcome = SettingWriteSuccess | SettingWriteFailure;

type WriteResult = Awaited<ReturnType<typeof setConfigKey>> & {
  readonly pendingRestartKeys: string[];
};

interface WriteTarget {
  readonly request: SettingWriteRequest;
  readonly leaf: ConfigLeaf;
  readonly tenant: string | undefined;
  readonly restricted: boolean;
}

class SavedRevisionAwaitsRestartError extends RestartRequiredError {
  constructor(
    message: string,
    readonly savedRevision: number,
    readonly pendingRestartKeys: string[],
  ) {
    super(message);
    this.name = "SavedRevisionAwaitsRestartError";
  }
}

function failure(
  status: SettingWriteFailure["status"],
  code: string,
  message: string,
  details?: Record<string, unknown>,
): SettingWriteFailure {
  return { ok: false, status, code, message, ...(details ? { details } : {}) };
}

function readDeep(source: unknown, leafPath: readonly string[]): unknown {
  let cursor: unknown = source;
  for (const seg of leafPath) {
    if (typeof cursor !== "object" || cursor === null) return undefined;
    cursor = (cursor as Record<string, unknown>)[seg];
  }
  return cursor;
}

function sourceMetadata(request: SettingWriteRequest): Record<string, unknown> {
  return { source: "settings_leaf_write", request_source: request.requestSource };
}

async function writeThroughRevisions(target: WriteTarget): Promise<WriteResult> {
  const { request, leaf, tenant, restricted } = target;
  const { db, principal } = request;
  const leafPath = leaf.path.join(".");
  const auditTenant = tenant ?? principal.tenant_id;
  const auditActorType = actorType(principal);
  const state = await getRuntimeConfigState(db);
  if (restricted) await assertNoPendingEngineChange(db);
  const before = readDeep(getConfig(tenant), leaf.path);
  let storedValue = request.value;
  if (
    leaf.meta.secret &&
    typeof request.value === "string" &&
    request.value.length > 0 &&
    !parseSecretReference(request.value)
  ) {
    const secret = await createSecretVersion(db, {
      name: settingSecretName(tenant, leaf.path),
      value: request.value,
      created_by: principal.id,
    });
    storedValue = secret.reference;
    await auditAwait(
      {
        tenant_id: auditTenant,
        actor_type: auditActorType,
        actor_id: principal.id,
        action: AuditAction.SECRET_VERSION_CREATED,
        resource_type: "runtime_secret",
        resource_id: secret.reference,
        metadata: { name: secret.name, version: secret.version, ...sourceMetadata(request) },
      },
      db,
    );
  }
  const saved = await saveRuntimeConfigPatch(db, {
    expected_revision: state.saved_revision,
    changes: { [leafPath]: storedValue },
    scope: tenant ? "tenant" : "global",
    created_by: principal.id,
    ...(tenant ? { tenant_id: tenant } : {}),
    ...(restricted && tenant ? { restrict_to_tenant: tenant } : {}),
  });
  await auditAwait(
    {
      tenant_id: auditTenant,
      actor_type: auditActorType,
      actor_id: principal.id,
      action: AuditAction.SETTINGS_REVISION_SAVED,
      resource_type: "runtime_config_revision",
      resource_id: String(saved.saved_revision),
      metadata: {
        scope: tenant ? "tenant" : "global",
        changed_paths: [leafPath],
        active_revision: saved.active_revision,
        pending_restart_fields: saved.pending_restart_fields,
        ...sourceMetadata(request),
      },
    },
    db,
  );
  const restartRequired = saved.pending_restart_fields.length > 0;
  const activated = await activateRuntimeRevision(
    db,
    saved.saved_revision,
    {
      tenant_id: auditTenant,
      actor_type: auditActorType,
      actor_id: principal.id,
      source: request.surface,
    },
    restricted && tenant ? { restrict_to_tenant: tenant } : {},
  );
  await auditAwait(
    {
      tenant_id: auditTenant,
      actor_type: auditActorType,
      actor_id: principal.id,
      action:
        activated.activation_status === "restart_required"
          ? AuditAction.SETTINGS_REVISION_RESTART_REQUIRED
          : activated.activation_status === "active"
            ? AuditAction.SETTINGS_REVISION_ACTIVATED
            : AuditAction.SETTINGS_REVISION_ACTIVATION_FAILED,
      resource_type: "runtime_config_revision",
      resource_id: String(saved.saved_revision),
      metadata: { activation_status: activated.activation_status, ...sourceMetadata(request) },
    },
    db,
  );
  if (restartRequired && !request.force) {
    throw new SavedRevisionAwaitsRestartError(
      `${leafPath} was saved as revision ${saved.saved_revision} and becomes active with the next process restart (waiting for it: ${saved.pending_restart_fields.join(", ")}).`,
      saved.saved_revision,
      saved.pending_restart_fields,
    );
  }
  if (!restartRequired && activated.activation_status !== "active") {
    throw new Error(
      `runtime config revision ${saved.saved_revision} activation failed: ${activated.activation_status}`,
    );
  }
  return {
    before,
    after: request.value,
    requiresRestart: restartRequired,
    scope: tenant ? `tenant:${tenant}` : "global",
    leafPath,
    pendingRestartKeys: saved.pending_restart_fields,
  };
}

async function writeInProcess(target: WriteTarget): Promise<WriteResult> {
  const { request, leaf, tenant } = target;
  const result = await setConfigKey(leaf.path, request.value, {
    ...(tenant !== undefined ? { tenantId: tenant } : {}),
    force: request.force,
  });
  return { ...result, pendingRestartKeys: getDiagnostics().pending_restart_keys };
}

async function writeLeaf(target: WriteTarget): Promise<{ result: WriteResult; revised: boolean }> {
  if (process.env.NODE_ENV !== "production") {
    return { result: await writeInProcess(target), revised: false };
  }
  try {
    return { result: await writeThroughRevisions(target), revised: true };
  } catch (error) {
    if (!(error instanceof RuntimeConfigNotFoundError)) throw error;
    return { result: await writeInProcess(target), revised: false };
  }
}

function writeFailure(error: unknown, leaf: ConfigLeaf): SettingWriteFailure {
  if (error instanceof ValidationError)
    return failure(422, "validation_failed", error.message, {
      path: error.path,
      expected: error.expected,
    });
  if (error instanceof RuntimeConfigValidationError)
    return failure(422, "validation_failed", error.message, {
      path: leaf.path,
      expected: leaf.kind,
    });
  if (error instanceof RuntimeConfigPendingError || error instanceof RuntimeConfigConflictError)
    return failure(409, error.code, error.message);
  if (error instanceof SavedRevisionAwaitsRestartError)
    return {
      ...failure(409, "restart_required", error.message, { requiresRestart: true }),
      savedRevision: error.savedRevision,
      pendingRestartKeys: error.pendingRestartKeys,
    };
  if (error instanceof RestartRequiredError)
    return failure(409, "restart_required", error.message, { requiresRestart: true });
  if (error instanceof ScopeViolationError) return failure(403, "scope_violation", error.message);
  throw error;
}

export async function writeSetting(request: SettingWriteRequest): Promise<SettingWriteOutcome> {
  const { db, principal, path } = request;
  const leaf = findLeafByPath(path);
  if (!leaf) return failure(404, "not_found", `unknown setting path: ${path}`);
  if (path === "database.url")
    return failure(
      422,
      "validation_failed",
      "database.url is bootstrap-only; rotate DATABASE_URL and restart replicas instead",
      { path: leaf.path, expected: "DATABASE_URL process binding" },
    );
  const access = await resolveSettingWriteTarget(db, principal, leaf, path, request.tenant);
  if (!access.ok) return failure(403, access.code, access.message);
  const tenant = access.target.kind === "tenant" ? access.target.tenantId : undefined;
  const restricted = access.target.kind === "tenant" && access.target.restricted;
  try {
    const { result, revised } = await writeLeaf({ request, leaf, tenant, restricted });
    const secret = !!leaf.meta.secret;
    try {
      await auditAwait(
        {
          tenant_id: tenant ?? principal.tenant_id,
          actor_type: actorType(principal),
          actor_id: principal.id,
          action: AuditAction.SETTINGS_CHANGED,
          resource_type: "setting",
          resource_id: result.leafPath,
          before: maskedSettingValue(secret, result.before),
          after: maskedSettingValue(secret, result.after),
          metadata: {
            scope: result.scope,
            requires_restart: result.requiresRestart,
            force_applied: request.force,
            revision_service: revised,
            request_source: request.requestSource,
            ...(result.reconfigureFailed ? { reconfigure_failed: true } : {}),
            ...(request.auditSource ? { audit_source: request.auditSource } : {}),
            ...(request.deployVersion ? { deploy_version: request.deployVersion } : {}),
          },
        },
        db,
      );
    } catch (err) {
      logger.error({
        module: "config",
        action: "setting.apply_failed",
        msg: "setConfigKey succeeded but audit row write failed; live state and audit_log are out of sync",
        leaf: result.leafPath,
        scope: result.scope,
        error: err instanceof Error ? err.message : String(err),
      });
      throw err;
    }
    return {
      ok: true,
      path: result.leafPath,
      value: maskedSettingValue(secret, result.after),
      requiresRestart: result.requiresRestart,
      pendingRestartKeys: result.pendingRestartKeys,
    };
  } catch (error) {
    return writeFailure(error, leaf);
  }
}
