import type { Tool } from "@modelcontextprotocol/sdk/types.js";
import { z } from "zod";
import { AppIdParam, type AppSummary, type AppView } from "../../api/app-schemas.ts";
import type { ResolvedPrincipal } from "../../auth/types.ts";
import { getConfig } from "../../config/loader.ts";
import type { Db } from "../../db/client.ts";
import { type AppTenant, getApp, listApps } from "../../execution/index.ts";
import { getTenant } from "../../identity/index.ts";

export const LIST_APPS_TOOL_NAME = "list_apps";
export const GET_APP_TOOL_NAME = "get_app";

const READ_ONLY_ANNOTATIONS = {
  readOnlyHint: true,
  destructiveHint: false,
  idempotentHint: true,
  openWorldHint: false,
} as const;

export const listAppsMcpTool: Tool = {
  name: LIST_APPS_TOOL_NAME,
  description:
    "List the apps of this workspace as GET /v1/apps reads them: each app's settings, sign-in and workflow counts, signed-in users, readiness and failing checks. Read-only; apps change through the products and auth.providers settings. Pass an id to get_app for sign-in, workflows, today's budget and the next action of each check.",
  inputSchema: { type: "object", properties: {}, additionalProperties: false },
  annotations: { title: "List apps", ...READ_ONLY_ANNOTATIONS },
};

export const getAppMcpTool: Tool = {
  name: GET_APP_TOOL_NAME,
  description:
    "Read one app as GET /v1/apps/{id} reads it: settings, sign-in providers, workflows, signed-in users, today's budget and every readiness check with its next action. Read-only.",
  inputSchema: {
    type: "object",
    properties: {
      id: {
        type: "string",
        maxLength: 128,
        pattern: "^[a-z0-9][a-z0-9-]*$",
        description: "The app's product_id, as list_apps returns it.",
      },
    },
    required: ["id"],
    additionalProperties: false,
  },
  annotations: { title: "Get app", ...READ_ONLY_ANNOTATIONS },
};

const GetAppArgs = z.object({ id: AppIdParam.shape.id }).strict();

type AppToolFailure = { ok: false; error_code: "invalid_args" | "not_found"; message: string };

async function tenantOf(db: Db, tenant_id: string): Promise<AppTenant | null> {
  const tenant = await getTenant(tenant_id, db);
  return tenant ? { tenant_id, tenant_slug: tenant.slug } : null;
}

export async function handleListApps(ctx: {
  db: Db;
  principal: ResolvedPrincipal;
}): Promise<{ ok: true; data: { items: AppSummary[] } } | AppToolFailure> {
  const tenant = await tenantOf(ctx.db, ctx.principal.tenant_id);
  if (!tenant) return { ok: false, error_code: "not_found", message: "tenant not found" };
  return { ok: true, data: { items: await listApps(ctx.db, tenant, getConfig()) } };
}

export async function handleGetApp(
  ctx: { db: Db; principal: ResolvedPrincipal },
  rawArgs: unknown,
): Promise<{ ok: true; data: AppView } | AppToolFailure> {
  const parsed = GetAppArgs.safeParse(rawArgs ?? {});
  if (!parsed.success) {
    return {
      ok: false,
      error_code: "invalid_args",
      message: parsed.error.issues[0]?.message ?? "invalid",
    };
  }
  const tenant = await tenantOf(ctx.db, ctx.principal.tenant_id);
  if (!tenant) return { ok: false, error_code: "not_found", message: "tenant not found" };
  const view = await getApp(ctx.db, tenant, getConfig(), parsed.data.id);
  if (!view) {
    return {
      ok: false,
      error_code: "not_found",
      message: `No app "${parsed.data.id}" is visible to this workspace. list_apps shows the visible ids.`,
    };
  }
  return { ok: true, data: view };
}
