// GET /v1/settings[?tenant=<id>] — return the effective config tree
// (deep-merged for the tenant if provided), with sensitive leaves
// masked, plus a parallel `_meta` tree per leaf.
//
// GET /v1/settings/{path}[?tenant=<id>] — one leaf by dotted path.
//
// PUT /v1/settings/{path}[?tenant=<id>] — write one leaf. Scope rules:
//   - `?tenant=<id>` set + leaf scope=global   → 403 scope_violation
//   - `?tenant=<id>` set + leaf scope=tenant   → write tenant overlay
//   - `?tenant=<id>` unset + leaf scope=tenant → write global default
//   - `?tenant=<id>` unset + leaf scope=global → write global
// Three response envelopes:
//   - 200 success: { value, requiresRestart }
//   - 422 validation: { code, message, path, expected }
//   - 409 restart-required: { code, message, requiresRestart }
// Tenant operators must have settings:write; the route additionally
// enforces that `?tenant=<id>` matches the actor's principal_tenant_id
// unless the actor has settings:write:global (operators of the system
// tenant can manage any tenant).

import type { OpenAPIHono } from "@hono/zod-openapi";
import { createRoute, z } from "@hono/zod-openapi";
// Header names + allowed values come from the shared package directly
// — the engine's audit/audit-source.ts only adds the Zod wrappers.
import { AUDIT_SOURCE_HEADER, DEPLOY_VERSION_HEADER } from "@shared/audit-source.ts";
import { ErrorSchema } from "../../api/common-schemas.ts";
// `@shared` is a separate package, so importing the constants above
// satisfies the route_layering invariant. The engine-side Zod
// wrappers and audit helpers go through the audit subsystem's
// barrel `index.ts` per AGENTS.md.
import {
  AuditAction,
  AuditSourceEnum,
  auditAwait,
  DeployVersionSchema,
  SYSTEM_TENANT_ID,
} from "../../audit/index.ts";
import {
  getConfig,
  getDiagnostics,
  RestartRequiredError,
  ScopeViolationError,
  setConfigKey,
  ValidationError,
} from "../../config/loader.ts";
import {
  type ConfigLeaf,
  dottedPath,
  findLeafByPath,
  listConfigLeaves,
} from "../../config/walk.ts";
import { logger } from "../../logging/index.ts";
import {
  activateRuntimeRevision,
  createSecretVersion,
  getRuntimeConfigState,
  parseSecretReference,
  RuntimeConfigConflictError,
  RuntimeConfigNotFoundError,
  RuntimeConfigValidationError,
  saveRuntimeConfigPatch,
} from "../../runtime-config/service.ts";
import { requireAuth } from "../middleware/auth.ts";
import { requirePermission } from "../middleware/require-permission.ts";
import type { AppEnv } from "../openapi.ts";

// Cross-tenant authority. A bare `roles.includes("admin")` is NOT a
// platform-admin check: every tenant's own bootstrap admin holds the
// shared built-in "admin" role (role definition tenant_id is null, but it
// is assigned per-tenant), so that test let any tenant admin read/write
// any OTHER tenant's settings. Per this route's documented contract,
// cross-tenant management belongs to operators of the SYSTEM tenant (or a
// principal explicitly granted the global settings scope). In the common
// single-tenant deployment `?tenant` always equals the actor's own tenant,
// so this branch never triggers.
function canManageOtherTenants(principal: ReturnType<typeof requireAuth>): boolean {
  if (principal.tenant_id === SYSTEM_TENANT_ID && principal.roles.includes("admin")) {
    return true;
  }
  return principal.scopes?.includes("settings:write:global") ?? false;
}

// -------- schemas --------

