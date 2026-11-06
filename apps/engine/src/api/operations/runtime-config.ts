import { z } from "@hono/zod-openapi";
import { AuditAction, auditAwait } from "../../audit/index.ts";
import type { ResolvedPrincipal } from "../../auth/types.ts";
import {
  activateRuntimeRevision,
  createSecretVersion,
  getActivationReplicas,
  getRuntimeConfigState,
  getRuntimeRevision,
  listRuntimeRevisions,
  listSecretVersions,
  RuntimeConfigConflictError,
  RuntimeConfigNotFoundError,
  RuntimeConfigValidationError,
  RuntimeSecretInUseError,
  revokeSecretVersion,
  saveRuntimeConfigPatch,
} from "../../runtime-config/service.ts";
import { defineOperation, plainRejection, type Rejection, reject } from "./index.ts";

const RevisionNumber = z.coerce.number().int().positive();
const RevisionParam = z.object({
  revision: RevisionNumber.openapi({ param: { name: "revision", in: "path" } }),
});
const SecretParam = z.object({
  name: z
    .string()
    .regex(/^[A-Za-z0-9][A-Za-z0-9._-]{0,254}$/)
    .openapi({ param: { name: "name", in: "path" } }),
});
const SecretVersionParam = SecretParam.extend({
  version: z.coerce
    .number()
    .int()
    .positive()
    .openapi({ param: { name: "version", in: "path" } }),
});

const RevisionStatusSchema = z.enum(["saved", "preparing", "active", "failed", "restart_required"]);

const ConfigStateSchema = z
  .object({
    saved_revision: z.number().int().positive(),
    active_revision: z.number().int().positive(),
    activation_status: RevisionStatusSchema,
    pending_restart_fields: z.array(z.string()),
  })
  .openapi("RuntimeConfigState");

const RevisionSchema = z
  .object({
    revision: z.number().int().positive(),
    document: z.record(z.string(), z.unknown()),
    digest: z.string().regex(/^[0-9a-f]{64}$/),
    status: RevisionStatusSchema,
    pending_restart_fields: z.array(z.string()),
    failure_reason: z.string().nullable(),
    created_at: z.string().datetime(),
    activated_at: z.string().datetime().nullable(),
  })
  .openapi("RuntimeConfigRevision");

const PatchSettingsBody = z
  .object({
    expected_revision: z.number().int().positive(),
    changes: z.record(z.string().min(1), z.unknown()),
    scope: z.enum(["global", "tenant"]),
    tenant_id: z.string().uuid().optional(),
  })
  .superRefine((value, ctx) => {
    if (value.scope === "tenant" && !value.tenant_id) {
      ctx.addIssue({ code: "custom", path: ["tenant_id"], message: "required for tenant scope" });
    }
    if (value.scope === "global" && value.tenant_id) {
      ctx.addIssue({
        code: "custom",
        path: ["tenant_id"],
        message: "not allowed for global scope",
      });
    }
  })
  .openapi("RuntimeConfigPatch");

const SecretCreateBody = z.object({ value: z.string().min(1).max(65_536) }).openapi("SecretValue");

const RuntimeSettingsResponse = ConfigStateSchema.extend({
  settings: z.record(z.string(), z.unknown()),
});

const ActivationResultResponse = ConfigStateSchema.extend({
  replicas: z.array(
    z.object({
      instance_id: z.string(),
      status: z.enum(["preparing", "ack", "nack"]),
      digest: z.string().nullable(),
      reason: z.string().nullable(),
    }),
  ),
});

const ActivationStateResponse = z.object({
  revision: z.number().int().positive(),
  replicas: z.array(
    z.object({
      instance_id: z.string(),
      healthy: z.boolean(),
      status: z.string(),
      digest: z.string().nullable(),
      reason: z.string().nullable(),
      last_seen_at: z.string().datetime(),
    }),
  ),
});

const SecretListResponse = z.object({
  items: z.array(
    z.object({
      name: z.string(),
      versions: z.array(
        z.object({
          version: z.number().int().positive(),
          reference: z.string(),
          created_at: z.string().datetime(),
          revoked_at: z.string().datetime().nullable(),
        }),
      ),
    }),
  ),
});

const SecretCreatedResponse = z.object({
  name: z.string(),
  version: z.number().int().positive(),
  reference: z.string(),
  created_at: z.string().datetime(),
});

const SecretRevokedResponse = z.object({
  name: z.string(),
  version: z.number().int().positive(),
  revoked_at: z.string().datetime(),
});

