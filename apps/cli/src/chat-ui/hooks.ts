// Small state containers used by the Ink chat surface. Deliberately
// plain objects — we keep the component tree shallow so ink-testing-
// library can drive key events without touching a React reducer.

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

export interface ChatState {
  messages: MessageState[];
  toolCalls: ToolCallState[];
  draft: unknown;
  pendingApproval: { id: string; title: string; diff: string } | null;
  context: {
    tenant: string | null;
    skills: string[];
    connector: string | null;
    token_budget: number;
  };
  conversationId: string | null;
  status: "running" | "awaiting_approval" | "completed" | "error";
  statusDetail: string | null;
  validationErrors: Array<{ path: string; message: string }>;
  committedWorkflowId: string | null;
}

export function initialState(conversationId: string | null, tenant: string | null): ChatState {
  return {
    messages: [],
    toolCalls: [],
    draft: null,
    pendingApproval: null,
    context: {
      tenant,
      skills: [],
      connector: null,
      token_budget: 0,
    },
    conversationId,
    status: "running",
    statusDetail: null,
    validationErrors: [],
    committedWorkflowId: null,
  };
}

// Wire-format frames produced by the engine SSE route. Mirrors the
// engine's `TurnEvent` union; the CLI keeps its own copy so the
// compiled binary doesn't drag the engine module graph.
export type TurnEvent =
  | { type: "message"; role: MessageState["role"]; content: unknown }
  | { type: "tool_call"; tool: string; input: unknown; id?: string }
  | { type: "tool_result"; tool: string; output: unknown; id?: string }
  | { type: "validation_error"; errors: Array<{ path: string; message: string }> }
  | { type: "approval_request"; approval_id: string; kind: string; summary: string }
  | { type: "committed"; workflow_id: string }
  | { type: "completed"; status: string };

/**
 * Pure reducer used by the Ink app to fold a TurnEvent into the
 * existing ChatState. Kept as a free function so tests can drive it
 * synchronously without touching React.
 */
export function applyTurnEvent(state: ChatState, ev: TurnEvent): ChatState {
  switch (ev.type) {
    case "message": {
      const role = ev.role === "tool" ? "system" : ev.role;
      return {
        ...state,
        messages: [...state.messages, { role, content: stringifyContent(ev.content) }],
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
      // Match by id if provided, otherwise update the most recent
      // running call with the same name.
      const idx = ev.id
        ? calls.findIndex((c) => c.id === ev.id)
        : findLastRunningIndex(calls, ev.tool);
      if (idx >= 0) {
        const existing = calls[idx];
        if (existing) {
          calls[idx] = { ...existing, status: "done", result: ev.output };
        }
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
      return {
        ...state,
        status: "error",
        validationErrors: ev.errors,
        statusDetail: `validation: ${ev.errors.length} error(s)`,
      };
    }
    case "approval_request": {
      return {
        ...state,
        status: "awaiting_approval",
        pendingApproval: {
          id: ev.approval_id,
          title: ev.kind,
          diff: ev.summary,
        },
      };
    }
    case "committed": {
      return {
        ...state,
        committedWorkflowId: ev.workflow_id,
      };
    }
    case "completed": {
      return {
        ...state,
        status: "completed",
        statusDetail: `conversation ${ev.status}`,
      };
    }
    default:
      return state;
  }
}

function findLastRunningIndex(calls: ToolCallState[], tool: string): number {
  for (let i = calls.length - 1; i >= 0; i--) {
    const call = calls[i];
    if (call && call.name === tool && call.status === "running") return i;
  }
  return -1;
}

function stringifyContent(content: unknown): string {
  if (typeof content === "string") return content;
  if (content === null || content === undefined) return "";
  try {
    return JSON.stringify(content);
  } catch {
    return String(content);
  }
}
