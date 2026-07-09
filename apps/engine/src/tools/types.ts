// Unified tool palette — shared types for chat (Anthropic SDK) and MCP
// surfaces. The registry, dispatcher, providers, and per-surface
// adapters all speak these types. See docs/developers/tool-palette.md for
// the design rationale.

import type { ToolModeRule } from "../conversations/tool-policies.ts";
import type { ToolResultPause } from "../conversations/tools/index.ts";

/** Which surface invoked the tool. Drives visibility filtering and
 *  envelope rendering. */
export type ToolSurface = "chat" | "mcp";

/** Reused from the conversation registry. Tools self-declare category
 *  so the dispatcher can apply the right policy gate without per-tool
 *  branching. */
export type ToolCategory = "draft_write" | "tenant_read" | "tenant_write";

/** Catalog descriptor — the public shape a surface sees for a tool.
 *  No executor here; the registry resolves an executor on demand. */
export interface ToolDescriptor {
  readonly name: string;
  readonly description: string;
  readonly category: ToolCategory;
  /** Opaque to the dispatcher — Zod for conversation tools, JSON Schema
   *  for workflow-derived tools. The adapter converts to the surface's
   *  schema shape. */
  readonly inputSchema: unknown;
  /** When set, the tool surfaces in `tools/list` but `tools/call` is
   *  rejected with `status:"not_available_on_surface"`. Used to honestly
   *  report tools that exist on one surface but not another (e.g.
   *  `save_workflow_draft` on MCP). */
  readonly disabled?: { readonly reason: string };
  /** Slug of a skill that must be loaded before this tool is visible.
   *  Mirrors the conversation registry's `requires_skill`. */
  readonly requires_skill?: string;
  /** True when the tool depends on the conversation's working draft
   *  (`ctx.getDraft()`). The dispatcher rejects such a tool on the MCP
   *  stub-context path with `not_available_on_surface` rather than let it
   *  run against the empty stub draft. Mirrors
   *  `ConversationTool.requires_draft`. */
  readonly requires_draft?: boolean;
  /** Per-tool RBAC declaration. The dispatcher evaluates this via
   *  `can()` before invoking the executor and writes a POLICY_DENIED
   *  audit row on rejection. Used to keep RBAC out of individual tool
   *  bodies — the conversation tool stays pure, the dispatcher is the
   *  one place enforcing access. */
  readonly rbac?: {
    readonly permission: string;
    readonly resource?: (
      args: Record<string, unknown>,
    ) => { readonly type: string; readonly id: string } | null;
  };
}

/** WHY a call paused. Exactly one of two provenances, and the value names it:
 *
 *  - a `ToolModeRule` — the branch of `decideToolMode` that resolved this call
 *    to `confirm_before_execution`. `policyDecide` copies the rule it enforced;
 *    it never re-labels it. Today the enforcement table has one rule that can
 *    gate a destructive action by name (`tool_default`) and several that gate
 *    it by context (`computed_from_input`, `permission_mode`, …) — a future
 *    rule shows up here automatically instead of being mis-reported as an
 *    existing one.
 *  - `"held_writes"` — the run itself paused, not the policy table: a workflow
 *    executed with `hold_writes` and produced a preview whose write steps are
 *    waiting for an operator. No `decideToolMode` branch participates.
 *
 *  This is the value stamped on `approval.requested`'s `resolver_reason`, so
 *  the audit trail records the decision that was actually enforced. */
export type ConfirmReason = ToolModeRule | "held_writes";

/** Confirmation envelope returned by `policyDecide()` when a tool call
 *  needs human approval. Both surfaces render this into their native
 *  pause/elicit shape — chat injects `ask_user_confirm`, MCP returns
 *  `_meta.subkit.confirm` in the tools/call response. */
export interface ConfirmEnvelope {
  readonly tool: string;
  /** Structured "what will happen" preview — the fields the tool's own
   *  `buildPendingOutput` hook chose to surface. NEVER the full payload:
   *  the dispatcher persists the canonical args under `tool_call_id`, and
   *  the re-issue carries only that id, so echoing the payload would ship
   *  a 50KB body the caller can never re-transmit byte-exactly. `null`
   *  when the tool declares no preview hook. */
  readonly pending_output: Record<string, unknown> | null;
  readonly policy_mode: "confirm_before_execution";
  /** The enforced rule — see `ConfirmReason`. Never a fixed label: an envelope
   *  that always said "destructive_action" would describe a decision the gate
   *  did not make. */
  readonly reason: ConfirmReason;
  /** The approval's id, and the TRIGGER handle a later `confirm_tool_call` /
   *  `ask_user_confirm` carries back. Holding it approves nothing. */
  readonly tool_call_id: string;
  /** Where a HUMAN goes to grant or decline this call — the one channel that can
   *  make the handle claimable. Attached by the confirm gate once
   *  `requestApproval` has minted the link; `policyDecide` is pure and has no
   *  I/O, so the envelope it returns never carries one. `null` when the engine
   *  has no configured `server.public_base_url` and therefore no link to hand
   *  out — say so rather than invent a host nobody can open. */
  readonly approval_url?: string | null;
  /** Human-readable string telling the operator (or model) how to resume. */
  readonly resume: string;
}

/** Status-discriminated dispatcher envelope. Replaces the legacy
 *  `ok: true | false` discriminated union in `ConversationTool.ToolResult`.
 *  The chat adapter narrows `ok` from this; the MCP adapter narrows
 *  `isError` + content body. */
export type ToolEnvelope =
  | {
      readonly status: "ok";
      readonly data: unknown;
      readonly pause?: ToolResultPause;
      readonly committed_workflow_id?: string;
    }
  | {
      readonly status: "error";
      readonly error_code: string;
      readonly message: string;
      readonly details?: unknown;
      readonly next_best_actions?: readonly string[];
    }
  | {
      readonly status: "needs_confirm";
      readonly confirm: ConfirmEnvelope;
    }
  | {
      readonly status: "paused";
      readonly pause: ToolResultPause;
    }
  | {
      readonly status: "not_available_on_surface";
      readonly reason: string;
    };

/** What the dispatcher needs to do its job. The `ctx` is shaped to
 *  satisfy the conversation tools' `ToolContext`; MCP-only flows
 *  construct a stub context with just `db` + `tenant_id` + `principal`. */
export interface ToolInvocation {
  readonly surface: ToolSurface;
  readonly name: string;
  readonly args: Record<string, unknown>;
  /** Surface-specific metadata. For MCP this is `request.params._meta`;
   *  for chat it's empty by default. The `sk_confirm` flag for the
   *  confirmation gate lives here. */
  readonly meta?: Record<string, unknown>;
}
