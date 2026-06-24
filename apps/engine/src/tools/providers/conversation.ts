// ConversationToolProvider — wraps the existing
// `apps/engine/src/conversations/tools/index.ts` registry and exposes
// every tool to both surfaces, with category-based + mode-based
// visibility filtering.
//
// MCP-mode visibility (matches legacy capabilities/tools.ts behavior):
//   product   — only tools in PRODUCT_MODE_ALLOW_LIST surface (matches
//               the hand-picked set the legacy push exposed in product
//               mode). All other conversation tools hidden.
//   authoring — adds every other tenant_read / tenant_write tool, plus
//               draft_write tools marked `disabled`.
//   admin     — same as authoring; the per-tool RBAC and the
//               read-only flag continue to gate writes.
//
// readOnly hides every tenant_write tool regardless of mode.
//
// The chat surface ignores mcpMode entirely (it has its own
// authoring-palette + skill-gate filters in sdk-wrap).

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

/** Conversation tools that the legacy MCP `tools/list` exposed in
 *  PRODUCT mode (via the manual `tools.push(matchConnectorTemplateByUrlMcpTool)`
 *  etc.). Anything not in this set is gated behind authoring/admin
 *  mode. Matches the pre-cutover catalog exactly.
 *
 *  Note: this allow-list intentionally excludes `tenant_write` tools.
 *  Even if a tool was historically pushed into product mode by the
 *  legacy code, exposing a write to product callers is a category
 *  violation — write gating now applies uniformly to the bare names
 *  and the `tenant.*` aliases, hidden under `readOnly: true` and
 *  hidden from product mode regardless of `readOnly`.
 *  `import_connector_from_spec` is `tenant_write`; it is reachable on
 *  MCP authoring+admin modes only. */
const PRODUCT_MODE_ALLOW_LIST: ReadonlySet<string> = new Set([
  "match_connector_template_by_url",
  "test_connector",
  "inspect_recipe",
  // probe_connector_draft is reachable in product mode too — useful for
  // headless connector bootstrap.
  "probe_connector_draft",
]);

function visibilityFor(
  category: ToolCategory,
  surface: ToolSurface,
): "visible" | "disabled" | "hidden" {
  if (surface === "chat") return "visible";
  // MCP: draft_write tools are conversation-scoped — only the engine's
  // internal authoring loop (started via `conversation_start`) may call
  // them. We keep the descriptor marked `disabled` so `resolve()` still
  // returns it and a stateless `tools/call` short-circuits to
  // `not_available_on_surface` (with the actionable "use conversation_start"
  // reason) BEFORE any audit/elicitation. The catalog itself omits these
  // tools — see `list()` below — because external clients (e.g. claude.ai)
  // ignore the `_meta.subkit.disabled` badge, call the tool anyway, and
  // churn on rejection instead of authoring. Hidden-from-list +
  // rejected-on-call is the honest, non-trapping surface.
  if (category === "draft_write") return "disabled";
  return "visible";
}

function describeDisabled(category: ToolCategory): { reason: string } | undefined {
  if (category === "draft_write") {
    // Same actionable message `policyDecide` emits when a draft_write
    // tool is actually called on MCP — sourced from `policy.ts` so the
    // `tools/list` badge and the call-time rejection never drift.
    return { reason: DRAFT_WRITE_MCP_UNAVAILABLE_REASON };
  }
  return undefined;
}

/** Per-tool RBAC overrides. Conversation tools are pure (no inline
 *  `can()` calls); the dispatcher enforces RBAC declared here.
 *
 *  Coverage rule: every `tenant_write` tool reachable from MCP needs
 *  a permission entry. Tools reachable only from chat can defer to
 *  the conversation harness's session-scoped authorization (the chat
 *  surface gates at the loop layer, not per-tool). Keep this table
 *  in sync with `rbac/permissions.json`. */