const UNAUTHORIZED = { 401: "Unauthorized", 403: "Forbidden" } as const;

type PatchInput = z.infer<typeof PatchSettingsBody>;
type RevisionInput = z.infer<typeof RevisionParam>;
type SecretCreateInput = z.infer<typeof SecretParam> & z.infer<typeof SecretCreateBody>;
type SecretVersionInput = z.infer<typeof SecretVersionParam>;
type RuntimeRevision = Awaited<ReturnType<typeof getRuntimeRevision>>;

function revisionWire(revision: RuntimeRevision) {
  return {
    ...revision,
    created_at: revision.created_at.toISOString(),
    activated_at: revision.activated_at?.toISOString() ?? null,
  };
}

function actorTypeOf(principal: ResolvedPrincipal): "system_account" | "user" {
  return principal.kind === "system_account" ? "system_account" : "user";
}

function runtimeConfigRejection(error: unknown): Rejection {
  if (error instanceof RuntimeConfigConflictError || error instanceof RuntimeSecretInUseError) {
    return plainRejection(409, error.code, error.message);
  }
  if (error instanceof RuntimeConfigValidationError) {
    return plainRejection(422, error.code, error.message);
  }
  if (error instanceof RuntimeConfigNotFoundError) {
    return plainRejection(404, error.code, error.message);
  }
  throw error;
}

export const getRuntimeSettingsOperation = defineOperation<
  void,
  Awaited<ReturnType<typeof getRuntimeConfigState>> & { settings: Record<string, unknown> }
>({
  id: "runtime_config.get",
  summary: "Read the canonical saved and active runtime configuration",
  permission: "settings:read:global",
  effect: "read",
  async handler(scope) {
    const state = await getRuntimeConfigState(scope.db);
    const saved = await getRuntimeRevision(scope.db, state.saved_revision);
    return { ...state, settings: saved.document };
  },
  http: {
    method: "get",
    path: "/v1/settings/runtime",
    tags: ["settings"],
    security: null,
    response: RuntimeSettingsResponse,
    success: { status: 200, description: "Current runtime configuration state" },
    errors: UNAUTHORIZED,
    toInput: () => undefined,
    toBody: (result) => result,
  },
});

export const patchRuntimeSettingsOperation = defineOperation<
  PatchInput,
  Awaited<ReturnType<typeof saveRuntimeConfigPatch>>
>({
  id: "runtime_config.patch",
  summary: "Save an immutable runtime configuration revision",
  permission: "settings:write:global",
  effect: "write",
  audit: AuditAction.SETTINGS_REVISION_SAVED,
  async handler(scope, body) {
    const principal = scope.principal;
    if (!principal) return reject.unauthorized();
    try {
      const state = await saveRuntimeConfigPatch(scope.db, {
        expected_revision: body.expected_revision,
        changes: body.changes,
        scope: body.scope,
        created_by: principal.id,
        ...(body.tenant_id ? { tenant_id: body.tenant_id } : {}),
      });
      await auditAwait(
        {
          tenant_id: body.tenant_id ?? principal.tenant_id,
          actor_type: actorTypeOf(principal),
          actor_id: principal.id,
          action: AuditAction.SETTINGS_REVISION_SAVED,
          resource_type: "runtime_config_revision",
          resource_id: String(state.saved_revision),
          metadata: {
            scope: body.scope,
            changed_paths: Object.keys(body.changes).sort(),
            active_revision: state.active_revision,
            pending_restart_fields: state.pending_restart_fields,
          },
        },
        scope.db,
      );
      return state;
    } catch (error) {
      return runtimeConfigRejection(error);
    }
  },
  http: {
    method: "patch",
    path: "/v1/settings",
    tags: ["settings"],
    security: null,
    targetTenant: "body",
    body: PatchSettingsBody,
    response: ConfigStateSchema,
    success: {
      status: 200,
      description: "Revision saved; activate it explicitly when restart is not required",
    },
    errors: {
      ...UNAUTHORIZED,
      404: "Not initialized",
      409: "Revision conflict",
      422: "Invalid patch",
    },
    toInput: ({ json }) => json as PatchInput,
    toBody: (result) => result,
  },
});

