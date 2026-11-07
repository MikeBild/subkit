import type { Tool } from "@modelcontextprotocol/sdk/types.js";
import { z } from "zod";
import type { ResolvedPrincipal } from "../../auth/types.ts";
import type { Db } from "../../db/client.ts";
import {
  engineOnlyReadDenial,
  resolveSettingsReadView,
} from "../../runtime-config/settings-access.ts";
import {
  readSettingEntry,
  readSettingsList,
  type SettingsList,
} from "../../runtime-config/settings-read.ts";
import { writeSetting } from "../../runtime-config/settings-write.ts";

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
        description:
          "Optional tenant overlay. Only the engine operator reads the engine view or another tenant; everyone else sees their own workspace's tenant settings.",
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
        description:
          "Tenant overlay. The setting must support tenant scope. Required unless you are the engine operator: a change without it applies to the whole engine.",
      },
      force: {
        type: "boolean",
        default: false,
        description:
          "Confirm that the change waits for a restart. Without it, a write to a setting that needs a restart still saves the revision and answers restart_required with write_applied true and saved_revision; with it the same revision is saved and the call succeeds with activation restart_required. Either way the revision becomes active with the next engine restart. Without the revision service, a write without force saves nothing, and with force it applies in this process.",
      },
    },
    required: ["path", "value"],
    additionalProperties: false,
  },
};

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
  const access = await resolveSettingsReadView(ctx.db, ctx.principal, tenant_id);
  if (!access.ok) {
    return { ok: false, data: { error_code: access.code, message: access.message } };
  }

  if (path) {
    const item = readSettingEntry(path, access.view);
    const engineOnly = item ? null : engineOnlyReadDenial(path, access.view);
    if (engineOnly) {
      return { ok: false, data: { error_code: engineOnly.code, message: engineOnly.message } };
    }
    if (!item) {
      return {
        ok: false,
        data: {
          error_code: "not_found",
          message: `unknown setting path: ${path}`,
        },
      };
    }
    return { ok: true, data: await readSettingsList(ctx.db, access.view, [item]) };
  }
  return { ok: true, data: await readSettingsList(ctx.db, access.view) };
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
        saved_revision?: number;
        activation?: "restart_required";
        pending_restart_keys?: string[];
        hint?: string;
      };
    }
> {
  const parsed = UpdateSettingArgsSchema.safeParse(rawArgs);
  if (!parsed.success) return invalidArguments(parsed.error);
  const { path, value, tenant_id, force } = parsed.data;
  const outcome = await writeSetting({
    db: ctx.db,
    principal: ctx.principal,
    path,
    tenant: tenant_id,
    value,
    force,
    surface: "mcp",
    requestSource: "mcp",
    auditSource: null,
    deployVersion: null,
  });
  if (!outcome.ok) {
    if (outcome.code === "restart_required" && outcome.savedRevision !== undefined) {
      return {
        ok: false,
        data: {
          error_code: outcome.code,
          message: outcome.message,
          requires_restart: true,
          write_applied: true,
          saved_revision: outcome.savedRevision,
          activation: "restart_required",
          pending_restart_keys: outcome.pendingRestartKeys ?? [],
          hint: `Revision ${outcome.savedRevision} is saved and becomes active with the next engine restart; do not repeat this write. force: true only turns this answer into a success, it does not activate the revision sooner.`,
        },
      };
    }
    if (outcome.code === "restart_required") {
      return {
        ok: false,
        data: {
          error_code: outcome.code,
          message: outcome.message,
          requires_restart: true,
          write_applied: false,
          hint: "Nothing was saved. Call subkit_update_setting again with force: true to apply the value in this process.",
        },
      };
    }
    return { ok: false, data: { error_code: outcome.code, message: outcome.message } };
  }
  return {
    ok: true,
    data: {
      path: outcome.path,
      value: outcome.value,
      activation: outcome.requiresRestart ? "restart_required" : "active",
      applied_immediately: !outcome.requiresRestart,
      requires_restart: outcome.requiresRestart,
      pending_restart_keys: outcome.pendingRestartKeys,
    },
  };
}
