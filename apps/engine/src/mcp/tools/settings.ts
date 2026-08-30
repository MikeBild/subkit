// MCP parity for SubKit's revision-less, per-leaf runtime configuration.
//
// These tools deliberately use the same config loader as the HTTP settings
// routes. A successful hot write is therefore visible to the running process
// immediately; restart-sensitive writes return an explicit activation state
// and remain visible in diagnostics until every process has restarted.

import type { Tool } from "@modelcontextprotocol/sdk/types.js";
import { z } from "zod";
import { AuditAction, auditAwait, SYSTEM_TENANT_ID } from "../../audit/index.ts";
import type { ResolvedPrincipal } from "../../auth/types.ts";
import {
  getConfig,
  getDiagnostics,
  RestartRequiredError,
  ScopeViolationError,
  setConfigKey,
  ValidationError,
} from "../../config/loader.ts";
import { dottedPath, findLeafByPath, listConfigLeaves } from "../../config/walk.ts";
import type { Db } from "../../db/client.ts";

export const SUBKIT_SETTINGS_TOOL_NAME = "subkit_settings";
export const SUBKIT_UPDATE_SETTING_TOOL_NAME = "subkit_update_setting";

const ReadSettingsArgsSchema = z
  .object({
    path: z.string().min(1).optional(),
    tenant_id: z.string().uuid().optional(),
  })
  .strict();

const UpdateSettingArgsSchema = z
  .object({
    path: z.string().min(1),
    value: z.unknown(),
    tenant_id: z.string().uuid().optional(),
    force: z.boolean().optional().default(false),
  })
  .strict();

export const subkitSettingsMcpTool: Tool = {
  name: SUBKIT_SETTINGS_TOOL_NAME,
  description:
    "Read SubKit runtime settings, effective sources, and pending-restart diagnostics. Secrets are always masked. Pass path for one dotted setting or omit it for the full catalog.",
  inputSchema: {
    type: "object",
    properties: {
      path: {
        type: "string",
        description: "Optional dotted setting path, for example log.level.",
      },
      tenant_id: {
        type: "string",
        format: "uuid",
        description: "Optional tenant overlay. Cross-tenant access requires system authority.",
      },
    },
    additionalProperties: false,
  },
};

export const subkitUpdateSettingMcpTool: Tool = {
  name: SUBKIT_UPDATE_SETTING_TOOL_NAME,
  description:
    "Update one SubKit runtime setting through the same validated hot-apply path as PUT /v1/settings/{path}. Returns whether the value is active now or requires an application restart. In production, restart-sensitive writes require force=true to persist the pending value.",
  inputSchema: {
    type: "object",
    properties: {
      path: {
        type: "string",
        description: "Dotted setting path, for example log.level.",
      },
      value: { description: "New JSON value. Its type is validated against the setting schema." },
      tenant_id: {
        type: "string",
        format: "uuid",
        description: "Optional tenant overlay. The setting must support tenant scope.",
      },
      force: {
        type: "boolean",
        default: false,
        description:
          "Persist a restart-sensitive value in production. This does not restart the app; the response still reports restart_required.",
      },
    },
    required: ["path", "value"],
    additionalProperties: false,
  },
};

type SettingSource = "override" | "tenant" | "global" | "default";

interface SettingEntry {
  path: string;
  value: unknown;
  meta: {
    source: SettingSource;
    scope: "global" | "tenant";
    sensitive: boolean;
    requires_restart: boolean;
    description?: string;
    kind: string;
  };
}

function canManageOtherTenants(principal: ResolvedPrincipal): boolean {
  if (principal.tenant_id === SYSTEM_TENANT_ID && principal.roles.includes("admin")) return true;
  return principal.scopes?.includes("settings:write:global") ?? false;
}

function readDeep(source: unknown, path: readonly string[]): unknown {
  let cursor = source;
  for (const segment of path) {
    if (typeof cursor !== "object" || cursor === null) return undefined;
    cursor = (cursor as Record<string, unknown>)[segment];
  }
  return cursor;
}

function maskedValue(secret: boolean, value: unknown): unknown {
  if (!secret || value === undefined || value === null || value === "") return value;
  return "***";
}

function sourceForLeaf(
  path: readonly string[],
  tenantId: string | undefined,
  globalSources: Record<string, SettingSource>,
): SettingSource {
  const dotted = path.join(".");
  if (!tenantId) return globalSources[dotted] ?? "default";
  const tenantOverlay = getConfig().tenants?.[tenantId];
  return readDeep(tenantOverlay, path) !== undefined
    ? "tenant"
    : (globalSources[dotted] ?? "default");
}

function settingEntry(path: string, tenantId?: string): SettingEntry | null {
  const leaf = findLeafByPath(path);
  if (!leaf) return null;
  const diagnostics = getDiagnostics();
  const dotted = dottedPath(leaf);
  return {
    path: dotted,
    value: maskedValue(!!leaf.meta.secret, readDeep(getConfig(tenantId), leaf.path)),
    meta: {
      source: sourceForLeaf(leaf.path, tenantId, diagnostics.source_map),
      scope: leaf.meta.scope ?? "global",
      sensitive: !!leaf.meta.secret,
      requires_restart: !!leaf.meta.requiresRestart,
      ...(leaf.description ? { description: leaf.description } : {}),
      kind: leaf.kind,
    },
  };
}

