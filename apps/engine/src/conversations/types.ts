// Conversation types shared across the service, loop, tool palette,
// and HTTP / MCP layers.

import type { WorkflowDef } from "../workflows/types.ts";

export type ConversationStatus = "active" | "awaiting_input" | "committed" | "abandoned";

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

/**
 * One frame in the conversation event stream. Emitted by the service
 * loop and consumed by the SSE route and the MCP progress bridge.
 *
 * Mirrors Vercel AI SDK UI's wire model:
 *   - `tool_call_start / tool_call_delta / tool_call_end / tool_result`
 *     carry the `partial-call → call → result` lifecycle keyed by
 *     `call_id`.
 *   - `data_part` is the `data-*` generative-UI channel.
 *   - `elicit_request` represents an `askUser.*` pause; the client
 *     renders a component based on `tool_name` and posts the answer
 *     to `POST /v1/conversations/:id/elicitations/:eid/respond`.
 */
export type TurnEvent =
  | { type: "message"; role: ConversationRole; content: unknown }
  /**
   * Incremental assistant-text delta. Emitted as `streamText` produces
   * tokens. Clients (sk Ink, HTTP SSE, MCP) should concatenate `text`
   * for live rendering; the final `message` event carries the full
   * assistant turn text for persisted replay.
   */
  | { type: "text_delta"; text: string }
  /**
   * Per-tool progress log. Emitted during long-running tool execution
   * (run_workflow, dry_run_step, etc.) so the user sees incremental
   * state rather than waiting for the tool to finish silently.
   */
  | {
      type: "tool_log";
      call_id: string;
      tool: string;
      level: "debug" | "info" | "warn" | "error";
      message: string;
      ts: string;
    }
  | {
      type: "tool_call_start";
      call_id: string;
      tool: string;
      input_partial?: unknown;
    }
  | { type: "tool_call_delta"; call_id: string; input_patch: unknown }
  | { type: "tool_call_end"; call_id: string; input: unknown }
  | {
      type: "tool_result";
      call_id: string;
      tool: string;
      output: unknown;
    }
  | { type: "data_part"; data_type: string; payload: unknown }
  | { type: "validation_error"; errors: Array<{ path: string; message: string }> }
  | {
      type: "elicit_request";
      elicitation_id: string;
      /** Which `askUser.*` tool paused the loop. */
      tool_name: string;
      /** Short summary stored on the elicitation row (audit + list view). */
      summary: string;
      /**
       * Full tool input payload — options list, form fields, question
       * text, confirm diff/target, etc. Clients dispatch on
       * `tool_name` and read this record to render the right prompt.
       */
      input: unknown;
    }
  | { type: "committed"; workflow_id: string }
  | { type: "completed"; status: ConversationStatus; usage?: TurnUsage };

export interface ConversationDetail {
  conversation: ConversationRecord;
  messages: ConversationMessageRecord[];
  tool_calls: ConversationToolCallRecord[];
  draft: DraftDocument | null;
}

/**
 * Parts-based message shape, mirroring Vercel AI SDK UI's `UIMessage`.
 * The engine persists `ConversationMessageRecord.content` as JSONB;
 * the `toMessageParts` adapter in `parts.ts` reconstructs a
 * `UIMessage` for the detail endpoint. Tool calls, tool results,
 * reasoning blocks, and `data_part` payloads all render through
 * per-part components instead of a single opaque blob.
 */
export type ContentPart =
  | { type: "text"; text: string }
  | { type: "reasoning"; text: string }
  | {
      type: "tool_call";
      call_id: string;
      tool: string;
      input: unknown;
      phase: "partial" | "called" | "result";
    }
  | { type: "tool_result"; call_id: string; tool: string; output: unknown }
  | { type: "data"; data_type: string; payload: unknown };

export interface UIMessage {
  id: string;
  role: ConversationRole;
  parts: ContentPart[];
  created_at: string;
}

// Re-export for callers.
export type { WorkflowDef };
