import { z } from "@hono/zod-openapi";
import { getConfig } from "../../config/loader.ts";
import { CATALOG_MODEL_PROVIDERS, modelCatalogView } from "../../llm/index.ts";
import {
  engineOnlyReadDenial,
  resolveSettingsReadView,
} from "../../runtime-config/settings-access.ts";
import {
  readSettingEntry,
  readSettingsList,
  type SettingEntry,
  type SettingsList,
} from "../../runtime-config/settings-read.ts";
import { defineOperation, plainRejection, reject } from "./index.ts";

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

const SettingsModelCatalogEntry = z
  .object({
    provider: z.enum(CATALOG_MODEL_PROVIDERS).nullable(),
    model: z.string(),
    display_name: z.string(),
    input_per_mtok: z.number().nonnegative().nullable(),
    output_per_mtok: z.number().nonnegative().nullable(),
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

export const SettingPathParam = z.object({
  path: z
    .string()
    .min(1)
    .openapi({ param: { name: "path", in: "path" } }),
});

export const SettingsTenantQuery = z.object({
  tenant: z.string().uuid().optional(),
});

type TenantInput = z.infer<typeof SettingsTenantQuery>;
type LeafInput = z.infer<typeof SettingPathParam> & TenantInput;

export const listSettingsOperation = defineOperation<TenantInput, SettingsList>({
  id: "settings.list",
  summary: "List every leaf in the runtime config with its resolved value",
  permission: "settings:read",
  effect: "read",
  async handler(scope, { tenant }) {
    const principal = scope.principal;
    if (!principal) return reject.unauthorized();
    const access = await resolveSettingsReadView(scope.db, principal, tenant);
    if (!access.ok) return plainRejection(403, access.code, access.message);
    return readSettingsList(scope.db, access.view);
  },
  http: {
    method: "get",
    path: "/v1/settings",
    tags: ["settings"],
    security: null,
    query: SettingsTenantQuery,
    response: SettingsListResponse,
    success: { status: 200, description: "All leaves (secrets masked)" },
    errors: { 401: "Unauthorized", 403: "Forbidden" },
    toInput: ({ query }) => query as TenantInput,
    toBody: (list) => list,
  },
});

export const listSettingsModelCatalogOperation = defineOperation<
  TenantInput,
  ReturnType<typeof modelCatalogView>
>({
  id: "settings.catalog.models",
  summary: "List the models the settings page offers, with prices and recommendations",
  permission: "settings:read",
  effect: "read",
  async handler(scope, { tenant }) {
    const principal = scope.principal;
    if (!principal) return reject.unauthorized();
    const access = await resolveSettingsReadView(scope.db, principal, tenant);
    if (!access.ok) return plainRejection(403, access.code, access.message);
    return modelCatalogView(getConfig(access.view.tenantId).tokens);
  },
  http: {
    method: "get",
    path: "/v1/settings/catalog/models",
    tags: ["settings"],
    security: null,
    query: SettingsTenantQuery,
    response: SettingsModelCatalog,
    success: {
      status: 200,
      description: "Named models with their effective prices per 1M tokens",
    },
    errors: {
      401: "Unauthorized",
      403: "Another workspace's settings or insufficient permissions",
    },
    toInput: ({ query }) => query as TenantInput,
    toBody: (catalog) => catalog,
  },
});

export const getSettingOperation = defineOperation<LeafInput, SettingEntry>({
  id: "settings.get",
  summary: "Read one leaf by dotted path",
  permission: "settings:read",
  effect: "read",
  async handler(scope, { path, tenant }) {
    const principal = scope.principal;
    if (!principal) return reject.unauthorized();
    const access = await resolveSettingsReadView(scope.db, principal, tenant);
    if (!access.ok) return plainRejection(403, access.code, access.message);
    const entry = readSettingEntry(path, access.view);
    const engineOnly = entry ? null : engineOnlyReadDenial(path, access.view);
    if (engineOnly) return plainRejection(403, engineOnly.code, engineOnly.message);
    if (!entry) return plainRejection(404, "not_found", `unknown setting path: ${path}`);
    return entry;
  },
  http: {
    method: "get",
    path: "/v1/settings/{path}",
    tags: ["settings"],
    security: null,
    params: SettingPathParam,
    query: SettingsTenantQuery,
    response: LeafEntrySchema,
    success: { status: 200, description: "Resolved value" },
    errors: {
      401: "Unauthorized",
      403: "Another workspace's settings, an engine-wide setting that only the engine operator can read, or insufficient permissions",
      404: "Unknown leaf path",
    },
    toInput: ({ param, query }) => ({
      ...(param as z.infer<typeof SettingPathParam>),
      ...(query as TenantInput),
    }),
    toBody: (entry) => entry,
  },
});
