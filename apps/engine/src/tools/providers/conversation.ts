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

/** Conversation tools that surface in PRODUCT mode. Anything not in this set
 *  is gated behind authoring/admin mode.
 *
 *  `find_workflow` + `run_workflow` are the search-first core: they let a
 *  product/strict client discover and execute the full workflow library on
 *  demand when the per-workflow `wf_` palette is trimmed to its Top-N for the
 *  catalog token budget. Without them, a trimmed palette would make the long
 *  tail unreachable. (`run_workflow` is `tenant_write` — see the readOnly
 *  exemption below; it is a workflow *run*, exactly like the `wf_` palette
 *  tools, which already surface in product mode regardless of `readOnly`.
 *  Authorization stays with `gateWorkflowRunRbac`, not this list.)
 *
 *  `get_execution` completes the run contract: a `wf_<slug>` / `run_workflow`
 *  call that outruns the MCP inline window hands back an `execution_id` polling
 *  handle (`mcp/capabilities/tools.ts`). Publishing the run tool while
 *  withholding the only tool that resolves its handle advertises a result the
 *  caller can never fetch. (`enduser`, the read-only chat/MCP role, holds
 *  `execution:read` — the dispatcher's RBAC entry gates it either way.)
 *
 *  Other `tenant_write` tools (e.g. `import_connector_from_spec`) stay out:
 *  exposing a config-mutating write to product callers is a category
 *  violation — those remain authoring+admin only.
 *
 *  Anything added here is automatically published in `authoring` too:
 *  `mcp/capabilities/catalog-budget.ts` unions this set into the authoring
 *  catalog so the mode hierarchy can never invert. */
const PRODUCT_MODE_ALLOW_LIST: ReadonlySet<string> = new Set([
  "match_connector_template_by_url",
  "test_connector",
  "inspect_recipe",
  // probe_connector_draft is reachable in product mode too — useful for
  // headless connector bootstrap.
  "probe_connector_draft",
  // search-first core (see comment above)
  "find_workflow",
  "run_workflow",
  // resolves the polling handle a long run hands back (see comment above)
  "get_execution",
]);

/** `tenant_write` tools exempt from the readOnly hide:
 *  - `run_workflow` is a workflow *run*, not a config mutation — consistent
 *    with the `wf_` palette, which surfaces in product mode regardless of
 *    `readOnly`. Mirrors the search-first floor in `mcp/mode-resolver.ts`
 *    (MCP_CORE_TOOL_NAMES).
 *  - `save_learning` creates an INERT `proposed` skill candidate behind the
 *    human approve gate; it is the coding-agent capture loop's explicit
 *    channel and must stay directly callable on MCP (authoring principals
 *    see no other tenant_write). RBAC (`skill:propose`) still gates it. */
const READONLY_EXEMPT_RUNS: ReadonlySet<string> = new Set(["run_workflow", "save_learning"]);

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
 *  Coverage rule: every `tenant_write` tool AND every `tenant_read`
 *  inventory/identity tool reachable from MCP needs a permission
 *  entry. Read tools are covered because the LLM-mediated chat path
 *  and the direct MCP path both dispatch through here, while the
 *  typed fast-path already gates the equivalent list intents on
 *  `*:read` (`fast-path.ts` `READ_PERMISSION_BY_LIST`); without an
 *  entry those two paths would leak the full inventory tenant-wide,
 *  asymmetric with the fast-path. The one deliberate carve-out is
 *  `whoami`, which returns the CALLER'S OWN identity and must stay
 *  ungated so a principal can discover its own rights before being
 *  denied (mirrors `rbac/self-introspection.ts`). Keep this table
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
  // create_knowledge_source: no resource — the tool creates a NEW
  // knowledge source (no pre-existing id to scope to). Tenant-scoped
  // permission check is the authorization boundary.
  create_knowledge_source: {
    permission: "knowledge:write",
  },
  // save_learning creates a NEW proposed skill candidate (no pre-existing
  // id to scope to). Deliberately `skill:propose`, NOT `skill:write` —
  // proposing must never imply the authority to approve.
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
  // create_skill: no resource — the tool creates a NEW skill (no
  // pre-existing id to scope to). Tenant-scoped permission check is the
  // authorization boundary.
  create_skill: {
    permission: "skill:write",
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
      const id = (args as { candidate_id?: unknown }).candidate_id;
      return typeof id === "string" && id.length > 0 ? { type: "skill_candidate", id } : null;
    },
  },

  // ── tenant_read inventory / identity ───────────────────────────────
  // These are enforced on the LLM-mediated chat path and the direct
  // MCP path, symmetric with the typed fast-path (`READ_PERMISSION_BY_LIST`).
  // `whoami` is intentionally absent (self-introspection carve-out).
  //
  // `get_engine_status` is intentionally NOT gated: the `enduser` role
  // (the read-only chat/MCP principal) deliberately lacks `stats:read`
  // (rbac/seed.ts), and get_engine_status is the DESIGNATED low-sensitivity
  // self-status surface — the sensitive operator health digest is a
  // separate, already `stats:read`-gated surface kept out of this tool
  // (conversations/tools/generated/status.ts). Gating it here would break
  // the core self-assistant use case (an enduser asking the engine to
  // describe its own status).
  get_execution: {
    // Symmetric with inspect_execution (execution:read). get_execution's
    // id arg is `id`, not `execution_id`.
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
  // Content reads that the enduser role does not hold (connector:read,
  // schedule:read) — gated to match the typed fast-path
  // (`READ_PERMISSION_BY_LIST`) so the LLM-mediated and direct-MCP paths
  // do not leak connectors/schedules the fast-path would deny.
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
    ...(t.requires_draft ? { requires_draft: true } : {}),
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

  // readOnly hides every tenant_write regardless of mode — except workflow
  // runs, which behave like the always-on wf_ palette (RBAC still gates them).
  if (filter.readOnly && t.category === "tenant_write" && !READONLY_EXEMPT_RUNS.has(t.name)) {
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