const LeafMetaSchema = z
  .object({
    source: z.enum(["override", "tenant", "global", "default"]),
    scope: z.enum(["global", "tenant"]),
    sensitive: z.boolean(),
    requiresRestart: z.boolean(),
    description: z.string().optional(),
    kind: z.string(),
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
// X-Subkit-Audit-Source + X-Subkit-Deploy-Version are validated as
// Zod-typed headers on the PUT route boundary; their taxonomy is
// owned by `audit/audit-source.ts` (re-exported here for downstream
// imports that came in before the move).
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

// -------- helpers --------

function leafKindLabel(leaf: ConfigLeaf): string {
  return leaf.kind;
}

function maskedValue(leaf: ConfigLeaf, value: unknown): unknown {
  if (!leaf.meta.secret) return value;
  if (value === undefined || value === null || value === "") return value;
  return "***";
}

function readDeep(source: unknown, leafPath: string[]): unknown {
  let cursor: unknown = source;
  for (const seg of leafPath) {
    if (typeof cursor !== "object" || cursor === null) return undefined;
    cursor = (cursor as Record<string, unknown>)[seg];
  }
  return cursor;
}

function sourceForLeaf(
  leaf: ConfigLeaf,
  tenantId: string | undefined,
  globalSourceMap: Record<string, "override" | "tenant" | "global" | "default">,
): "override" | "tenant" | "global" | "default" {
  const dotted = dottedPath(leaf);
  if (!tenantId) return globalSourceMap[dotted] ?? "default";
  const tenantOverlay = getConfig().tenants?.[tenantId];
  return readDeep(tenantOverlay, leaf.path) !== undefined
    ? "tenant"
    : (globalSourceMap[dotted] ?? "default");
}

function buildLeafEntries(tenantId: string | undefined): Array<z.infer<typeof LeafEntrySchema>> {
  const cfg = getConfig(tenantId);
  const sourceMap = getDiagnostics().source_map;
  const items: Array<z.infer<typeof LeafEntrySchema>> = [];

  for (const leaf of listConfigLeaves()) {
    const dotted = dottedPath(leaf);
    const liveValue = readDeep(cfg, leaf.path);
    items.push({
      path: dotted,
      value: maskedValue(leaf, liveValue),
      meta: {
        source: sourceForLeaf(leaf, tenantId, sourceMap),
        scope: leaf.meta.scope ?? "global",
        sensitive: !!leaf.meta.secret,
        requiresRestart: !!leaf.meta.requiresRestart,
        ...(leaf.description ? { description: leaf.description } : {}),
        kind: leafKindLabel(leaf),
      },
    });
  }
  return items;
}

// -------- routes --------

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
      description: "Forbidden",
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
      description: "Setting requires a restart in production; pass force=true to apply",
      content: {
        "application/json": { schema: z.union([RestartRequiredSchema, ErrorSchema]) },
      },
    },
    403: {
      description: "Scope violation or insufficient permissions",
      content: { "application/json": { schema: ScopeViolationSchema } },
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

// -------- registration --------

export function registerSettingsRoutes(app: OpenAPIHono<AppEnv>): void {
  app.use("/v1/settings", requirePermission("settings:read"));
  app.use("/v1/settings/*", (c, next) => {
    if (c.req.method === "GET") return requirePermission("settings:read")(c, next);
    return requirePermission("settings:write")(c, next);
  });

  app.openapi(listRoute, async (c) => {
    const principal = requireAuth(c);
    const { tenant } = c.req.valid("query");
    const targetTenant = tenant ?? undefined;
    if (targetTenant && targetTenant !== principal.tenant_id && !canManageOtherTenants(principal)) {
      return c.json(
        {
          code: "scope_violation" as const,
          message: `cannot read settings for tenant ${targetTenant} (system-tenant operator required for cross-tenant reads)`,
        },
        403,
      );
    }
    const items = buildLeafEntries(targetTenant);
    const diagnostics = getDiagnostics();
    let runtimeState: Awaited<ReturnType<typeof getRuntimeConfigState>> | null = null;
    try {
      runtimeState = await getRuntimeConfigState(c.get("db"));
    } catch (error) {
      if (!(error instanceof RuntimeConfigNotFoundError)) throw error;
    }
    return c.json(
      {
        saved_revision: runtimeState?.saved_revision ?? null,
        active_revision: runtimeState?.active_revision ?? null,
        activation_status: runtimeState?.activation_status ?? null,
        pending_restart_fields:
          runtimeState?.pending_restart_fields ?? diagnostics.pending_restart_keys,
        items,
        diagnostics: {
          pending_restart_keys: diagnostics.pending_restart_keys,
          override_keys: diagnostics.override_keys,
        },
      },
      200,
    );
  });

  app.openapi(getRoute, async (c) => {
    const principal = requireAuth(c);
    const { path } = c.req.valid("param");
    const { tenant } = c.req.valid("query");
    if (tenant && tenant !== principal.tenant_id && !canManageOtherTenants(principal)) {
      return c.json(
        {
          code: "scope_violation" as const,
          message: `cannot read settings for tenant ${tenant} (system-tenant operator required for cross-tenant reads)`,
        },
        403,
      );
    }
    const leaf = findLeafByPath(path);
    if (!leaf) {
      return c.json({ code: "not_found", message: `unknown setting path: ${path}` }, 404);
    }
    const cfg = getConfig(tenant);
    const sourceMap = getDiagnostics().source_map;
    const dotted = dottedPath(leaf);
    return c.json(
      {
        path: dotted,
        value: maskedValue(leaf, readDeep(cfg, leaf.path)),
        meta: {
          source: sourceForLeaf(leaf, tenant, sourceMap),
          scope: leaf.meta.scope ?? "global",
          sensitive: !!leaf.meta.secret,
          requiresRestart: !!leaf.meta.requiresRestart,
          ...(leaf.description ? { description: leaf.description } : {}),
          kind: leafKindLabel(leaf),
        },
      },
      200,
    );
  });

  app.openapi(putRoute, async (c) => {
    const principal = requireAuth(c);
    const { path } = c.req.valid("param");
    const { tenant } = c.req.valid("query");
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

    // Scope guard: when ?tenant is set, the leaf must be scope:tenant.
    if (tenant && leaf.meta.scope !== "tenant") {
      return c.json(
        {
          code: "scope_violation" as const,
          message: `${path} is scope="global"; cannot be set per-tenant`,
        },
        403,
      );
    }

    // Cross-tenant guard. Only a SYSTEM-tenant operator (or a principal
    // granted the global settings scope) may target a tenant overlay other
    // than its own — a tenant's own "admin" role must not reach across the
    // tenant boundary. See canManageOtherTenants.
    if (tenant && tenant !== principal.tenant_id && !canManageOtherTenants(principal)) {
      return c.json(
        {
          code: "scope_violation" as const,
          message: `cannot mutate settings for tenant ${tenant} (system-tenant operator required for cross-tenant writes)`,
        },
        403,
      );
    }

    const setOpts: { tenantId?: string; force?: boolean } = {};
    if (tenant !== undefined) setOpts.tenantId = tenant;
    if (body.force !== undefined) setOpts.force = body.force;

    // X-Subkit-Audit-Source + X-Subkit-Deploy-Version — both validated
    // by Zod on the putRoute headers schema, so by the time we read
    // them they're either undefined or known-good. The route boundary
    // is the only place these headers are parsed; downstream code is
    // type-safe.
    const headers = c.req.valid("header");
    const auditSource = headers[AUDIT_SOURCE_HEADER] ?? null;
    const deployVersion = headers[DEPLOY_VERSION_HEADER] ?? null;

    // Surface untagged settings writes so an operator dashboard can
    // see who is still on a pre-4.2.0 client (or a misconfigured
    // 4.2.0+ caller). Compliance review queries against
    // `audit_log.metadata.audit_source` will show a `null` bucket;
    // this log line maps each null back to a principal_id so the
    // bucket can be drained over time. Once-per-PUT, info-level —
    // not a gate, just observability.
    if (!auditSource) {
      logger.info({
        module: "audit",
        action: "settings.changed.untagged",
        msg: "settings PUT landed without x-subkit-audit-source — pre-4.2.0 client or misconfigured caller",
        leaf: leaf.path.join("."),
        actor_id: principal.id,
        principal_kind: principal.kind,
        tenant_id: tenant ?? principal.tenant_id,
      });
    }

    try {
      let result: Awaited<ReturnType<typeof setConfigKey>>;
      let usedRevisionService = false;
      if (process.env.NODE_ENV === "production") {
        const db = c.get("db");
        try {
          const state = await getRuntimeConfigState(db);
          const before = readDeep(getConfig(tenant), leaf.path);
          let storedValue = body.value;
          if (
            leaf.meta.secret &&
            typeof body.value === "string" &&
            body.value.length > 0 &&
            !parseSecretReference(body.value)
          ) {
            const secretName = tenant
              ? `tenants.${tenant}.settings.${leaf.path.join(".")}`
              : `settings.${leaf.path.join(".")}`;
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
                  source: "legacy_leaf_adapter",
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
                source: "legacy_leaf_adapter",
              },
            },
            db,
          );
          const restartRequired = saved.pending_restart_fields.length > 0;
          const activated = await activateRuntimeRevision(db, saved.saved_revision);
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
                source: "legacy_leaf_adapter",
              },
            },
            db,
          );
          if (restartRequired && !body.force) {
            throw new RestartRequiredError(
              `${leaf.path.join(".")} was saved as revision ${saved.saved_revision} and requires a process restart before activation.`,
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

      // Audit the change against the request-bound db so test setups
      // that point Hono at a testcontainer (and not the engine's own
      // pool) still write the row to the right place. Production
      // boot wires `c.get("db")` to the same pool getDb() returns.
      // before/after carry the masked primitive value directly —
      // matches the existing audit_log convention used by other
      // resource_types (credential / knowledge_source / workflow).
      const db = c.get("db");
      try {
        await auditAwait(
          {
            tenant_id: tenant ?? principal.tenant_id,
            actor_type: "user",
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
        // Audit row failed AFTER the in-memory + on-disk write
        // already landed. The compliance ledger is now out of sync
        // with the live state. Surface a `setting.apply_failed` log
        // so an operator dashboard catches the divergence, then
        // rethrow so the route returns 500 (the catch below maps
        // unhandled errors). The previously-applied write remains
        // in effect — rolling it back would require a second write
        // that could itself fail and compound the divergence.
        //
        // Use the static `logger` (not a dynamic import): a dynamic
        // import that itself throws (filesystem race, ESM module-graph
        // corruption mid-request) would HIDE the original audit-failure
        // error — exactly the divergence this catch is supposed to
        // surface.
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
