import type { Tool } from "@modelcontextprotocol/sdk/types.js";
import { z } from "zod";
import type { ResolvedPrincipal } from "../../auth/types.ts";
import type { Db } from "../../db/client.ts";
import {
  GET_APP_TOOL_NAME,
  getAppMcpTool,
  handleGetApp,
  handleListApps,
  LIST_APPS_TOOL_NAME,
  listAppsMcpTool,
} from "../../mcp/tools/apps.ts";
import { attentionMcpTool, handleAttention } from "../../mcp/tools/attention.ts";
import {
  AUTHENTICATE_TOOL_NAME,
  authenticateTool,
  handleAuthenticate,
} from "../../mcp/tools/authenticate.ts";
import {
  invokeListConnections,
  listConnectionsCategory,
  listConnectionsMcpTool,
  listConnectionsRbac,
} from "../../mcp/tools/connections.ts";
import {
  handleOperatingFigures,
  operatingFiguresMcpTool,
} from "../../mcp/tools/operating-figures.ts";
import {
  handleOperationalOverview,
  operationalOverviewMcpTool,
} from "../../mcp/tools/operational-overview.ts";
import {
  handleListRecipes,
  LIST_RECIPES_TOOL_NAME,
  listRecipesMcpTool,
} from "../../mcp/tools/recipes.ts";
import {
  handleSelfHealingScan,
  SELF_HEALING_SCAN_TOOL_NAME,
  selfHealingScanMcpTool,
} from "../../mcp/tools/self-healing-scan.ts";
import {
  handleSubkitSettings,
  handleSubkitUpdateSetting,
  SUBKIT_SETTINGS_TOOL_NAME,
  SUBKIT_UPDATE_SETTING_TOOL_NAME,
  subkitSettingsMcpTool,
  subkitUpdateSettingMcpTool,
} from "../../mcp/tools/settings.ts";
import {
  GET_TENANT_BRANDING_LOGO_TOOL_NAME,
  GET_TENANT_BRANDING_TOOL_NAME,
  getTenantBrandingLogoMcpTool,
  getTenantBrandingMcpTool,
  handleGetTenantBranding,
  handleGetTenantBrandingLogo,
  handleResetTenantBranding,
  handleUpdateTenantBranding,
  prepareTenantBrandingApprovalArgs,
  RESET_TENANT_BRANDING_TOOL_NAME,
  resetTenantBrandingMcpTool,
  UPDATE_TENANT_BRANDING_TOOL_NAME,
  updateTenantBrandingMcpTool,
} from "../../mcp/tools/tenant-branding.ts";
import {
  getVaultItemMcpTool,
  invokeGetVaultItem,
  invokeListVaultItems,
  listVaultItemsMcpTool,
} from "../../mcp/tools/vault.ts";
import type { ToolListFilter, ToolProvider, ToolRegistry } from "../registry.ts";
import type { ToolCategory, ToolDescriptor, ToolEnvelope } from "../types.ts";

interface StaticExecuteCtx {
  readonly db: Db;
  readonly principal: ResolvedPrincipal;
  readonly registry: ToolRegistry;
  readonly mcpMode?: "product" | "authoring" | "admin";
  readonly readOnly?: boolean;
  readonly resumeApproval: (tool: string, approvalId: string) => Promise<ToolEnvelope>;
}

export type StaticInvoke = (
  ctx: StaticExecuteCtx,
  args: Record<string, unknown>,
) => Promise<ToolEnvelope>;

export type StaticApprovalArgsPreparation = (
  args: Record<string, unknown>,
) => Promise<
  { ok: true; args: Record<string, unknown> } | { ok: false; error_code: string; message: string }
>;

interface StaticEntry {
  readonly tool: Tool;
  readonly visibleInMcpModes: ReadonlyArray<"product" | "authoring" | "admin"> | null;
  readonly visibleOnChat: boolean;
  readonly category: ToolCategory;
  readonly rbac?: NonNullable<ToolDescriptor["rbac"]>;
  readonly prepareApprovalArgs?: StaticApprovalArgsPreparation;
  readonly invoke: StaticInvoke;
}

