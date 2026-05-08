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
//   - 422 validation: { code, message, path, expected }   (issue #59 wire)
//   - 409 restart-required: { code, message, requiresRestart }
// Tenant operators must have settings:write; the route additionally
// enforces that `?tenant=<id>` matches the actor's principal_tenant_id
// unless the actor has settings:write:global (operators of the system
// tenant can manage any tenant).

import type { OpenAPIHono } from "@hono/zod-openapi";
import { createRoute, z } from "@hono/zod-openapi";
import { ErrorSchema } from "../../api/common-schemas.ts";
import {
  AUDIT_SOURCE_HEADER,
  AuditAction,
  AuditSourceEnum,
  auditAwait,
  DEPLOY_VERSION_HEADER,
  DeployVersionSchema,
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
import { requireAuth } from "../middleware/auth.ts";
import { requirePermission } from "../middleware/require-permission.ts";
import type { AppEnv } from "../openapi.ts";

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

export type { AuditSource } from "../../audit/index.ts";
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
        source: sourceMap[dotted] ?? "default",
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
    401: { description: "Unauthorized", content: { "application/json": { schema: ErrorSchema } } },
    403: { description: "Forbidden", content: { "application/json": { schema: ErrorSchema } } },
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
    401: { description: "Unauthorized", content: { "application/json": { schema: ErrorSchema } } },
    403: { description: "Forbidden", content: { "application/json": { schema: ErrorSchema } } },
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
      content: { "application/json": { schema: RestartRequiredSchema } },
    },
    403: {
      description: "Scope violation or insufficient permissions",
      content: { "application/json": { schema: ScopeViolationSchema } },
    },
    404: {
      description: "Unknown leaf path",
      content: { "application/json": { schema: ErrorSchema } },
    },
    401: { description: "Unauthorized", content: { "application/json": { schema: ErrorSchema } } },
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
    if (targetTenant && targetTenant !== principal.tenant_id) {
      // Cross-tenant view requires the system tenant role; until granular
      // RBAC scopes land we approximate by requiring settings:write on the
      // caller (system operators have it; tenant-scoped roles do not).
      // The resolved set below applies regardless.
    }
    const items = buildLeafEntries(targetTenant);
    const diagnostics = getDiagnostics();
    return c.json(
      {
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
    const { path } = c.req.valid("param");
    const { tenant } = c.req.valid("query");
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
          source: sourceMap[dotted] ?? "default",
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

    // Cross-tenant guard. Only the `admin` role may target a tenant
    // overlay other than its own. Granular settings:write:global /
    // settings:write:tenant RBAC scopes are scheduled for v3.6; in v3.5
    // the role check is the supported gate.
    if (tenant && tenant !== principal.tenant_id && !principal.roles.includes("admin")) {
      return c.json(
        {
          code: "scope_violation" as const,
          message: `cannot mutate settings for tenant ${tenant} (admin role required for cross-tenant writes)`,
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

    try {
      const result = await setConfigKey(leaf.path, body.value, setOpts);

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
        const { logger: lg } = await import("../../logging/logger.ts");
        lg.error({
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