function invalidArguments(error: z.ZodError): {
  ok: false;
  data: { error_code: "invalid_arguments"; message: string };
} {
  const issue = error.issues[0];
  return {
    ok: false,
    data: {
      error_code: "invalid_arguments",
      message: issue
        ? `invalid arguments${issue.path.length > 0 ? ` at ${issue.path.join(".")}` : ""}: ${issue.message}`
        : "invalid arguments",
    },
  };
}

export async function handleSubkitSettings(
  ctx: { principal: ResolvedPrincipal },
  rawArgs: Record<string, unknown>,
): Promise<
  | { ok: true; data: { items: SettingEntry[]; diagnostics: ReturnType<typeof getDiagnostics> } }
  | { ok: false; data: { error_code: string; message: string } }
> {
  const parsed = ReadSettingsArgsSchema.safeParse(rawArgs);
  if (!parsed.success) return invalidArguments(parsed.error);
  const { path, tenant_id } = parsed.data;
  if (tenant_id && tenant_id !== ctx.principal.tenant_id && !canManageOtherTenants(ctx.principal)) {
    return {
      ok: false,
      data: {
        error_code: "scope_violation",
        message: `cannot read settings for tenant ${tenant_id}`,
      },
    };
  }

  if (path) {
    const item = settingEntry(path, tenant_id);
    if (!item) {
      return {
        ok: false,
        data: { error_code: "not_found", message: `unknown setting path: ${path}` },
      };
    }
    return { ok: true, data: { items: [item], diagnostics: getDiagnostics() } };
  }

  const items = listConfigLeaves()
    .map((leaf) => settingEntry(dottedPath(leaf), tenant_id))
    .filter((item): item is SettingEntry => item !== null);
  return { ok: true, data: { items, diagnostics: getDiagnostics() } };
}

export async function handleSubkitUpdateSetting(
  ctx: { db: Db; principal: ResolvedPrincipal },
  rawArgs: Record<string, unknown>,
): Promise<
  | {
      ok: true;
      data: {
        path: string;
        value: unknown;
        activation: "active" | "restart_required";
        applied_immediately: boolean;
        requires_restart: boolean;
        pending_restart_keys: string[];
      };
    }
  | {
      ok: false;
      data: {
        error_code: string;
        message: string;
        requires_restart?: boolean;
        write_applied?: boolean;
      };
    }
> {
  const parsed = UpdateSettingArgsSchema.safeParse(rawArgs);
  if (!parsed.success) return invalidArguments(parsed.error);
  const { path, value, tenant_id, force } = parsed.data;
  const leaf = findLeafByPath(path);
  if (!leaf) {
    return {
      ok: false,
      data: { error_code: "not_found", message: `unknown setting path: ${path}` },
    };
  }
  if (tenant_id && leaf.meta.scope !== "tenant") {
    return {
      ok: false,
      data: {
        error_code: "scope_violation",
        message: `${path} is global and cannot be set for one tenant`,
      },
    };
  }
  if (tenant_id && tenant_id !== ctx.principal.tenant_id && !canManageOtherTenants(ctx.principal)) {
    return {
      ok: false,
      data: {
        error_code: "scope_violation",
        message: `cannot mutate settings for tenant ${tenant_id}`,
      },
    };
  }

  try {
    const result = await setConfigKey(leaf.path, value, {
      ...(tenant_id ? { tenantId: tenant_id } : {}),
      force,
    });
    await auditAwait(
      {
        tenant_id: tenant_id ?? ctx.principal.tenant_id,
        actor_type: ctx.principal.kind === "user" ? "user" : "system_account",
        actor_id: ctx.principal.id,
        action: AuditAction.SETTINGS_CHANGED,
        resource_type: "setting",
        resource_id: result.leafPath,
        before: maskedValue(!!leaf.meta.secret, result.before),
        after: maskedValue(!!leaf.meta.secret, result.after),
        metadata: {
          scope: result.scope,
          requires_restart: result.requiresRestart,
          force_applied: force,
          request_source: "mcp",
          ...(result.reconfigureFailed ? { reconfigure_failed: true } : {}),
        },
      },
      ctx.db,
    );
    const diagnostics = getDiagnostics();
    const requiresRestart = result.requiresRestart;
    return {
      ok: true,
      data: {
        path: result.leafPath,
        value: maskedValue(!!leaf.meta.secret, result.after),
        activation: requiresRestart ? "restart_required" : "active",
        applied_immediately: !requiresRestart,
        requires_restart: requiresRestart,
        pending_restart_keys: diagnostics.pending_restart_keys,
      },
    };
  } catch (error) {
    if (error instanceof RestartRequiredError) {
      return {
        ok: false,
        data: {
          error_code: "restart_required",
          message: error.message,
          requires_restart: true,
          write_applied: false,
        },
      };
    }
    if (error instanceof ValidationError) {
      return {
        ok: false,
        data: { error_code: "validation_failed", message: error.message },
      };
    }
    if (error instanceof ScopeViolationError) {
      return {
        ok: false,
        data: { error_code: "scope_violation", message: error.message },
      };
    }
    throw error;
  }
}
