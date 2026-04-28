// GET /v1/settings — list every registered setting with its resolved
// value (secrets masked).
//
// GET /v1/settings/:key — read one setting; tenant-scope resolves
// against the caller's tenant_id, falling back to global, then default.
//
// PUT /v1/settings/:key — write one setting. The route inspects the
// registry to decide whether to call setGlobal or setTenant; the
// caller does not have to know.
//
// All routes require `settings:read` for GET and `settings:write` for
// PUT. Secrets are masked in every response — call sites that need the
// live value go through the in-process `settings.get()` helper instead.

import type { OpenAPIHono } from "@hono/zod-openapi";
import { createRoute, z } from "@hono/zod-openapi";
import { ErrorSchema } from "../../api/common-schemas.ts";
import { getDb } from "../../db/client.ts";
import { getSpec, list, maskValue, setGlobal, setTenant } from "../../settings/index.ts";
import { requireAuth } from "../middleware/auth.ts";
import { requirePermission } from "../middleware/require-permission.ts";
import type { AppEnv } from "../openapi.ts";

// -------- schemas --------

const ListedSettingSchema = z
  .object({
    key: z.string(),
    label: z.string(),
    description: z.string(),
    scope: z.enum(["global", "tenant"]),
    category: z.string(),
    secret: z.boolean(),
    value: z.unknown(),
    is_default: z.boolean(),
  })
  .openapi("ListedSetting");

const SettingValueSchema = z
  .object({
    key: z.string(),
    scope: z.enum(["global", "tenant"]),
    secret: z.boolean(),
    value: z.unknown(),
    is_default: z.boolean(),
  })
  .openapi("SettingValue");

const SettingsListResponse = z
  .object({
    items: z.array(ListedSettingSchema),
  })
  .openapi("SettingsListResponse");

const KeyParam = z.object({
  key: z
    .string()
    .min(1)
    .openapi({ param: { name: "key", in: "path" } }),
});

const PutBody = z
  .object({
    value: z.unknown(),
  })
  .openapi("SettingPutBody");

// -------- routes --------

const listRoute = createRoute({
  method: "get",
  path: "/v1/settings",
  tags: ["settings"],
  summary: "List every registered setting with its resolved value",
  responses: {
    200: {
      description: "All settings (secrets masked)",
      content: { "application/json": { schema: SettingsListResponse } },
    },
    401: { description: "Unauthorized", content: { "application/json": { schema: ErrorSchema } } },
    403: { description: "Forbidden", content: { "application/json": { schema: ErrorSchema } } },
  },
});

const getRoute = createRoute({
  method: "get",
  path: "/v1/settings/{key}",
  tags: ["settings"],
  summary: "Read one setting (tenant override resolves first when scope=tenant)",
  request: { params: KeyParam },
  responses: {
    200: {
      description: "Resolved value (masked when secret)",
      content: { "application/json": { schema: SettingValueSchema } },
    },
    404: {
      description: "Unknown setting key",
      content: { "application/json": { schema: ErrorSchema } },
    },
    401: { description: "Unauthorized", content: { "application/json": { schema: ErrorSchema } } },
    403: { description: "Forbidden", content: { "application/json": { schema: ErrorSchema } } },
  },
});

const putRoute = createRoute({
  method: "put",
  path: "/v1/settings/{key}",
  tags: ["settings"],
  summary: "Write one setting (scope inferred from the registry)",
  request: {
    params: KeyParam,
    body: { content: { "application/json": { schema: PutBody } } },
  },
  responses: {
    200: {
      description: "Setting written; updated value returned (masked when secret)",
      content: { "application/json": { schema: SettingValueSchema } },
    },
    400: {
      description: "Validation failed against the setting's Zod schema",
      content: { "application/json": { schema: ErrorSchema } },
    },
    404: {
      description: "Unknown setting key",
      content: { "application/json": { schema: ErrorSchema } },
    },
    401: { description: "Unauthorized", content: { "application/json": { schema: ErrorSchema } } },
    403: { description: "Forbidden", content: { "application/json": { schema: ErrorSchema } } },
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
    const db = c.get("db") ?? getDb();
    const items = await list(db, { tenant_id: principal.tenant_id });
    return c.json({ items }, 200);
  });

  app.openapi(getRoute, async (c) => {
    const principal = requireAuth(c);
    const { key } = c.req.valid("param");
    const spec = getSpec(key);
    if (!spec) {
      return c.json({ code: "not_found", message: `unknown setting key: ${key}` }, 404);
    }
    const db = c.get("db") ?? getDb();
    const all = await list(db, { tenant_id: principal.tenant_id });
    const row = all.find((s) => s.key === key);
    if (!row) {
      return c.json({ code: "not_found", message: `unknown setting key: ${key}` }, 404);
    }
    return c.json(
      {
        key: row.key,
        scope: row.scope,
        secret: row.secret,
        value: row.value,
        is_default: row.is_default,
      },
      200,
    );
  });

  app.openapi(putRoute, async (c) => {
    const principal = requireAuth(c);
    const { key } = c.req.valid("param");
    const body = c.req.valid("json") as { value: unknown };
    const spec = getSpec(key);
    if (!spec) {
      return c.json({ code: "not_found", message: `unknown setting key: ${key}` }, 404);
    }
    const db = c.get("db") ?? getDb();
    try {
      if (spec.scope === "global") {
        await setGlobal(db, key, body.value, { actor_id: principal.id });
      } else {
        await setTenant(db, key, body.value, principal.tenant_id, {
          actor_id: principal.id,
        });
      }
    } catch (err) {
      // Zod parse failures bubble up here — surface as 400 with the
      // structured message rather than a 500.
      const message = err instanceof Error ? err.message : String(err);
      return c.json({ code: "validation_failed", message }, 400);
    }
    return c.json(
      {
        key,
        scope: spec.scope,
        secret: Boolean(spec.secret),
        value: maskValue(spec, body.value),
        is_default: false,
      },
      200,
    );
  });
}