export const listRuntimeRevisionsOperation = defineOperation<void, RuntimeRevision[]>({
  id: "runtime_config.revision.list",
  summary: "List immutable runtime configuration revisions",
  permission: "settings:read:global",
  effect: "read",
  handler: (scope) => listRuntimeRevisions(scope.db),
  http: {
    method: "get",
    path: "/v1/settings/revisions",
    tags: ["settings"],
    security: null,
    response: z.object({ items: z.array(RevisionSchema) }),
    success: { status: 200, description: "Revision history" },
    errors: UNAUTHORIZED,
    toInput: () => undefined,
    toBody: (revisions) => ({ items: revisions.map(revisionWire) }),
  },
});

export const getRuntimeRevisionOperation = defineOperation<RevisionInput, RuntimeRevision>({
  id: "runtime_config.revision.get",
  summary: "Read one immutable runtime configuration revision",
  permission: "settings:read:global",
  effect: "read",
  async handler(scope, input) {
    try {
      return await getRuntimeRevision(scope.db, input.revision);
    } catch (error) {
      return runtimeConfigRejection(error);
    }
  },
  http: {
    method: "get",
    path: "/v1/settings/revisions/{revision}",
    tags: ["settings"],
    security: null,
    params: RevisionParam,
    response: RevisionSchema,
    success: { status: 200, description: "Revision" },
    errors: {
      ...UNAUTHORIZED,
      404: "Not found",
      409: "Conflict",
      422: "Invalid revision",
    },
    toInput: ({ param }) => param as RevisionInput,
    toBody: (revision) => revisionWire(revision),
  },
});

export const activateRuntimeRevisionOperation = defineOperation<
  RevisionInput,
  Awaited<ReturnType<typeof activateRuntimeRevision>>
>({
  id: "runtime_config.revision.activate",
  summary: "Prepare and activate a revision after every healthy replica ACKs its digest",
  permission: "settings:write:global",
  effect: "write",
  audit: AuditAction.SETTINGS_REVISION_ACTIVATED,
  async handler(scope, { revision }) {
    const principal = scope.principal;
    if (!principal) return reject.unauthorized();
    try {
      const result = await activateRuntimeRevision(scope.db, revision, {
        tenant_id: principal.tenant_id,
        actor_type: actorTypeOf(principal),
        actor_id: principal.id,
        source: "api",
      });
      const success = result.activation_status === "active";
      const restartRequired = result.activation_status === "restart_required";
      await auditAwait(
        {
          tenant_id: principal.tenant_id,
          actor_type: actorTypeOf(principal),
          actor_id: principal.id,
          action: success
            ? AuditAction.SETTINGS_REVISION_ACTIVATED
            : restartRequired
              ? AuditAction.SETTINGS_REVISION_RESTART_REQUIRED
              : AuditAction.SETTINGS_REVISION_ACTIVATION_FAILED,
          resource_type: "runtime_config_revision",
          resource_id: String(revision),
          result: success || restartRequired ? "success" : "error",
          metadata: {
            activation_status: result.activation_status,
            replicas: result.replicas.map((replica) => ({
              instance_id: replica.instance_id,
              status: replica.status,
            })),
            pending_restart_fields: result.pending_restart_fields,
          },
        },
        scope.db,
      );
      return result;
    } catch (error) {
      return runtimeConfigRejection(error);
    }
  },
  http: {
    method: "post",
    path: "/v1/settings/revisions/{revision}/activate",
    tags: ["settings"],
    security: null,
    params: RevisionParam,
    response: ActivationResultResponse,
    success: { status: 200, description: "Activation result" },
    errors: {
      ...UNAUTHORIZED,
      404: "Not found",
      409: "Revision conflict",
      422: "Invalid revision",
    },
    toInput: ({ param }) => param as RevisionInput,
    toBody: (result) => result,
  },
});

export const getRuntimeActivationOperation = defineOperation<
  RevisionInput,
  { revision: number; replicas: Awaited<ReturnType<typeof getActivationReplicas>> }
>({
  id: "runtime_config.activation.get",
  summary: "Inspect replica leases and ACK/NACK state for a revision",
  permission: "settings:read:global",
  effect: "read",
  async handler(scope, { revision }) {
    return { revision, replicas: await getActivationReplicas(scope.db, revision) };
  },
  http: {
    method: "get",
    path: "/v1/settings/activations/{revision}",
    tags: ["settings"],
    security: null,
    params: RevisionParam,
    response: ActivationStateResponse,
    success: { status: 200, description: "Replica activation state" },
    errors: UNAUTHORIZED,
    toInput: ({ param }) => param as RevisionInput,
    toBody: ({ revision, replicas }) => ({
      revision,
      replicas: replicas.map((replica) => ({
        ...replica,
        last_seen_at: replica.last_seen_at.toISOString(),
      })),
    }),
  },
});

