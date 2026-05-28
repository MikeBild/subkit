// MCP-layer policy gate for direct `tenant.*` tool calls.
//
// `handleTenantTool` calls `tool.execute()` directly, bypassing the
// conversation loop's `sdk-wrap.ts` policy gate. Without a gate here,
// flipping writes on would expose destructive tools (delete_workflow,
// revoke_api_key, …) with no confirmation at all. This module mirrors
// the loop's semantics for the MCP surface: on the first call to a
// tool whose policy says `confirm_before_execution`, return a structured
// "pending" envelope; the client LLM relays it to the operator, obtains
// a human "yes", and re-issues the same call with `_meta.sk_confirm:
// true` (or `__policy_confirmed: true` inside the args, kept as an
// alias for symmetry with sdk-wrap).
//
// Policy resolution reuses `resolveToolMode` from
// `conversations/tool-policies.ts` so the catalog of confirm-gated tools
// is authoritative and computed hooks (dev vs. prod, HTTP verb, etc.)
// fire the same way they do inside a conversation.

import { auditAwait } from "../../audit/audit.ts";
import { AuditAction } from "../../audit/types.ts";
import type { ResolvedPrincipal } from "../../auth/types.ts";
import { resolveToolMode } from "../../conversations/tool-policies.ts";
import type { ToolCategory } from "../../conversations/tools/index.ts";
import type { Db } from "../../db/client.ts";

export interface ConfirmRequiredEnvelope {
  pending: true;
  confirm_required: true;
  policy_mode: "confirm_before_execution";
  reason: "destructive_action";
  target: { tool: string; args: Record<string, unknown> };
  resume: string;
  tool_call_id: string;
}

export type GateResult =
  | { kind: "proceed" }
  | { kind: "pending"; envelope: ConfirmRequiredEnvelope };

/**
 * Origin surface for the policy gate — stamped into audit metadata so
 * APPROVAL_REQUESTED / APPROVAL_APPROVED rows can be filtered by
 * surface. MCP defaults; chat callers (fast-path, synthetic palette)
 * pass `chat` or `fast_path` so the rows are not mis-attributed.
 */
export type PolicyGateVia = "mcp" | "chat" | "fast_path";

export interface GateTenantToolCallParams {
  /** Canonical tool name (no "tenant." prefix). */
  tool: string;
  /** Category from the conversation tool registry. */
  category: ToolCategory;
  /** Raw tool arguments as received over MCP. */
  args: Record<string, unknown>;
  /** Request `_meta` block — we look for `sk_confirm`. */
  meta: Record<string, unknown> | undefined;
  principal: ResolvedPrincipal;
  db: Db;
  /**
   * Origin surface for the call. Stamped into the audit metadata so
   * APPROVAL_REQUESTED / APPROVAL_APPROVED rows can be distinguished
   * per surface. Defaults to `"mcp"` for the original MCP callsite.
   */
  via?: PolicyGateVia;
}

const SK_CONFIRM_META_KEY = "sk_confirm";
const ARGS_CONFIRM_KEY = "__policy_confirmed";

function isConfirmed(
  args: Record<string, unknown>,
  meta: Record<string, unknown> | undefined,
): boolean {
  if (meta && meta[SK_CONFIRM_META_KEY] === true) return true;
  if (args[ARGS_CONFIRM_KEY] === true) return true;
  return false;
}

function buildTarget(
  tool: string,
  args: Record<string, unknown>,
): { tool: string; args: Record<string, unknown> } {
  // Strip the confirmation marker from the echoed target so the client
  // can re-submit the payload verbatim without double-flagging.
  const { [ARGS_CONFIRM_KEY]: _omit, ...rest } = args;
  return { tool: `tenant_${tool}`, args: rest };
}

/**
 * Gate a `tenant.*` call. Reads-only tools and any tool whose resolved
 * mode is not `confirm_before_execution` proceed immediately. Otherwise
 * the first call emits an APPROVAL_REQUESTED audit row and a
 * `pending/confirm_required` envelope; a subsequent call with
 * `_meta.sk_confirm: true` emits APPROVAL_APPROVED and proceeds.
 */
export async function gateTenantToolCall(p: GateTenantToolCallParams): Promise<GateResult> {
  // Reads never gate. tenant_write + draft_write follow the resolver.
  if (p.category === "tenant_read") return { kind: "proceed" };

  const resolvedMode = resolveToolMode({
    tool: p.tool,
    category: p.category,
    input: p.args,
    overrides: {},
  });

  if (resolvedMode !== "confirm_before_execution") return { kind: "proceed" };

  const confirmed = isConfirmed(p.args, p.meta);
  const tool_call_id = crypto.randomUUID();
  const via: PolicyGateVia = p.via ?? "mcp";

  if (confirmed) {
    await auditAwait(
      {
        tenant_id: p.principal.tenant_id,
        actor_type: p.principal.kind === "user" ? "user" : "system",
        actor_id: p.principal.id,
        action: AuditAction.APPROVAL_APPROVED,
        resource_type: "mcp_tool_call",
        resource_id: tool_call_id,
        result: "success",
        metadata: {
          // `tenant_` is an MCP-historical prefix kept for backward-compat
          // on the MCP surface only. Chat / fast_path callers persist the
          // bare tool name so audit aggregates by `metadata.tool` match
          // the conversation_tool_calls table.
          tool: via === "mcp" ? `tenant_${p.tool}` : p.tool,
          policy_mode: resolvedMode,
          via,
        },
      },
      p.db,
    );
    return { kind: "proceed" };
  }

  await auditAwait(
    {
      tenant_id: p.principal.tenant_id,
      actor_type: "system",
      actor_id: p.principal.id,
      action: AuditAction.APPROVAL_REQUESTED,
      resource_type: "mcp_tool_call",
      resource_id: tool_call_id,
      result: "success",
      metadata: {
        // `tenant_` is an MCP-historical prefix kept for backward-compat
        // on the MCP surface only. Chat / fast_path callers persist the
        // bare tool name so audit aggregates by `metadata.tool` match
        // the conversation_tool_calls table.
        tool: via === "mcp" ? `tenant_${p.tool}` : p.tool,
        // Stable column for cross-surface audit queries. `tool` forks
        // by surface (MCP keeps the legacy prefix); `canonical_tool`
        // is always the bare tool name so operators have one column
        // they can `GROUP BY` regardless of `via`.
        canonical_tool: p.tool,
        policy_mode: resolvedMode,
        via,
      },
    },
    p.db,
  );

  return {
    kind: "pending",
    envelope: {
      pending: true,
      confirm_required: true,
      policy_mode: "confirm_before_execution",
      reason: "destructive_action",
      target: buildTarget(p.tool, p.args),
      resume: "Re-issue the same call with _meta.sk_confirm=true after the operator approves.",
      tool_call_id,
    },
  };
}
