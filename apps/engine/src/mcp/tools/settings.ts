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
import { findLeafByPath } from "../../config/walk.ts";
import type { Db } from "../../db/client.ts";
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
import {
  maskedSettingValue,
  readSettingEntry,
  readSettingsList,
  type SettingsList,
} from "../../runtime-config/settings-read.ts";

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
    "Update one SubKit runtime setting through the same immutable revision and replica-ACK path as the settings API. Returns whether the saved revision is active now or requires an application restart.",
  inputSchema: {
    type: "object",
    properties: {
      path: {
        type: "string",
        description: "Dotted setting path, for example log.level.",
      },
      value: {
        description: "New JSON value. Its type is validated against the setting schema.",
      },
      tenant_id: {
        type: "string",
        format: "uuid",
        description: "Optional tenant overlay. The setting must support tenant scope.",
      },
      force: {
        type: "boolean",
        default: false,
        description:
          "Legacy compatibility flag. Restart-sensitive revisions are saved but never activated in-process.",
      },
    },
    required: ["path", "value"],
    additionalProperties: false,
  },
};

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
  ctx: { db: Db; principal: ResolvedPrincipal },
  rawArgs: Record<string, unknown>,
): Promise<
  { ok: true; data: SettingsList } | { ok: false; data: { error_code: string; message: string } }
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
    const item = readSettingEntry(path, tenant_id);
    if (!item) {
      return {
        ok: false,
        data: {
          error_code: "not_found",
          message: `unknown setting path: ${path}`,
        },
      };
    }
    return { ok: true, data: await readSettingsList(ctx.db, tenant_id, [item]) };
  }
  return { ok: true, data: await readSettingsList(ctx.db, tenant_id) };
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
      data: {
        error_code: "not_found",
        message: `unknown setting path: ${path}`,
      },
    };
  }
  if (path === "database.url") {
    return {
      ok: false,
      data: {
        error_code: "validation_failed",
        message: "database.url is bootstrap-only; rotate DATABASE_URL and restart replicas instead",
      },
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
    let result: Awaited<ReturnType<typeof setConfigKey>>;
    let pendingRestartKeys: string[];
    if (process.env.NODE_ENV === "production") {
      try {
        const state = await getRuntimeConfigState(ctx.db);
        const before = readDeep(getConfig(tenant_id), leaf.path);
        let storedValue = value;
        if (
          leaf.meta.secret &&
          typeof value === "string" &&
          value.length > 0 &&
          !parseSecretReference(value)
        ) {
          const secretName = tenant_id
            ? `tenants.${tenant_id}.settings.${leaf.path.join(".")}`
            : `settings.${leaf.path.join(".")}`;
          const secret = await createSecretVersion(ctx.db, {
            name: secretName,
            value,
            created_by: ctx.principal.id,
          });
          storedValue = secret.reference;
          await auditAwait(
            {
              tenant_id: tenant_id ?? ctx.principal.tenant_id,
              actor_type: ctx.principal.kind === "user" ? "user" : "system_account",
              actor_id: ctx.principal.id,
              action: AuditAction.SECRET_VERSION_CREATED,
              resource_type: "runtime_secret",
              resource_id: secret.reference,
              metadata: {
                name: secret.name,
                version: secret.version,
                request_source: "mcp",
              },
            },
            ctx.db,
          );
        }
        const saved = await saveRuntimeConfigPatch(ctx.db, {
          expected_revision: state.saved_revision,
          changes: { [leaf.path.join(".")]: storedValue },
          scope: tenant_id ? "tenant" : "global",
          ...(tenant_id ? { tenant_id } : {}),
          created_by: ctx.principal.id,
        });
        await auditAwait(
          {
            tenant_id: tenant_id ?? ctx.principal.tenant_id,
            actor_type: ctx.principal.kind === "user" ? "user" : "system_account",
            actor_id: ctx.principal.id,
            action: AuditAction.SETTINGS_REVISION_SAVED,
            resource_type: "runtime_config_revision",
            resource_id: String(saved.saved_revision),
            metadata: {
              scope: tenant_id ? "tenant" : "global",
              changed_paths: [leaf.path.join(".")],
              pending_restart_fields: saved.pending_restart_fields,
              request_source: "mcp",
            },
          },
          ctx.db,
        );
        const activation = await activateRuntimeRevision(ctx.db, saved.saved_revision, {
          tenant_id: tenant_id ?? ctx.principal.tenant_id,
          actor_type: ctx.principal.kind === "user" ? "user" : "system_account",
          actor_id: ctx.principal.id,
          source: "mcp",
        });
        if (saved.pending_restart_fields.length === 0) {
          if (activation.activation_status !== "active") {
            throw new Error(
              `runtime config revision ${saved.saved_revision} activation failed: ${activation.activation_status}`,
            );
          }
        }
        await auditAwait(
          {
            tenant_id: tenant_id ?? ctx.principal.tenant_id,
            actor_type: ctx.principal.kind === "user" ? "user" : "system_account",
            actor_id: ctx.principal.id,
            action:
              activation.activation_status === "restart_required"
                ? AuditAction.SETTINGS_REVISION_RESTART_REQUIRED
                : activation.activation_status === "active"
                  ? AuditAction.SETTINGS_REVISION_ACTIVATED
                  : AuditAction.SETTINGS_REVISION_ACTIVATION_FAILED,
            resource_type: "runtime_config_revision",
            resource_id: String(saved.saved_revision),
            metadata: {
              activation_status: activation.activation_status,
              request_source: "mcp",
            },
          },
          ctx.db,
        );
        pendingRestartKeys = saved.pending_restart_fields;
        result = {
          before,
          after: value,
          requiresRestart: pendingRestartKeys.length > 0,
          scope: tenant_id ? `tenant:${tenant_id}` : "global",
          leafPath: leaf.path.join("."),
        };
      } catch (error) {
        if (!(error instanceof RuntimeConfigNotFoundError)) throw error;
        result = await setConfigKey(leaf.path, value, {
          ...(tenant_id ? { tenantId: tenant_id } : {}),
          force,
        });
        pendingRestartKeys = getDiagnostics().pending_restart_keys;
      }
    } else {
      result = await setConfigKey(leaf.path, value, {
        ...(tenant_id ? { tenantId: tenant_id } : {}),
        force,
      });
      pendingRestartKeys = getDiagnostics().pending_restart_keys;
    }
    await auditAwait(
      {
        tenant_id: tenant_id ?? ctx.principal.tenant_id,
        actor_type: ctx.principal.kind === "user" ? "user" : "system_account",
        actor_id: ctx.principal.id,
        action: AuditAction.SETTINGS_CHANGED,
        resource_type: "setting",
        resource_id: result.leafPath,
        before: maskedSettingValue(!!leaf.meta.secret, result.before),
        after: maskedSettingValue(!!leaf.meta.secret, result.after),
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
    const requiresRestart = result.requiresRestart;
    return {
      ok: true,
      data: {
        path: result.leafPath,
        value: maskedSettingValue(!!leaf.meta.secret, result.after),
        activation: requiresRestart ? "restart_required" : "active",
        applied_immediately: !requiresRestart,
        requires_restart: requiresRestart,
        pending_restart_keys: pendingRestartKeys,
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
    if (
      error instanceof RuntimeConfigValidationError ||
      error instanceof RuntimeConfigConflictError
    ) {
      return {
        ok: false,
        data: { error_code: error.code, message: error.message },
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