export const listRuntimeSecretsOperation = defineOperation<
  void,
  Awaited<ReturnType<typeof listSecretVersions>>
>({
  id: "runtime_secret.list",
  summary: "List secret-version metadata; plaintext and ciphertext are never returned",
  permission: "settings:read:global",
  effect: "read",
  handler: (scope) => listSecretVersions(scope.db),
  http: {
    method: "get",
    path: "/v1/secrets",
    tags: ["secrets"],
    security: null,
    response: SecretListResponse,
    success: { status: 200, description: "Secret registry" },
    errors: UNAUTHORIZED,
    toInput: () => undefined,
    toBody: (items) => ({
      items: items.map((item) => ({
        ...item,
        versions: item.versions.map((version) => ({
          ...version,
          created_at: version.created_at.toISOString(),
          revoked_at: version.revoked_at?.toISOString() ?? null,
        })),
      })),
    }),
  },
});

export const createRuntimeSecretOperation = defineOperation<
  SecretCreateInput,
  Awaited<ReturnType<typeof createSecretVersion>>
>({
  id: "runtime_secret.version.create",
  summary: "Create an immutable encrypted secret version",
  permission: "settings:write:global",
  effect: "write",
  audit: AuditAction.SECRET_VERSION_CREATED,
  async handler(scope, { name, value }) {
    const principal = scope.principal;
    if (!principal) return reject.unauthorized();
    try {
      const created = await createSecretVersion(scope.db, {
        name,
        value,
        created_by: principal.id,
      });
      await auditAwait(
        {
          tenant_id: principal.tenant_id,
          actor_type: actorTypeOf(principal),
          actor_id: principal.id,
          action: AuditAction.SECRET_VERSION_CREATED,
          resource_type: "runtime_secret",
          resource_id: created.reference,
          metadata: { name, version: created.version },
        },
        scope.db,
      );
      return created;
    } catch (error) {
      return runtimeConfigRejection(error);
    }
  },
  http: {
    method: "post",
    path: "/v1/secrets/{name}/versions",
    tags: ["secrets"],
    security: null,
    params: SecretParam,
    body: SecretCreateBody,
    response: SecretCreatedResponse,
    success: { status: 201, description: "Secret version created" },
    errors: {
      ...UNAUTHORIZED,
      404: "Not found",
      409: "Conflict",
      422: "Invalid secret",
    },
    toInput: ({ param, json }) => ({
      ...(param as z.infer<typeof SecretParam>),
      value: (json as z.infer<typeof SecretCreateBody>).value,
    }),
    toBody: (created) => ({ ...created, created_at: created.created_at.toISOString() }),
  },
});

export const revokeRuntimeSecretOperation = defineOperation<
  SecretVersionInput,
  Awaited<ReturnType<typeof revokeSecretVersion>>
>({
  id: "runtime_secret.version.revoke",
  summary: "Revoke an unreferenced secret version",
  permission: "settings:write:global",
  effect: "write",
  audit: AuditAction.SECRET_VERSION_REVOKED,
  async handler(scope, params) {
    const principal = scope.principal;
    if (!principal) return reject.unauthorized();
    try {
      const revoked = await revokeSecretVersion(scope.db, params);
      await auditAwait(
        {
          tenant_id: principal.tenant_id,
          actor_type: actorTypeOf(principal),
          actor_id: principal.id,
          action: AuditAction.SECRET_VERSION_REVOKED,
          resource_type: "runtime_secret",
          resource_id: `secret://${params.name}/${params.version}`,
          metadata: { name: params.name, version: params.version },
        },
        scope.db,
      );
      return revoked;
    } catch (error) {
      return runtimeConfigRejection(error);
    }
  },
  http: {
    method: "post",
    path: "/v1/secrets/{name}/versions/{version}/revoke",
    tags: ["secrets"],
    security: null,
    params: SecretVersionParam,
    response: SecretRevokedResponse,
    success: { status: 200, description: "Secret version revoked" },
    errors: {
      ...UNAUTHORIZED,
      404: "Not found",
      409: "Secret is referenced",
      422: "Invalid secret",
    },
    toInput: ({ param }) => param as SecretVersionInput,
    toBody: (revoked) => ({ ...revoked, revoked_at: revoked.revoked_at.toISOString() }),
  },
});