function envelopeForOk(data: unknown): ToolEnvelope {
  return { status: "ok", data };
}

function envelopeForError(error_code: string, message: string, details?: unknown): ToolEnvelope {
  return { status: "error", error_code, message, ...(details !== undefined ? { details } : {}) };
}

const STATIC_ENTRIES: ReadonlyArray<StaticEntry> = [
  {
    tool: {
      name: "confirm_tool_call",
      description:
        "Execute one previously HUMAN-GRANTED SubKit tool approval. This tool does not approve anything. First show approval_url to the person and wait for their decision. Pass only the tool name and tool_call_id returned by needs_confirm; the server replays its stored arguments, rechecks access and consumes the approval once.",
      inputSchema: {
        type: "object",
        properties: {
          tool: { type: "string", minLength: 1 },
          confirm_id: { type: "string", format: "uuid" },
        },
        required: ["tool", "confirm_id"],
        additionalProperties: false,
      },
    },
    visibleInMcpModes: null,
    visibleOnChat: false,
    category: "tenant_read",
    async invoke(ctx, args) {
      const parsed = z
        .object({ tool: z.string().min(1), confirm_id: z.string().uuid() })
        .strict()
        .safeParse(args);
      if (!parsed.success || parsed.data.tool === "confirm_tool_call") {
        return envelopeForError(
          "invalid_args",
          "Pass an original tool name and its approval UUID, with no replacement arguments.",
        );
      }
      return ctx.resumeApproval(parsed.data.tool, parsed.data.confirm_id);
    },
  },
  {
    tool: operationalOverviewMcpTool,
    visibleInMcpModes: null,
    visibleOnChat: false,
    category: "tenant_read",
    rbac: { permission: "stats:read" },
    async invoke(ctx) {
      const result = await handleOperationalOverview({ db: ctx.db, principal: ctx.principal });
      return envelopeForOk(result.data);
    },
  },
  {
    tool: operatingFiguresMcpTool,
    visibleInMcpModes: null,
    visibleOnChat: false,
    category: "tenant_read",
    rbac: { permission: "stats:read" },
    async invoke(ctx, args) {
      const result = await handleOperatingFigures({ db: ctx.db, principal: ctx.principal }, args);
      if (result.ok) return envelopeForOk(result.data);
      return envelopeForError("invalid_args", result.message);
    },
  },
  {
    tool: listConnectionsMcpTool,
    visibleInMcpModes: null,
    visibleOnChat: false,
    category: listConnectionsCategory,
    rbac: listConnectionsRbac,
    invoke: (ctx) => invokeListConnections(ctx),
  },
  {
    tool: listVaultItemsMcpTool,
    visibleInMcpModes: null,
    visibleOnChat: false,
    category: "tenant_read",
    invoke: (ctx, args) => invokeListVaultItems(ctx, args),
  },
  {
    tool: getVaultItemMcpTool,
    visibleInMcpModes: null,
    visibleOnChat: false,
    category: "tenant_read",
    invoke: (ctx, args) => invokeGetVaultItem(ctx, args),
  },
  {
    tool: attentionMcpTool,
    visibleInMcpModes: null,
    visibleOnChat: false,
    category: "tenant_read",
    async invoke(ctx) {
      const result = await handleAttention({ db: ctx.db, principal: ctx.principal });
      return envelopeForOk(result.data);
    },
  },
  {
    tool: authenticateTool,
    visibleInMcpModes: null,
    visibleOnChat: false,
    category: "tenant_read",
    rbac: {
      permission: "connector:oauth",
      resource: (args) => {
        const id = (args as { connector_id?: unknown }).connector_id;
        return typeof id === "string" && id.length > 0 ? { type: "connector", id } : null;
      },
    },
    async invoke(ctx, args) {
      const result = await handleAuthenticate(
        { db: ctx.db, principal: ctx.principal },
        args as Parameters<typeof handleAuthenticate>[1],
      );
      if (result.ok) return envelopeForOk(result.data);
      return envelopeForError("authenticate_failed", JSON.stringify(result.data), result.data);
    },
  },
  {
    tool: listRecipesMcpTool,
    visibleInMcpModes: null,
    visibleOnChat: false,
    category: "tenant_read",
    async invoke(ctx, args) {
      const result = await handleListRecipes(
        { db: ctx.db, principal: ctx.principal },
        args as unknown as Parameters<typeof handleListRecipes>[1],
      );
      if (result.ok) return envelopeForOk(result.data);
      const errMsg =
        typeof (result.data as { error?: unknown })?.error === "string"
          ? (result.data as { error: string }).error
          : "list_recipes_failed";
      return envelopeForError("list_recipes_failed", errMsg, result.data);
    },
  },
  {
    tool: selfHealingScanMcpTool,
    visibleInMcpModes: ["admin"],
    visibleOnChat: false,
    category: "tenant_read",
    async invoke(ctx, args) {
      const result = await handleSelfHealingScan(
        { db: ctx.db, principal: ctx.principal },
        args as Parameters<typeof handleSelfHealingScan>[1],
      );
      if (result.ok) return envelopeForOk(result.data);
      const errMsg =
        typeof (result.data as { error?: unknown })?.error === "string"
          ? (result.data as { error: string }).error
          : "self_healing_scan_failed";
      return envelopeForError("self_healing_scan_failed", errMsg, result.data);
    },
  },
  {
    tool: subkitSettingsMcpTool,
    visibleInMcpModes: ["admin"],
    visibleOnChat: false,
    category: "tenant_read",
    rbac: { permission: "settings:read" },
    async invoke(ctx, args) {
      const result = await handleSubkitSettings({ db: ctx.db, principal: ctx.principal }, args);
      if (result.ok) return envelopeForOk(result.data);
      return envelopeForError(result.data.error_code, result.data.message, result.data);
    },
  },
  {
    tool: getTenantBrandingMcpTool,
    visibleInMcpModes: ["authoring", "admin"],
    visibleOnChat: false,
    category: "tenant_read",
    async invoke(ctx) {
      const result = await handleGetTenantBranding({ db: ctx.db, principal: ctx.principal });
      return envelopeForOk(result.data);
    },
  },
  {
    tool: getTenantBrandingLogoMcpTool,
    visibleInMcpModes: ["authoring", "admin"],
    visibleOnChat: false,
    category: "tenant_read",
    async invoke(ctx, args) {
      const result = await handleGetTenantBrandingLogo(
        { db: ctx.db, principal: ctx.principal },
        args,
      );
      if (result.ok) return envelopeForOk(result.data);
      return envelopeForError(result.data.error_code, result.data.message);
    },
  },
  {
    tool: updateTenantBrandingMcpTool,
    visibleInMcpModes: ["admin"],
    visibleOnChat: false,
    category: "tenant_write",
    rbac: { permission: "identity:write", additional_permissions: ["settings:write"] },
    prepareApprovalArgs: prepareTenantBrandingApprovalArgs,
    async invoke(ctx, args) {
      const result = await handleUpdateTenantBranding(
        { db: ctx.db, principal: ctx.principal },
        args,
      );
      if (result.ok) return envelopeForOk(result.data);
      return envelopeForError(result.data.error_code, result.data.message);
    },
  },
  {
    tool: resetTenantBrandingMcpTool,
    visibleInMcpModes: ["admin"],
    visibleOnChat: false,
    category: "tenant_write",
    rbac: { permission: "identity:write", additional_permissions: ["settings:write"] },
    async invoke(ctx, args) {
      const result = await handleResetTenantBranding(
        { db: ctx.db, principal: ctx.principal },
        args,
      );
      if (result.ok) return envelopeForOk(result.data);
      return envelopeForError(result.data.error_code, result.data.message);
    },
  },
  {
    tool: listAppsMcpTool,
    visibleInMcpModes: ["admin"],
    visibleOnChat: false,
    category: "tenant_read",
    rbac: { permission: "settings:read" },
    async invoke(ctx) {
      const result = await handleListApps({ db: ctx.db, principal: ctx.principal });
      if (result.ok) return envelopeForOk(result.data);
      return envelopeForError(result.error_code, result.message);
    },
  },
  {
    tool: getAppMcpTool,
    visibleInMcpModes: ["admin"],
    visibleOnChat: false,
    category: "tenant_read",
    rbac: { permission: "settings:read" },
    async invoke(ctx, args) {
      const result = await handleGetApp({ db: ctx.db, principal: ctx.principal }, args);
      if (result.ok) return envelopeForOk(result.data);
      return envelopeForError(result.error_code, result.message);
    },
  },
  {
    tool: subkitUpdateSettingMcpTool,
    visibleInMcpModes: ["admin"],
    visibleOnChat: false,
    category: "tenant_write",
    rbac: { permission: "settings:write" },
    async invoke(ctx, args) {
      const result = await handleSubkitUpdateSetting(
        { db: ctx.db, principal: ctx.principal },
        args,
      );
      if (result.ok) return envelopeForOk(result.data);
      return envelopeForError(result.data.error_code, result.data.message, result.data);
    },
  },
];

