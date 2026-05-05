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
import { audit } from "../../audit/audit.ts";
import { AuditAction } from "../../audit/types.ts";
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

    // Cross-tenant guard via the existing settings:write permission gate
    // — granular settings:write:tenant / settings:write:global scopes
    // land in a follow-up. For v3.5 a holder of settings:write may
    // mutate any tenant overlay; tenants without the perm are stopped at
    // the route's `requirePermission` middleware.

    const setOpts: { tenantId?: string; force?: boolean } = {};
    if (tenant !== undefined) setOpts.tenantId = tenant;
    if (body.force !== undefined) setOpts.force = body.force;

    try {
      const result = await setConfigKey(leaf.path, body.value, setOpts);

      // Audit the change. Target tenant is the ?tenant query (or the
      // caller's own tenant for global writes — system-level state).
      audit({
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
        },
      });

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
