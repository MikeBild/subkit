import type { OpenAPIHono } from "@hono/zod-openapi";
import { createRoute, z } from "@hono/zod-openapi";
import { AUDIT_SOURCE_HEADER, DEPLOY_VERSION_HEADER } from "@shared/audit-source.ts";
import { ErrorSchema } from "../../api/common-schemas.ts";
import {
  AuditAction,
  AuditSourceEnum,
  actorType,
  auditAwait,
  DeployVersionSchema,
} from "../../audit/index.ts";
import {
  getConfig,
  RestartRequiredError,
  ScopeViolationError,
  setConfigKey,
  ValidationError,
} from "../../config/loader.ts";
import { type ConfigLeaf, findLeafByPath } from "../../config/walk.ts";
import { CATALOG_MODEL_PROVIDERS, modelCatalogView } from "../../llm/index.ts";
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
import {
  engineOnlyReadDenial,
  resolveSettingsReadView,
  resolveSettingWriteTarget,
} from "../../runtime-config/settings-access.ts";
import {
  maskedSettingValue,
  readSettingEntry,
  readSettingsList,
} from "../../runtime-config/settings-read.ts";
import { requireAuth } from "../middleware/auth.ts";
import { requirePermission } from "../middleware/require-permission.ts";
import type { AppEnv } from "../openapi.ts";

const LeafMetaSchema = z
  .object({
    source: z.enum(["override", "tenant", "global", "default"]),
    scope: z.enum(["global", "tenant"]),
    sensitive: z.boolean(),
    requiresRestart: z.boolean(),
    description: z.string().optional(),
    kind: z.string(),
    default: z.unknown().optional(),
    enum_values: z.array(z.string()).optional(),
  })
  .openapi("SettingLeafMeta");

const LeafEntrySchema = z
  .object({
    path: z.string(),
    value: z.unknown(),
    meta: LeafMetaSchema,
  })
  .openapi("SettingLeafEntry");

const SettingsListResponse = z
  .object({
    view: z.enum(["engine", "tenant"]),
    tenant_id: z.string().uuid().nullable(),
    saved_revision: z.number().int().positive().nullable(),
    active_revision: z.number().int().positive().nullable(),
    activation_status: z
      .enum(["saved", "preparing", "active", "failed", "restart_required"])
      .nullable(),
    pending_restart_fields: z.array(z.string()),
    items: z.array(LeafEntrySchema),
    diagnostics: z.object({
      pending_restart_keys: z.array(z.string()),
      override_keys: z.array(z.string()),
    }),
  })
  .openapi("SettingsListResponse");

const PathParam = z.object({
  path: z
    .string()
    .min(1)
    .openapi({ param: { name: "path", in: "path" } }),
});

const TenantQuery = z.object({
  tenant: z.string().uuid().optional(),
});

const PutBody = z
  .object({
    value: z.unknown(),
    force: z.boolean().optional(),
  })
  .openapi("SettingPutBody");

export type { AuditSource } from "@shared/audit-source.ts";
export { AuditSourceEnum };

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

const SettingsModelCatalogEntry = z
  .object({
    provider: z.enum(CATALOG_MODEL_PROVIDERS).nullable(),
    model: z.string(),
    display_name: z.string(),
    input_per_mtok: z.number().nonnegative(),
    output_per_mtok: z.number().nonnegative(),
    price_source: z.enum(["catalog", "override"]),
    badges: z.object({
      recommended: z.boolean(),
      economical: z.boolean(),
      capable: z.boolean(),
    }),
  })
  .openapi("SettingsModelCatalogEntry");

const SettingsModelCatalog = z
  .object({
    currency: z.string(),
    models: z.array(SettingsModelCatalogEntry),
  })
  .openapi("SettingsModelCatalog");

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

const listRoute = createRoute({
  method: "get",
  path: "/v1/settings",
  tags: ["settings"],
  summary: "List every leaf in the runtime config with its resolved value",
  request: { query: TenantQuery },
  responses: {
    200: {
      description: "All leaves (secrets masked)",
      content: { "application/json": { schema: SettingsListResponse } },
    },
    401: {
      description: "Unauthorized",
      content: { "application/json": { schema: ErrorSchema } },
    },
    403: {
      description: "Forbidden",
      content: { "application/json": { schema: ErrorSchema } },
    },
  },
});

const catalogRoute = createRoute({
  method: "get",
  path: "/v1/settings/catalog/models",
  tags: ["settings"],
  summary: "List the models the settings page offers, with prices and recommendations",
  request: { query: TenantQuery },
  responses: {
    200: {
      description: "Named models with their effective prices per 1M tokens",
      content: { "application/json": { schema: SettingsModelCatalog } },
    },
    401: {
      description: "Unauthorized",
      content: { "application/json": { schema: ErrorSchema } },
    },
    403: {
      description: "Another workspace's settings or insufficient permissions",
      content: { "application/json": { schema: ErrorSchema } },
    },
  },
});