export interface StaticProviderEntry {
  readonly kind: "static";
  readonly tool: Tool;
  readonly toolName: string;
  readonly prepareApprovalArgs?: StaticApprovalArgsPreparation;
  readonly invoke: StaticInvoke;
}

function descriptorOf(entry: StaticEntry): ToolDescriptor {
  return {
    name: entry.tool.name,
    description: entry.tool.description ?? "",
    category: entry.category,
    inputSchema: entry.tool.inputSchema,
    ...(entry.rbac ? { rbac: entry.rbac } : {}),
  };
}

function isVisible(entry: StaticEntry, filter: ToolListFilter): boolean {
  if (filter.surface === "chat") return entry.visibleOnChat;
  if (entry.visibleInMcpModes === null) return true;
  if (filter.mcpMode === undefined) return false;
  return entry.visibleInMcpModes.includes(filter.mcpMode);
}

export const staticToolProvider: ToolProvider = {
  name: "StaticToolProvider",
  list(filter) {
    const out: ToolDescriptor[] = [];
    for (const e of STATIC_ENTRIES) {
      if (!isVisible(e, filter)) continue;
      out.push(descriptorOf(e));
    }
    return out;
  },
  resolve(name, filter) {
    const e = STATIC_ENTRIES.find((x) => x.tool.name === name);
    if (!e) return undefined;
    if (!isVisible(e, filter)) return undefined;
    const entry: StaticProviderEntry = {
      kind: "static",
      tool: e.tool,
      toolName: e.tool.name,
      ...(e.prepareApprovalArgs ? { prepareApprovalArgs: e.prepareApprovalArgs } : {}),
      invoke: e.invoke,
    };
    return { descriptor: descriptorOf(e), executor: entry };
  },
};

export {
  AUTHENTICATE_TOOL_NAME,
  GET_APP_TOOL_NAME,
  GET_TENANT_BRANDING_LOGO_TOOL_NAME,
  GET_TENANT_BRANDING_TOOL_NAME,
  LIST_APPS_TOOL_NAME,
  LIST_RECIPES_TOOL_NAME,
  RESET_TENANT_BRANDING_TOOL_NAME,
  SELF_HEALING_SCAN_TOOL_NAME,
  SUBKIT_SETTINGS_TOOL_NAME,
  SUBKIT_UPDATE_SETTING_TOOL_NAME,
  UPDATE_TENANT_BRANDING_TOOL_NAME,
};
