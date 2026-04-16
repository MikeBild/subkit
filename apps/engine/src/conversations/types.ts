// Conversation types shared across the service, loop, tool palette,
// and HTTP / MCP layers.

import type { WorkflowDef } from "../workflows/types.ts";

export type ConversationStatus = "active" | "awaiting_approval" | "committed" | "abandoned";

export type ConversationRole = "user" | "assistant" | "tool" | "system";

export interface ConversationRecord {
  id: string;
  tenant_id: string;
  target_workflow_id: string | null;
  target_connector_id: string | null;
  status: ConversationStatus;
  owner_id: string | null;
  model: string | null;
  title: string | null;
  created_at: string;
  updated_at: string;
}

export interface TurnUsage {
  /** Tokens consumed by this turn (delta on the llm_usage ledger). */
  turn_tokens: number;
  /**
   * Remaining token budget for the tenant's current month, or null
   * when the tenant is unlimited.
   */
  remaining_monthly_budget_tokens: number | null;
}

export interface ConversationMessageRecord {
  id: string;
  conversation_id: string;
  role: ConversationRole;
  content: unknown;
  created_at: string;
}

export interface ConversationToolCallRecord {
  id: string;
  conversation_id: string;
  tool: string;
  input: unknown;
  output: unknown;
  approval_required: boolean;
  created_at: string;
}

/**
 * The working workflow draft — kept as a plain object so we can evolve
 * the shape freely during a conversation before running the full
 * WorkflowDef validator at commit time.
 */
export interface DraftDocument {
  name: string;
  slug?: string;
  description?: string;
  steps: Array<Record<string, unknown>>;
  input_schema?: Record<string, unknown>;
  output_schema?: Record<string, unknown>;
}

export type ApprovalKind = "commit_draft" | "external_write" | "other";
export type ApprovalStatus = "pending" | "approved" | "rejected" | "timeout";

export interface ApprovalRequestRecord {
  id: string;
  conversation_id: string;
  tool_call_id: string | null;
  kind: ApprovalKind;
  summary: string;
  diff: unknown;
  status: ApprovalStatus;
  decision_reason: string | null;
  created_at: string;
}

/**
 * One frame in the conversation event stream. Emitted by the service
 * loop and consumed by the SSE route and the MCP progress bridge.
 */
export type TurnEvent =
  | { type: "message"; role: ConversationRole; content: unknown }
  | { type: "tool_call"; tool: string; input: unknown }
  | { type: "tool_result"; tool: string; output: unknown }
  | { type: "validation_error"; errors: Array<{ path: string; message: string }> }
  | {
      type: "approval_request";
      approval_id: string;
      kind: ApprovalKind;
      summary: string;
      /**
       * Structured diff for commit_draft kinds (before/after JSON).
       * Arbitrary opaque payload for other kinds — client-side
       * approval router decides how to render.
       */
      diff?: unknown;
      /**
       * Free-form target descriptor for external_write kinds
       * (`{url, method}` or `{workflow_id, path}` etc). Surfaced in
       * the UI as a `Target: <...>` line above the diff.
       */
      target?: unknown;
    }
  | { type: "committed"; workflow_id: string }
  | { type: "completed"; status: ConversationStatus; usage?: TurnUsage };

export interface ConversationDetail {
  conversation: ConversationRecord;
  messages: ConversationMessageRecord[];
  tool_calls: ConversationToolCallRecord[];
  draft: DraftDocument | null;
  approvals: ApprovalRequestRecord[];
}

// Re-export for callers.
export type { WorkflowDef };