const RBAC_OVERRIDES: Readonly<Record<string, NonNullable<ToolDescriptor["rbac"]>>> = {
  // inspect_execution is a tenant_read reachable on MCP; the dispatcher
  // enforces execution:read centrally. The resource is scoped to the
  // execution when an explicit id is supplied; when omitted (latest),
  // the tenant-scoped permission check is the gate.
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
  // import_connector_from_spec: no resource — the tool creates a NEW
  // connector (no pre-existing id to scope to). Tenant-scoped
  // permission check is the authorization boundary.
  import_connector_from_spec: {
    permission: "connector:write",
  },
  // save_connector_draft: no resource — the tool operates on the
  // conversation's draft via `ctx.connector_id`, which the dispatcher
  // doesn't see (it lives in ToolContext, not args). The conversation
  // tool's own execute() enforces tenant isolation via `ctx.tenant_id`;
  // declaring a resource extractor that always returns `null` would
  // be misleading. Tenant-scoped permission check is the gate.
  save_connector_draft: {
    permission: "connector:write",
  },
  // authenticate_oauth: connector_id is OPTIONAL — when absent, the
  // tool falls back to `ctx.connector_id`. We declare no resource
  // here because the dispatcher cannot inspect ctx; a resource-scoped
  // grant for connector X would NOT match when the args use the ctx
  // fallback, leading to silently inconsistent authorization
  // (resource-scoped grants work for explicit `connector_id` args
  // but not for the ctx-fallback path). Tenant-scoped permission
  // check applies uniformly.
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
};

function descriptorFor(t: ConversationTool, surface: ToolSurface): ToolDescriptor | null {
  const visibility = visibilityFor(t.category, surface);
  if (visibility === "hidden") return null;
  const disabled = visibility === "disabled" ? describeDisabled(t.category) : undefined;
  const rbac = RBAC_OVERRIDES[t.name];
  return {
    name: t.name,
    description: t.description,
    category: t.category,
    inputSchema: t.inputSchema,
    ...(disabled ? { disabled } : {}),
    ...(t.requires_skill ? { requires_skill: t.requires_skill } : {}),
    ...(rbac ? { rbac } : {}),
  };
}

/** Single chokepoint for "should this tool surface for this filter?".
 *  Used by both `list()` (catalog) and `resolve()` (dispatch). They must
 *  agree for executable tools — otherwise a write tool hidden from the
 *  catalog could still be dispatched by a confirmed re-issue (audit-review
 *  caught this gap). The one deliberate exception is draft_write on MCP:
 *  `list()` drops it from the catalog while `resolve()` keeps returning
 *  its disabled descriptor, which is safe because such a call can never
 *  execute — it always short-circuits to `not_available_on_surface`. */
function isVisibleForFilter(t: ConversationTool, filter: ToolListFilter): boolean {
  // Skill gate.
  if (t.requires_skill && filter.loadedSkills) {
    if (!filter.loadedSkills.has(t.requires_skill)) return false;
  }
  if (filter.surface !== "mcp") return true;

  // MCP-mode gating. draft_write stays "visible" to this predicate so
  // `resolve()` keeps returning its disabled descriptor (the call-time
  // not_available_on_surface backstop); the catalog drop happens in
  // `list()` above, not here.
  // Apply mode visibility for non-draft_write tools.
  if (t.category !== "draft_write") {
    if (filter.mcpMode === "product" && !PRODUCT_MODE_ALLOW_LIST.has(t.name)) {
      return false;
    }
  }

  // readOnly hides every tenant_write regardless of mode.
  if (filter.readOnly && t.category === "tenant_write") return false;

  return true;
}

export const conversationToolProvider: ToolProvider = {
  name: "ConversationToolProvider",
  list(filter: ToolListFilter): readonly ToolDescriptor[] {
    const out: ToolDescriptor[] = [];
    for (const t of listTools()) {
      if (!isVisibleForFilter(t, filter)) continue;
      // Catalog omits draft_write on MCP: they are conversation-scoped and
      // always rejected on a stateless `tools/call`. Listing them (even as
      // disabled) traps clients that ignore the badge into calling and
      // churning. `resolve()` deliberately still returns the disabled
      // descriptor so a guessed/forced call short-circuits to
      // `not_available_on_surface` with the actionable reason — list and
      // resolve intentionally disagree here, which is safe because the
      // tool can never actually execute on this surface.
      if (filter.surface === "mcp" && t.category === "draft_write") continue;
      const d = descriptorFor(t, filter.surface);
      if (d) out.push(d);
    }
    return out;
  },
  resolve(name, filter) {
    const tool = listTools().find((t) => t.name === name);
    if (!tool) return undefined;
    // Apply the same visibility filter the catalog uses, so a write
    // tool that doesn't appear in tools/list also can't be dispatched
    // via a guessed call + sk_confirm round-trip.
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
