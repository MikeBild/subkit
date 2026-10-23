import type {
  ConversationTool,
  ToolCategory,
  ToolContext,
  ToolResult,
} from "../../conversations/tools/index.ts";
import { listTools } from "../../conversations/tools/index.ts";
import { DRAFT_WRITE_MCP_UNAVAILABLE_REASON } from "../policy.ts";
import type { ToolListFilter, ToolProvider } from "../registry.ts";
import type { ToolDescriptor, ToolSurface } from "../types.ts";

export type { ToolDescriptor } from "../types.ts";

export type ConversationToolExecutor = (ctx: ToolContext, args: unknown) => Promise<ToolResult>;

export interface ConversationProviderEntry {
  readonly kind: "conversation";
  readonly tool: ConversationTool;
  readonly execute: ConversationToolExecutor;
}

const PRODUCT_MODE_ALLOW_LIST: ReadonlySet<string> = new Set([
  "match_connector_template_by_url",
  "test_connector",
  "inspect_recipe",
  "probe_connector_draft",
  "find_workflow",
  "run_workflow",
  "get_execution",
]);

function visibilityFor(
  category: ToolCategory,
  surface: ToolSurface,
): "visible" | "disabled" | "hidden" {
  if (surface === "chat") return "visible";
  if (category === "draft_write") return "disabled";
  return "visible";
}

function describeDisabled(category: ToolCategory): { reason: string } | undefined {
  if (category === "draft_write") {
    return { reason: DRAFT_WRITE_MCP_UNAVAILABLE_REASON };
  }
  return undefined;
}

const RBAC_OVERRIDES: Readonly<Record<string, NonNullable<ToolDescriptor["rbac"]>>> = {
  inspect_execution: {
    permission: "execution:read",
    resource: (args) => {
      const id = (args as { execution_id?: unknown }).execution_id;
      return typeof id === "string" && id.length > 0 ? { type: "execution", id } : null;
    },
  },
  test_connector: {
    permission: "connector:test",
    resource: (args) => {
      const id = (args as { connector_id?: unknown }).connector_id;
      return typeof id === "string" && id.length > 0 ? { type: "connector", id } : null;
    },
  },
  import_connector_from_spec: {
    permission: "connector:write",
  },
  save_connector_draft: {
    permission: "connector:write",
  },
  authenticate_oauth: {
    permission: "connector:oauth",
  },
  edit_role: {
    permission: "rbac:write",
    resource: (args) => {
      const id = (args as { role_id?: unknown }).role_id;
      return typeof id === "string" && id.length > 0 ? { type: "role", id } : null;
    },
  },
  create_knowledge_source: {
    permission: "knowledge:write",
  },
  save_learning: {
    permission: "skill:propose",
  },
  update_knowledge_source: {
    permission: "knowledge:write",
    resource: (args) => {
      const id = (args as { id?: unknown }).id;
      return typeof id === "string" && id.length > 0 ? { type: "knowledge", id } : null;
    },
  },
  analyze_knowledge_source: {
    permission: "knowledge:write",
    resource: (args) => {
      const id = (args as { id?: unknown }).id;
      return typeof id === "string" && id.length > 0 ? { type: "knowledge", id } : null;
    },
  },
  delete_knowledge_source: {
    permission: "knowledge:delete",
    resource: (args) => {
      const id = (args as { id?: unknown }).id;
      return typeof id === "string" && id.length > 0 ? { type: "knowledge", id } : null;
    },
  },
  update_skill: {
    permission: "skill:write",
    resource: (args) => {
      const id = (args as { id?: unknown }).id;
      return typeof id === "string" && id.length > 0 ? { type: "skill", id } : null;
    },
  },
  delete_skill: {
    permission: "skill:delete",
    resource: (args) => {
      const id = (args as { id?: unknown }).id;
      return typeof id === "string" && id.length > 0 ? { type: "skill", id } : null;
    },
  },
  approve_skill_candidate: {
    permission: "skill:write",
    resource: (args) => {
      const ids = (args as { candidate_ids?: unknown }).candidate_ids;
      const id = Array.isArray(ids) ? ids[0] : (args as { candidate_id?: unknown }).candidate_id;
      return typeof id === "string" && id.length > 0 ? { type: "skill_candidate", id } : null;
    },
  },
  reject_skill_candidate: {
    permission: "skill:write",
    resource: (args) => {
      const ids = (args as { candidate_ids?: unknown }).candidate_ids;
      const id = Array.isArray(ids) ? ids[0] : undefined;
      return typeof id === "string" && id.length > 0 ? { type: "skill_candidate", id } : null;
    },
  },
  restore_workflow_version: {
    permission: "workflow:restore",
    resource: (args) => {
      const id = (args as { workflow_id?: unknown }).workflow_id;
      return typeof id === "string" && id.length > 0 ? { type: "workflow", id } : null;
    },
  },

  get_execution: {
    permission: "execution:read",
    resource: (args) => {
      const id = (args as { id?: unknown }).id;
      return typeof id === "string" && id.length > 0 ? { type: "execution", id } : null;
    },
  },
  list_all_skills: {
    permission: "skill:read",
  },
  list_skills: {
    permission: "skill:read",
  },
  get_skill: {
    permission: "skill:read",
    resource: (args) => {
      const id = (args as { id?: unknown }).id;
      return typeof id === "string" && id.length > 0 ? { type: "skill", id } : null;
    },
  },
  list_knowledge_sources: {
    permission: "knowledge:read",
  },
  get_knowledge_source: {
    permission: "knowledge:read",
    resource: (args) => {
      const id = (args as { id?: unknown }).id;
      return typeof id === "string" && id.length > 0 ? { type: "knowledge", id } : null;
    },
  },
  read_knowledge: {
    permission: "knowledge:read",
    resource: (args) => {
      const id = (args as { knowledge_source_id?: unknown }).knowledge_source_id;
      return typeof id === "string" && id.length > 0 ? { type: "knowledge", id } : null;
    },
  },
  list_users: {
    permission: "identity:read",
  },
  get_user: {
    permission: "identity:read",
    resource: (args) => {
      const id = (args as { id?: unknown }).id;
      return typeof id === "string" && id.length > 0 ? { type: "user", id } : null;
    },
  },
  list_system_accounts: {
    permission: "identity:read",
  },
  list_api_keys: {
    permission: "api_key:read",
  },
  get_api_key: {
    permission: "api_key:read",
    resource: (args) => {
      const id = (args as { id?: unknown }).id;
      return typeof id === "string" && id.length > 0 ? { type: "api_key", id } : null;
    },
  },
  list_portal_tokens: {
    permission: "portal_token:read",
  },
  list_capability_gaps: {
    permission: "discovery:read",
  },
  list_audit: {
    permission: "audit:read",
  },
  get_audit_entry: {
    permission: "audit:read",
  },
  list_connectors: {
    permission: "connector:read",
  },
  get_connector: {
    permission: "connector:read",
    resource: (args) => {
      const id = (args as { id?: unknown }).id;
      return typeof id === "string" && id.length > 0 ? { type: "connector", id } : null;
    },
  },
  find_connector: {
    permission: "connector:read",
    resource: (args) => {
      const id = (args as { id?: unknown }).id;
      return typeof id === "string" && id.length > 0 ? { type: "connector", id } : null;
    },
  },
  list_schedules: {
    permission: "schedule:read",
  },
  review_workflow_automation: { permission: "schedule:read" },
  diagnose_workflow: {
    permission: "workflow:read",
    resource: (args) => {
      const id = (args as { workflow_id?: unknown }).workflow_id;
      return typeof id === "string" && id.length > 0 ? { type: "workflow", id } : null;
    },
  },
  propose_workflow_repair: {
    permission: "workflow:write",
    resource: (args) => {
      const id = (args as { workflow_id?: unknown }).workflow_id;
      return typeof id === "string" && id.length > 0 ? { type: "workflow", id } : null;
    },
  },
};

