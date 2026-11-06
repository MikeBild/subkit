import { z } from "@hono/zod-openapi";
import { AUDIT_SOURCE_HEADER, DEPLOY_VERSION_HEADER } from "@shared/audit-source.ts";
import { actorType } from "../../audit/actor.ts";
import { auditAwait } from "../../audit/audit.ts";
import { AuditSourceEnum, DeployVersionSchema } from "../../audit/audit-source.ts";
import { AuditAction } from "../../audit/types.ts";
import type { ResolvedPrincipal } from "../../auth/types.ts";
import {
  getConfig,
  RestartRequiredError,
  ScopeViolationError,
  setConfigKey,
  ValidationError,
} from "../../config/loader.ts";
import { type ConfigLeaf, findLeafByPath } from "../../config/walk.ts";
import type { Db } from "../../db/client.ts";
import { logger } from "../../logging/index.ts";
import {
  activateRuntimeRevision,
  assertNoPendingEngineChange,
  createSecretVersion,
  getRuntimeConfigState,
  parseSecretReference,
  RuntimeConfigConflictError,
  RuntimeConfigNotFoundError,
  RuntimeConfigPendingError,
  RuntimeConfigValidationError,
  saveRuntimeConfigPatch,
  settingSecretName,
} from "../../runtime-config/service.ts";
import { resolveSettingWriteTarget } from "../../runtime-config/settings-access.ts";
import { maskedSettingValue } from "../../runtime-config/settings-read.ts";
import { ErrorSchema } from "../common-schemas.ts";
import { defineOperation, plainRejection, type Rejection, reject } from "./index.ts";
import { SettingPathParam, SettingsTenantQuery } from "./settings.ts";

const PutBody = z
  .object({
    value: z.unknown(),
    force: z.boolean().optional(),
  })
  .openapi("SettingPutBody");

const PutHeaders = z.object({
  [AUDIT_SOURCE_HEADER]: AuditSourceEnum.optional(),
  [DEPLOY_VERSION_HEADER]: DeployVersionSchema.optional(),
});

const ValidationFailedSchema = z
  .object({
    code: z.literal("validation_failed"),
    message: z.string(),
    path: z.array(z.string()),
    expected: z.string(),
  })
  .openapi("SettingValidationFailed");

const ScopeViolationSchema = z
  .object({
    code: z.literal("scope_violation"),
    message: z.string(),
  })
  .openapi("SettingScopeViolation");

const OperatorRequiredSchema = z
  .object({
    code: z.literal("operator_required"),
    message: z.string(),
  })
  .openapi("SettingOperatorRequired");

const OperatorChangePendingSchema = z
  .object({
    code: z.literal("operator_change_pending"),
    message: z.string(),
  })
  .openapi("SettingOperatorChangePending");

const RestartRequiredSchema = z
  .object({
    code: z.literal("restart_required"),
    message: z.string(),
    requiresRestart: z.literal(true),
  })
  .openapi("SettingRestartRequired");

const PutSuccessSchema = z
  .object({
    value: z.unknown(),
    requiresRestart: z.boolean(),
  })
  .openapi("SettingPutResult");

interface SettingWriteInput {
  readonly path: string;
  readonly tenant: string | undefined;
  readonly value: unknown;
  readonly force: boolean | undefined;
  readonly auditSource: string | null;
  readonly deployVersion: string | null;
}

interface SettingWriteResult {
  readonly value: unknown;
  readonly requiresRestart: boolean;
}

type WriteResult = Awaited<ReturnType<typeof setConfigKey>>;

function maskedValue(leaf: ConfigLeaf, value: unknown): unknown {
  return maskedSettingValue(!!leaf.meta.secret, value);
}

function readDeep(source: unknown, leafPath: string[]): unknown {
  let cursor: unknown = source;
  for (const seg of leafPath) {
    if (typeof cursor !== "object" || cursor === null) return undefined;
    cursor = (cursor as Record<string, unknown>)[seg];
  }
  return cursor;
}

interface RevisionWrite {
  readonly db: Db;
  readonly principal: ResolvedPrincipal;
  readonly leaf: ConfigLeaf;
  readonly tenant: string | undefined;
  readonly restricted: boolean;
  readonly value: unknown;
  readonly force: boolean | undefined;
}