const getRoute = createRoute({
  method: "get",
  path: "/v1/settings/{path}",
  tags: ["settings"],
  summary: "Read one leaf by dotted path",
  request: { params: PathParam, query: TenantQuery },
  responses: {
    200: {
      description: "Resolved value",
      content: { "application/json": { schema: LeafEntrySchema } },
    },
    404: {
      description: "Unknown leaf path",
      content: { "application/json": { schema: ErrorSchema } },
    },
    401: {
      description: "Unauthorized",
      content: { "application/json": { schema: ErrorSchema } },
    },
    403: {
      description:
        "Another workspace's settings, an engine-wide setting that only the engine operator can read, or insufficient permissions",
      content: { "application/json": { schema: ErrorSchema } },
    },
  },
});

const putRoute = createRoute({
  method: "put",
  path: "/v1/settings/{path}",
  tags: ["settings"],
  summary: "Write one leaf",
  request: {
    params: PathParam,
    query: TenantQuery,
    headers: PutHeaders,
    body: { content: { "application/json": { schema: PutBody } } },
  },
  responses: {
    200: {
      description: "Setting written",
      content: { "application/json": { schema: PutSuccessSchema } },
    },
    422: {
      description: "Validation failed against the leaf's Zod schema",
      content: { "application/json": { schema: ValidationFailedSchema } },
    },
    409: {
      description:
        "Setting requires a restart in production (pass force=true to apply), or a tenant write waits for the engine operator to activate saved engine-wide settings",
      content: {
        "application/json": {
          schema: z.union([RestartRequiredSchema, OperatorChangePendingSchema, ErrorSchema]),
        },
      },
    },
    403: {
      description:
        "Scope violation, a write that needs the engine operator, or insufficient permissions",
      content: {
        "application/json": { schema: z.union([ScopeViolationSchema, OperatorRequiredSchema]) },
      },
    },
    404: {
      description: "Unknown leaf path",
      content: { "application/json": { schema: ErrorSchema } },
    },
    401: {
      description: "Unauthorized",
      content: { "application/json": { schema: ErrorSchema } },
    },
  },
});

