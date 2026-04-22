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
      parent_message_id?: string;
    }
  | { type: "text_delta"; text: string }
  | {
      type: "tool_log";
      call_id: string;
      tool: string;
      level: "debug" | "info" | "warn" | "error";
      message: string;
      ts: string;
      parent_message_id?: string;
    }
  | {
      type: "tool_call_start";
      call_id: string;
      tool: string;
      input_partial?: unknown;
      parent_message_id?: string;
    }
  | {
      type: "tool_call_delta";
      call_id: string;
      input_patch: unknown;
      parent_message_id?: string;
    }
  | {
      type: "tool_call_end";
      call_id: string;
      input: unknown;
      parent_message_id?: string;
    }
  | {
      type: "tool_result";
      call_id: string;
      tool: string;
      output: unknown;
      parent_message_id?: string;
    }
  | { type: "data_part"; data_type: string; payload: unknown }
  | {
      type: "validation_error";
      errors: Array<{ path: string; message: string }>;
    }
  | {
      type: "elicit_request";
      elicitation_id: string;
      /** Which `ask_user_*` tool paused the loop. */
      tool_name: string;
      /** Short row-level summary (audit + list view). */
      summary: string;
      /** Full tool input payload (question, options, fields, diff, target, etc). */
      input: unknown;
      parent_message_id?: string;
    }
  | { type: "committed"; workflow_id: string }
  | { type: "completed"; status: string; usage?: TurnUsage };

/**
 * Pending user-input request — populated when the loop pauses on any
 * `askUser.*` tool. The client renders a component based on
 * `tool_name` and posts the answer to
 * `POST /v1/conversations/:id/elicitations/:eid/respond`.
 */
export interface PendingElicitation {
  id: string;
  tool_name: string;
  /** Question / summary shown above the prompt. */
  summary: string;
  /** Tool-specific input — options list, form fields, confirm diff, etc. */
  input: unknown;
  /**
   * Causal anchor — assistant message ID this elicitation belongs
   * under. When set, the renderer can place the prompt inline below
   * that message. When unset, falls back to the modal slot.
   */
  parent_message_id?: string | null;
}

/** Application-defined data part (AI SDK UI's `data-*` convention). */
export interface DataPartState {
  data_type: string;
  payload: unknown;
}

export type ToolStatus = "pending" | "running" | "done" | "failed";

export interface ToolCallState {
  id: string;
  name: string;
  args: unknown;
  status: ToolStatus;
  result?: unknown;
  error?: string;
  /**
   * Assistant message ID this tool call is a child of. Populated for
   * new conversations (engine migration 0032 onward). Renderer reads
   * this to interleave the call inline under the right message row.
   */
  parent_message_id?: string | null;
}

export interface MessageState {
  role: "user" | "assistant" | "system" | "tool";
  content: string;
  /** Persisted message ID — needed so child tool calls can match by parent_message_id. */
  id?: string;
}

export interface ToolLogEntry {
  call_id: string;
  tool: string;
  level: "debug" | "info" | "warn" | "error";
  message: string;
  ts: string;
}

export interface SkSessionState {
  messages: MessageState[];
  toolCalls: ToolCallState[];
  pendingElicitation: PendingElicitation | null;
  dataParts: DataPartState[];
  conversationId: string | null;
  status: "running" | "awaiting_input" | "completed" | "error";
  committedWorkflowId: string | null;
  validationErrors: Array<{ path: string; message: string }>;
  usage: TurnUsage | null;
  /** Live streaming buffer — assistant text being built token-by-token. */
  streamingAssistantText: string;
  /** Live per-tool-call log entries (cleared when the tool result arrives). */
  toolLogs: ToolLogEntry[];
}

