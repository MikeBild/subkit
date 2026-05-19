// Unified tool palette — shared types for chat (Anthropic SDK) and MCP
// surfaces. The registry, dispatcher, providers, and per-surface
// adapters all speak these types. See docs/10-tool-palette.md for
// the design rationale.

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

/** Confirmation envelope returned by `policyDecide()` when a tool call
 *  needs human approval. Both surfaces render this into their native
 *  pause/elicit shape — chat injects `ask_user_confirm`, MCP returns
 *  `_meta.subkit.confirm` in the tools/call response. */
export interface ConfirmEnvelope {
  readonly tool: string;
  readonly args: Record<string, unknown>;
  readonly policy_mode: "confirm_before_execution";
  readonly reason: "destructive_action" | "external_call" | "sensitive_input" | "schema_change";
  readonly tool_call_id: string;
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