async function writeThroughRevisions(write: RevisionWrite): Promise<WriteResult> {
  const { db, principal, leaf, tenant, restricted } = write;
  const auditActorType = principal.kind === "system_account" ? "system_account" : "user";
  const state = await getRuntimeConfigState(db);
  if (restricted) await assertNoPendingEngineChange(db);
  const before = readDeep(getConfig(tenant), leaf.path);
  let storedValue = write.value;
  if (
    leaf.meta.secret &&
    typeof write.value === "string" &&
    write.value.length > 0 &&
    !parseSecretReference(write.value)
  ) {
    const secretName = settingSecretName(tenant, leaf.path);
    const secret = await createSecretVersion(db, {
      name: secretName,
      value: write.value,
      created_by: principal.id,
    });
    storedValue = secret.reference;
    await auditAwait(
      {
        tenant_id: tenant ?? principal.tenant_id,
        actor_type: auditActorType,
        actor_id: principal.id,
        action: AuditAction.SECRET_VERSION_CREATED,
        resource_type: "runtime_secret",
        resource_id: secret.reference,
        metadata: {
          name: secret.name,
          version: secret.version,
          source: "settings_leaf_write",
        },
      },
      db,
    );
  }
  const saved = await saveRuntimeConfigPatch(db, {
    expected_revision: state.saved_revision,
    changes: { [leaf.path.join(".")]: storedValue },
    scope: tenant ? "tenant" : "global",
    created_by: principal.id,
    ...(tenant ? { tenant_id: tenant } : {}),
    ...(restricted && tenant ? { restrict_to_tenant: tenant } : {}),
  });
  await auditAwait(
    {
      tenant_id: tenant ?? principal.tenant_id,
      actor_type: auditActorType,
      actor_id: principal.id,
      action: AuditAction.SETTINGS_REVISION_SAVED,
      resource_type: "runtime_config_revision",
      resource_id: String(saved.saved_revision),
      metadata: {
        scope: tenant ? "tenant" : "global",
        changed_paths: [leaf.path.join(".")],
        active_revision: saved.active_revision,
        pending_restart_fields: saved.pending_restart_fields,
        source: "settings_leaf_write",
      },
    },
    db,
  );
  const restartRequired = saved.pending_restart_fields.length > 0;
  const activated = await activateRuntimeRevision(
    db,
    saved.saved_revision,
    {
      tenant_id: tenant ?? principal.tenant_id,
      actor_type: auditActorType,
      actor_id: principal.id,
      source: "api",
    },
    restricted && tenant ? { restrict_to_tenant: tenant } : {},
  );
  await auditAwait(
    {
      tenant_id: tenant ?? principal.tenant_id,
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
      metadata: {
        activation_status: activated.activation_status,
        source: "settings_leaf_write",
      },
    },
    db,
  );
  if (restartRequired && !write.force) {
    throw new RestartRequiredError(
      `${leaf.path.join(".")} was saved as revision ${saved.saved_revision} and becomes active with the next process restart (waiting for it: ${saved.pending_restart_fields.join(", ")}).`,
    );
  }
  if (!restartRequired && activated.activation_status !== "active") {
    throw new Error(
      `runtime config revision ${saved.saved_revision} activation failed: ${activated.activation_status}`,
    );
  }
  return {
    before,
    after: write.value,
    requiresRestart: restartRequired,
    scope: tenant ? `tenant:${tenant}` : "global",
    leafPath: leaf.path.join("."),
  };
}

function writeRejection(error: unknown, leaf: ConfigLeaf): Rejection {
  if (error instanceof ValidationError)
    return plainRejection(422, "validation_failed", error.message, {
      path: error.path,
      expected: error.expected,
    });
  if (error instanceof RuntimeConfigValidationError)
    return plainRejection(422, "validation_failed", error.message, {
      path: leaf.path,
      expected: leaf.kind,
    });
  if (error instanceof RuntimeConfigPendingError || error instanceof RuntimeConfigConflictError)
    return plainRejection(409, error.code, error.message);
  if (error instanceof RestartRequiredError)
    return plainRejection(409, "restart_required", error.message, { requiresRestart: true });
  if (error instanceof ScopeViolationError)
    return plainRejection(403, "scope_violation", error.message);
  throw error;
}