export function registerSettingsRoutes(app: OpenAPIHono<AppEnv>): void {
  app.use("/v1/settings", requirePermission("settings:read"));
  app.use("/v1/settings/*", (c, next) => {
    if (c.req.method === "GET") return requirePermission("settings:read")(c, next);
    return requirePermission("settings:write")(c, next);
  });

  app.openapi(listRoute, async (c) => {
    const principal = requireAuth(c);
    const { tenant } = c.req.valid("query");
    const access = await resolveSettingsReadView(c.get("db"), principal, tenant);
    if (!access.ok) return c.json({ code: access.code, message: access.message }, 403);
    return c.json(await readSettingsList(c.get("db"), access.view), 200);
  });

  app.use("/v1/settings/catalog/models", requirePermission("settings:read"));
  app.openapi(catalogRoute, async (c) => {
    const principal = requireAuth(c);
    const { tenant } = c.req.valid("query");
    const access = await resolveSettingsReadView(c.get("db"), principal, tenant);
    if (!access.ok) return c.json({ code: access.code, message: access.message }, 403);
    return c.json(modelCatalogView(getConfig(access.view.tenantId).tokens), 200);
  });

  app.openapi(getRoute, async (c) => {
    const principal = requireAuth(c);
    const { path } = c.req.valid("param");
    const { tenant } = c.req.valid("query");
    const access = await resolveSettingsReadView(c.get("db"), principal, tenant);
    if (!access.ok) return c.json({ code: access.code, message: access.message }, 403);
    const entry = readSettingEntry(path, access.view);
    const engineOnly = entry ? null : engineOnlyReadDenial(path, access.view);
    if (engineOnly) return c.json({ code: engineOnly.code, message: engineOnly.message }, 403);
    if (!entry) {
      return c.json({ code: "not_found", message: `unknown setting path: ${path}` }, 404);
    }
    return c.json(entry, 200);
  });

  app.openapi(putRoute, async (c) => {
    const principal = requireAuth(c);
    const { path } = c.req.valid("param");
    const { tenant: requestedTenant } = c.req.valid("query");
    const body = c.req.valid("json") as { value: unknown; force?: boolean };

    const leaf = findLeafByPath(path);
    if (!leaf) {
      return c.json({ code: "not_found", message: `unknown setting path: ${path}` }, 404);
    }
    if (path === "database.url") {
      return c.json(
        {
          code: "validation_failed" as const,
          message:
            "database.url is bootstrap-only; rotate DATABASE_URL and restart replicas instead",
          path: leaf.path,
          expected: "DATABASE_URL process binding",
        },
        422,
      );
    }

    const access = await resolveSettingWriteTarget(
      c.get("db"),
      principal,
      leaf,
      path,
      requestedTenant,
    );
    if (!access.ok) {
      return access.code === "operator_required"
        ? c.json({ code: "operator_required" as const, message: access.message }, 403)
        : c.json({ code: "scope_violation" as const, message: access.message }, 403);
    }
    const tenant = access.target.kind === "tenant" ? access.target.tenantId : undefined;
    const restricted = access.target.kind === "tenant" && access.target.restricted;

    const setOpts: { tenantId?: string; force?: boolean } = {};
    if (tenant !== undefined) setOpts.tenantId = tenant;
    if (body.force !== undefined) setOpts.force = body.force;

    const headers = c.req.valid("header");
    const auditSource = headers[AUDIT_SOURCE_HEADER] ?? null;
    const deployVersion = headers[DEPLOY_VERSION_HEADER] ?? null;

    try {
      let result: Awaited<ReturnType<typeof setConfigKey>>;
      let usedRevisionService = false;
      if (process.env.NODE_ENV === "production") {
        const db = c.get("db");
        try {
          const state = await getRuntimeConfigState(db);
          if (restricted) await assertNoPendingEngineChange(db);
          const before = readDeep(getConfig(tenant), leaf.path);
          let storedValue = body.value;
          if (
            leaf.meta.secret &&
            typeof body.value === "string" &&
            body.value.length > 0 &&
            !parseSecretReference(body.value)
          ) {
            const secretName = settingSecretName(tenant, leaf.path);
            const secret = await createSecretVersion(db, {
              name: secretName,
              value: body.value,
              created_by: principal.id,
            });
            storedValue = secret.reference;
            await auditAwait(
              {
                tenant_id: tenant ?? principal.tenant_id,
                actor_type: principal.kind === "system_account" ? "system_account" : "user",
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
              actor_type: principal.kind === "system_account" ? "system_account" : "user",
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
              actor_type: principal.kind === "system_account" ? "system_account" : "user",
              actor_id: principal.id,
              source: "api",
            },
            restricted && tenant ? { restrict_to_tenant: tenant } : {},
          );
          await auditAwait(
            {
              tenant_id: tenant ?? principal.tenant_id,
              actor_type: principal.kind === "system_account" ? "system_account" : "user",
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
          if (restartRequired && !body.force) {
            throw new RestartRequiredError(
              `${leaf.path.join(".")} was saved as revision ${saved.saved_revision} and becomes active with the next process restart (waiting for it: ${saved.pending_restart_fields.join(", ")}).`,
            );
          }
          if (!restartRequired) {
            if (activated.activation_status !== "active") {
              throw new Error(
                `runtime config revision ${saved.saved_revision} activation failed: ${activated.activation_status}`,
              );
            }
          }
          result = {
            before,
            after: body.value,
            requiresRestart: restartRequired,
            scope: tenant ? `tenant:${tenant}` : "global",
            leafPath: leaf.path.join("."),
          };
          usedRevisionService = true;
        } catch (error) {
          if (!(error instanceof RuntimeConfigNotFoundError)) throw error;
          result = await setConfigKey(leaf.path, body.value, setOpts);
        }
      } else {
        result = await setConfigKey(leaf.path, body.value, setOpts);
      }

      const db = c.get("db");
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
              force_applied: !!body.force,
              revision_service: usedRevisionService,
              ...(result.reconfigureFailed ? { reconfigure_failed: true } : {}),
              ...(auditSource ? { audit_source: auditSource } : {}),
              ...(deployVersion ? { deploy_version: deployVersion } : {}),
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

      return c.json(
        {
          value: maskedValue(leaf, result.after),
          requiresRestart: result.requiresRestart,
        },
        200,
      );
    } catch (err) {
      if (err instanceof ValidationError) {
        return c.json(
          {
            code: "validation_failed" as const,
            message: err.message,
            path: err.path,
            expected: err.expected,
          },
          422,
        );
      }
      if (err instanceof RuntimeConfigValidationError) {
        return c.json(
          {
            code: "validation_failed" as const,
            message: err.message,
            path: leaf.path,
            expected: leaf.kind,
          },
          422,
        );
      }
      if (err instanceof RuntimeConfigPendingError) {
        return c.json({ code: err.code, message: err.message }, 409);
      }
      if (err instanceof RuntimeConfigConflictError) {
        return c.json({ code: err.code, message: err.message }, 409);
      }
      if (err instanceof RestartRequiredError) {
        return c.json(
          {
            code: "restart_required" as const,
            message: err.message,
            requiresRestart: true as const,
          },
          409,
        );
      }
      if (err instanceof ScopeViolationError) {
        return c.json(
          {
            code: "scope_violation" as const,
            message: err.message,
          },
          403,
        );
      }
      throw err;
    }
  });
}
