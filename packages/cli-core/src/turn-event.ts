// TurnEvent union + shared reducer. Used by `apps/sk` across its
// interactive and headless surfaces. Mirrors the engine's `TurnEvent` shape in
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

export type RenderableMessagePart =
  | { type: "text"; text: string }
  | { type: "code_block"; code: string; language?: string | undefined }
  | { type: "table"; headers: string[]; rows: string[][] };

export interface MessageState {
  role: "user" | "assistant" | "system" | "tool";
  content: string;
  /** Structured render model used by the richer Ink transcript surfaces. */
  parts?: RenderableMessagePart[];
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

export function parseRenderableMessageContent(content: unknown): {
  text: string;
  parts: RenderableMessagePart[];
} {
  const extracted = extractTextSegments(content);
  const text =
    extracted.length > 0
      ? extracted.join("\n\n")
      : content === null || content === undefined
        ? ""
        : safeStringify(content);
  if (text.length === 0) return { text, parts: [] };
  return { text, parts: splitRenderableParts(text) };
}

function safeStringify(value: unknown): string {
  try {
    return JSON.stringify(value);
  } catch {
    return String(value);
  }
}

function extractTextSegments(content: unknown): string[] {
  if (content === null || content === undefined) return [];
  if (typeof content === "string") return content.length > 0 ? [content] : [];
  if (Array.isArray(content)) {
    return content.flatMap((item) => extractTextSegments(item));
  }
  if (typeof content !== "object") return [String(content)];

  const rec = content as Record<string, unknown>;
  if (typeof rec.text === "string") {
    return rec.text.length > 0 ? [rec.text] : [];
  }
  if (Array.isArray(rec.parts)) {
    return rec.parts.flatMap((part) => extractTextSegments(part));
  }
  if (Array.isArray(rec.content)) {
    return rec.content.flatMap((part) => extractTextSegments(part));
  }
  if (typeof rec.content === "string") {
    return rec.content.length > 0 ? [rec.content] : [];
  }
  return [];
}

function splitRenderableParts(source: string): RenderableMessagePart[] {
  const lines = source.split("\n");
  const parts: RenderableMessagePart[] = [];
  let textBuffer: string[] = [];

  const flushText = (): void => {
    const text = textBuffer
      .join("\n")
      .replace(/\n{3,}/g, "\n\n")
      .trim();
    textBuffer = [];
    if (text.length > 0) parts.push({ type: "text", text });
  };

  for (let i = 0; i < lines.length; i++) {
    const line = lines[i] ?? "";
    const fence = line.match(/^```([\w.+-]+)?\s*$/);
    if (fence) {
      const end = findFenceEnd(lines, i + 1);
      if (end !== null) {
        flushText();
        const code = lines
          .slice(i + 1, end)
          .join("\n")
          .replace(/\n+$/, "");
        parts.push({
          type: "code_block",
          code,
          ...(fence[1] ? { language: fence[1] } : {}),
        });
        i = end;
        continue;
      }
    }

    if (isMarkdownTable(lines, i)) {
      flushText();
      const table = consumeMarkdownTable(lines, i);
      parts.push(table.part);
      i = table.lastIndex;
      continue;
    }

    textBuffer.push(line);
  }

  flushText();
  return parts.length > 0 ? parts : [{ type: "text", text: source }];
}

function findFenceEnd(lines: string[], start: number): number | null {
  for (let i = start; i < lines.length; i++) {
    if (/^```\s*$/.test(lines[i] ?? "")) return i;
  }
  return null;
}

function isMarkdownTable(lines: string[], index: number): boolean {
  const header = splitTableCells(lines[index] ?? "");
  const separator = splitTableCells(lines[index + 1] ?? "");
  return (
    header.length >= 2 &&
    separator.length === header.length &&
    separator.every((cell) => /^:?-{3,}:?$/.test(cell))
  );
}

function consumeMarkdownTable(
  lines: string[],
  start: number,
): { part: Extract<RenderableMessagePart, { type: "table" }>; lastIndex: number } {
  const headers = splitTableCells(lines[start] ?? "");
  const rows: string[][] = [];
  let cursor = start + 2;
  for (; cursor < lines.length; cursor++) {
    const line = lines[cursor] ?? "";
    if (!line.includes("|")) break;
    const cells = splitTableCells(line);
    if (cells.length === 0) break;
    rows.push(normalizeRowWidth(cells, headers.length));
  }
  return {
    part: { type: "table", headers, rows },
    lastIndex: cursor - 1,
  };
}

function splitTableCells(line: string): string[] {
  const trimmed = line.trim();
  if (!trimmed.includes("|")) return [];
  const withoutLeading = trimmed.startsWith("|") ? trimmed.slice(1) : trimmed;
  const withoutTrailing = withoutLeading.endsWith("|")
    ? withoutLeading.slice(0, -1)
    : withoutLeading;
  return withoutTrailing.split("|").map((cell) => cell.trim());
}

function normalizeRowWidth(cells: string[], width: number): string[] {
  if (cells.length === width) return cells;
  if (cells.length > width) return cells.slice(0, width);
  return [...cells, ...Array.from({ length: width - cells.length }, () => "")];
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
      const parsed = parseRenderableMessageContent(ev.content);
      const next: MessageState = {
        role: ev.role,
        content: parsed.text,
        ...(parsed.parts.length > 0 ? { parts: parsed.parts } : {}),
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
      return {
        ...state,
        toolCalls: calls,
        validationErrors: isFailure ? state.validationErrors : [],
      };
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