export const putSettingOperation = defineOperation<SettingWriteInput, SettingWriteResult>({
  id: "settings.put",
  summary: "Write one leaf",
  permission: "settings:write",
  effect: "write",
  audit: AuditAction.SETTINGS_CHANGED,
  async handler(scope, input) {
    const principal = scope.principal;
    if (!principal) return reject.unauthorized();
    const { path } = input;
    const leaf = findLeafByPath(path);
    if (!leaf) return plainRejection(404, "not_found", `unknown setting path: ${path}`);
    if (path === "database.url")
      return plainRejection(
        422,
        "validation_failed",
        "database.url is bootstrap-only; rotate DATABASE_URL and restart replicas instead",
        { path: leaf.path, expected: "DATABASE_URL process binding" },
      );
    const access = await resolveSettingWriteTarget(scope.db, principal, leaf, path, input.tenant);
    if (!access.ok) return plainRejection(403, access.code, access.message);
    const tenant = access.target.kind === "tenant" ? access.target.tenantId : undefined;
    const restricted = access.target.kind === "tenant" && access.target.restricted;
    const setOpts: { tenantId?: string; force?: boolean } = {};
    if (tenant !== undefined) setOpts.tenantId = tenant;
    if (input.force !== undefined) setOpts.force = input.force;
    try {
      let result: WriteResult;
      let usedRevisionService = false;
      if (process.env.NODE_ENV === "production") {
        try {
          result = await writeThroughRevisions({
            db: scope.db,
            principal,
            leaf,
            tenant,
            restricted,
            value: input.value,
            force: input.force,
          });
          usedRevisionService = true;
        } catch (error) {
          if (!(error instanceof RuntimeConfigNotFoundError)) throw error;
          result = await setConfigKey(leaf.path, input.value, setOpts);
        }
      } else {
        result = await setConfigKey(leaf.path, input.value, setOpts);
      }
      try {
        await auditAwait(
          {
            tenant_id: tenant ?? principal.tenant_id,
            actor_type: actorType(principal),
            actor_id: principal.id,
            action: AuditAction.SETTINGS_CHANGED,
            resource_type: "setting",
            resource_id: result.leafPath,
            before: maskedValue(leaf, result.before),
            after: maskedValue(leaf, result.after),
            metadata: {
              scope: result.scope,
              requires_restart: result.requiresRestart,
              force_applied: !!input.force,
              revision_service: usedRevisionService,
              ...(result.reconfigureFailed ? { reconfigure_failed: true } : {}),
              ...(input.auditSource ? { audit_source: input.auditSource } : {}),
              ...(input.deployVersion ? { deploy_version: input.deployVersion } : {}),
            },
          },
          scope.db,
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
      return { value: maskedValue(leaf, result.after), requiresRestart: result.requiresRestart };
    } catch (error) {
      return writeRejection(error, leaf);
    }
  },
  http: {
    method: "put",
    path: "/v1/settings/{path}",
    tags: ["settings"],
    security: null,
    params: SettingPathParam,
    query: SettingsTenantQuery,
    headers: PutHeaders,
    body: PutBody,
    response: PutSuccessSchema,
    success: { status: 200, description: "Setting written" },
    errors: {
      401: "Unauthorized",
      403: {
        description:
          "Scope violation, a write that needs the engine operator, or insufficient permissions",
        schema: z.union([ScopeViolationSchema, OperatorRequiredSchema]),
      },
      404: "Unknown leaf path",
      409: {
        description:
          "Setting requires a restart in production (pass force=true to apply), or a tenant write waits for the engine operator to activate saved engine-wide settings",
        schema: z.union([RestartRequiredSchema, OperatorChangePendingSchema, ErrorSchema]),
      },
      422: {
        description: "Validation failed against the leaf's Zod schema",
        schema: ValidationFailedSchema,
      },
    },
    toInput: ({ param, query, json, header }) => {
      const body = json as z.infer<typeof PutBody>;
      const headers = header as z.infer<typeof PutHeaders>;
      return {
        path: (param as z.infer<typeof SettingPathParam>).path,
        tenant: (query as z.infer<typeof SettingsTenantQuery>).tenant,
        value: body.value,
        force: body.force,
        auditSource: headers[AUDIT_SOURCE_HEADER] ?? null,
        deployVersion: headers[DEPLOY_VERSION_HEADER] ?? null,
      };
    },
    toBody: (result) => result,
  },
});