export function initialSessionState(conversationId: string | null): SkSessionState {
  return {
    messages: [],
    toolCalls: [],
    pendingElicitation: null,
    dataParts: [],
    conversationId,
    status: "running",
    committedWorkflowId: null,
    validationErrors: [],
    usage: null,
    streamingAssistantText: "",
    toolLogs: [],
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

/**
 * Find the most recent assistant message ID — used as a fallback
 * causal anchor when a child event arrives without an explicit
 * `parent_message_id` (rare but possible in older replays).
 */
function lastAssistantMessageId(state: SkSessionState): string | undefined {
  for (let i = state.messages.length - 1; i >= 0; i--) {
    const m = state.messages[i];
    if (m && m.role === "assistant" && m.id) return m.id;
  }
  return undefined;
}

/**
 * Pure reducer that folds a TurnEvent into the existing SessionState.
 * Kept as a free function so tests can drive it synchronously.
 */
export function applyTurnEvent(state: SkSessionState, ev: TurnEvent): SkSessionState {
  switch (ev.type) {
    case "message": {
      // The persisted message text supersedes any partial streaming
      // buffer — clear it so Ink stops double-rendering.
      const next: MessageState = {
        role: ev.role,
        content: stringifyContent(ev.content),
        ...(ev.id ? { id: ev.id } : {}),
      };
      return {
        ...state,
        messages: [...state.messages, next],
        streamingAssistantText: ev.role === "assistant" ? "" : state.streamingAssistantText,
      };
    }
    case "text_delta": {
      return {
        ...state,
        streamingAssistantText: state.streamingAssistantText + ev.text,
      };
    }
    case "tool_log": {
      return {
        ...state,
        toolLogs: [
          ...state.toolLogs,
          {
            call_id: ev.call_id,
            tool: ev.tool,
            level: ev.level,
            message: ev.message,
            ts: ev.ts,
          },
        ],
      };
    }
    case "tool_result": {
      // The wrapper envelope for our in-repo tools is `{ok, data, ...}`.
      // Surface ok=false as `failed` so the UI can render the failure
      // body instead of a misleading green ✓.
      const isFailure =
        typeof ev.output === "object" &&
        ev.output !== null &&
        (ev.output as { ok?: unknown }).ok === false;
      const status: ToolStatus = isFailure ? "failed" : "done";
      const calls = [...state.toolCalls];
      const idx = calls.findIndex((c) => c.id === ev.call_id);
      const anchor = ev.parent_message_id ?? lastAssistantMessageId(state);
      if (idx >= 0) {
        const existing = calls[idx];
        if (existing)
          calls[idx] = {
            ...existing,
            status,
            result: ev.output,
            ...(existing.parent_message_id ? {} : anchor ? { parent_message_id: anchor } : {}),
          };
      } else {
        calls.push({
          id: ev.call_id,
          name: ev.tool,
          args: undefined,
          status,
          result: ev.output,
          ...(anchor ? { parent_message_id: anchor } : {}),
        });
      }
      return { ...state, toolCalls: calls };
    }
    case "validation_error": {
      return { ...state, status: "error", validationErrors: ev.errors };
    }
    case "elicit_request": {
      const anchor = ev.parent_message_id ?? lastAssistantMessageId(state);
      return {
        ...state,
        status: "awaiting_input",
        pendingElicitation: {
          id: ev.elicitation_id,
          tool_name: ev.tool_name,
          summary: ev.summary,
          input: ev.input,
          ...(anchor ? { parent_message_id: anchor } : {}),
        },
      };
    }
    case "tool_call_start": {
      const input = ev.input_partial === undefined ? undefined : ev.input_partial;
      const anchor = ev.parent_message_id ?? lastAssistantMessageId(state);
      return {
        ...state,
        toolCalls: [
          ...state.toolCalls,
          {
            id: ev.call_id,
            name: ev.tool,
            args: input,
            status: "running",
            ...(anchor ? { parent_message_id: anchor } : {}),
          },
        ],
      };
    }
    case "tool_call_delta": {
      const calls = [...state.toolCalls];
      const idx = calls.findIndex((c) => c.id === ev.call_id);
      if (idx >= 0) {
        const existing = calls[idx];
        if (existing) {
          const merged =
            typeof existing.args === "object" && existing.args !== null
              ? {
                  ...(existing.args as Record<string, unknown>),
                  ...(ev.input_patch as Record<string, unknown>),
                }
              : ev.input_patch;
          calls[idx] = { ...existing, args: merged };
        }
      }
      return { ...state, toolCalls: calls };
    }
    case "tool_call_end": {
      const calls = [...state.toolCalls];
      const idx = calls.findIndex((c) => c.id === ev.call_id);
      if (idx >= 0) {
        const existing = calls[idx];
        if (existing) calls[idx] = { ...existing, args: ev.input };
      }
      return { ...state, toolCalls: calls };
    }
    case "data_part": {
      return {
        ...state,
        dataParts: [...state.dataParts, { data_type: ev.data_type, payload: ev.payload }],
      };
    }
    case "committed": {
      return { ...state, committedWorkflowId: ev.workflow_id, pendingElicitation: null };
    }
    case "completed": {
      const nextStatus: SkSessionState["status"] =
        ev.status === "awaiting_input" ? "awaiting_input" : "completed";
      return {
        ...state,
        status: nextStatus,
        usage: ev.usage ?? state.usage,
        pendingElicitation: ev.status === "awaiting_input" ? state.pendingElicitation : null,
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