function derivedRbac(t: ConversationTool): NonNullable<ToolDescriptor["rbac"]> | undefined {
  const p = t.permission;
  if (!p) return undefined;
  const idArg = p.resourceIdArg;
  if (idArg === undefined) return { permission: p.action };
  return {
    permission: p.action,
    resource: (args) => {
      const id = (args as Record<string, unknown>)[idArg];
      return typeof id === "string" && id.length > 0 ? { type: p.resourceType, id } : null;
    },
  };
}

function descriptorFor(t: ConversationTool, surface: ToolSurface): ToolDescriptor | null {
  const visibility = visibilityFor(t.category, surface);
  if (visibility === "hidden") return null;
  const disabled = visibility === "disabled" ? describeDisabled(t.category) : undefined;
  const rbac = RBAC_OVERRIDES[t.name] ?? derivedRbac(t);
  return {
    name: t.name,
    description: t.description,
    category: t.category,
    inputSchema: t.inputSchema,
    ...(disabled ? { disabled } : {}),
    ...(t.requires_skill ? { requires_skill: t.requires_skill } : {}),
    ...(t.requires_draft ? { requires_draft: true } : {}),
    ...(t.authoring_only ? { authoring_only: true } : {}),
    ...(rbac ? { rbac } : {}),
  };
}

function isVisibleForFilter(t: ConversationTool, filter: ToolListFilter): boolean {
  if (t.requires_skill && filter.loadedSkills) {
    if (!filter.loadedSkills.has(t.requires_skill)) return false;
  }
  if (filter.surface !== "mcp") return true;

  if (t.category !== "draft_write" && filter.mcpMode === "product") {
    if (t.authoring_only) return false;
    const readable = t.category === "tenant_read" || t.visible_when_readonly === true;
    if (!readable && !PRODUCT_MODE_ALLOW_LIST.has(t.name)) return false;
  }

  if (filter.readOnly && t.category === "tenant_write" && !t.visible_when_readonly) {
    return false;
  }

  return true;
}

export const conversationToolProvider: ToolProvider = {
  name: "ConversationToolProvider",
  list(filter: ToolListFilter): readonly ToolDescriptor[] {
    const out: ToolDescriptor[] = [];
    for (const t of listTools()) {
      if (!isVisibleForFilter(t, filter)) continue;
      if (filter.surface === "mcp" && t.category === "draft_write") continue;
      const d = descriptorFor(t, filter.surface);
      if (d) out.push(d);
    }
    return out;
  },
  resolve(name, filter) {
    const tool = listTools().find((t) => t.name === name);
    if (!tool) return undefined;
    if (!isVisibleForFilter(tool, filter)) return undefined;
    const descriptor = descriptorFor(tool, filter.surface);
    if (!descriptor) return undefined;
    const entry: ConversationProviderEntry = {
      kind: "conversation",
      tool,
      execute: (ctx, args) => tool.execute(ctx, args),
    };
    return { descriptor, executor: entry };
  },
};
