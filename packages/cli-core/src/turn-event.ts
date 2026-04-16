// TurnEvent union + shared reducer. Used by `apps/sk` (via
// @cli-core) and — for new code — also the REPL surfaces in
// `apps/cli`. Mirrors the engine's `TurnEvent` shape in
// `apps/engine/src/conversations/types.ts`, with the
// CLI-friendly richer `completed` frame that carries usage.

export interface TurnUsage {
  turn_tokens: number;
  remaining_monthly_budget_tokens: number | null;
}

export type TurnEvent =
  | {
      type: "message";
      role: "user" | "assistant" | "system" | "tool";
      content: unknown;
      id?: string;
    }
  | { type: "tool_call"; tool: string; input: unknown; id?: string }
  | { type: "tool_result"; tool: string; output: unknown; id?: string }
  | {
      type: "validation_error";
      errors: Array<{ path: string; message: string }>;
    }
  | {
      type: "approval_request";
      approval_id: string;
      kind: string;
      summary: string;
      /** Structured diff / payload surfaced by the engine's approval tools. */
      diff?: unknown;
      /** Free-form target descriptor ({url, method, …}) for external writes. */
      target?: unknown;
    }
  | { type: "committed"; workflow_id: string }
  | { type: "completed"; status: string; usage?: TurnUsage };

export type ToolStatus = "pending" | "running" | "done" | "failed";

export interface ToolCallState {
  id: string;
  name: string;
  args: unknown;
  status: ToolStatus;
  result?: unknown;
  error?: string;
}

export interface MessageState {
  role: "user" | "assistant" | "system" | "tool";
  content: string;
}

export interface PendingApproval {
  id: string;
  kind: string;
  summary: string;
  /** Structured diff payload (passthrough from the engine). */
  diff: unknown;
  /** Free-form target descriptor (url, workflow path, etc). */
  target: unknown;
}

export interface SkSessionState {
  messages: MessageState[];
  toolCalls: ToolCallState[];
  pendingApproval: PendingApproval | null;
  conversationId: string | null;
  status: "running" | "awaiting_approval" | "completed" | "error";
  committedWorkflowId: string | null;
  validationErrors: Array<{ path: string; message: string }>;
  usage: TurnUsage | null;
}

export function initialSessionState(conversationId: string | null): SkSessionState {
  return {
    messages: [],
    toolCalls: [],
    pendingApproval: null,
    conversationId,
    status: "running",
    committedWorkflowId: null,
    validationErrors: [],
    usage: null,
  };
}

function stringifyContent(content: unknown): string {
  if (typeof content === "string") return content;
  if (content === null || content === undefined) return "";
  if (typeof content === "object" && content !== null) {
    const c = content as { text?: unknown };
    if (typeof c.text === "string") return c.text;
  }
  try {
    return JSON.stringify(content);
  } catch {
    return String(content);
  }
}

function findLastRunningIndex(calls: ToolCallState[], tool: string): number {
  for (let i = calls.length - 1; i >= 0; i--) {
    const call = calls[i];
    if (call && call.name === tool && call.status === "running") return i;
  }
  return -1;
}

/**
 * Pure reducer that folds a TurnEvent into the existing SessionState.
 * Kept as a free function so tests can drive it synchronously.
 */
export function applyTurnEvent(state: SkSessionState, ev: TurnEvent): SkSessionState {
  switch (ev.type) {
    case "message": {
      return {
        ...state,
        messages: [...state.messages, { role: ev.role, content: stringifyContent(ev.content) }],
      };
    }
    case "tool_call": {
      const id = ev.id ?? `tool-${state.toolCalls.length + 1}`;
      return {
        ...state,
        toolCalls: [...state.toolCalls, { id, name: ev.tool, args: ev.input, status: "running" }],
      };
    }
    case "tool_result": {
      const calls = [...state.toolCalls];
      const idx = ev.id
        ? calls.findIndex((c) => c.id === ev.id)
        : findLastRunningIndex(calls, ev.tool);
      if (idx >= 0) {
        const existing = calls[idx];
        if (existing) calls[idx] = { ...existing, status: "done", result: ev.output };
      } else {
        calls.push({
          id: `tool-${calls.length + 1}`,
          name: ev.tool,
          args: undefined,
          status: "done",
          result: ev.output,
        });
      }
      return { ...state, toolCalls: calls };
    }
    case "validation_error": {
      return { ...state, status: "error", validationErrors: ev.errors };
    }
    case "approval_request": {
      return {
        ...state,
        status: "awaiting_approval",
        pendingApproval: {
          id: ev.approval_id,
          kind: ev.kind,
          summary: ev.summary,
          diff: ev.diff ?? null,
          target: ev.target ?? null,
        },
      };
    }
    case "committed": {
      return { ...state, committedWorkflowId: ev.workflow_id };
    }
    case "completed": {
      return {
        ...state,
        status: "completed",
        usage: ev.usage ?? state.usage,
      };
    }
    default:
      return state;
  }
}

/** Final assistant message text — used by `--output text` exit. */
export function lastAssistantText(state: SkSessionState): string {
  for (let i = state.messages.length - 1; i >= 0; i--) {
    const m = state.messages[i];
    if (m && m.role === "assistant") return m.content;
  }
  return "";
}
