import type { SuggestNextKind, SuggestNextReason } from "@shared/suggest-next-reasons.ts";
import { parseRenderableMessageContent, type RenderableMessagePart } from "./message-parts.ts";

export { parseRenderableMessageContent, type RenderableMessagePart } from "./message-parts.ts";

export interface TurnUsage {
  turn_tokens: number;
  context_cap_tokens?: number;
  cache_read_tokens?: number;
  cache_read_pct?: number;
  breakdown?: {
    system: number;
    skills: number;
    knowledge: number;
    docs: number;
    failures: number;
    messages: number;
    total: number;
  };
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
      tool_call_id?: string;
      tool_name: string;
      summary: string;
      input: unknown;
      pending_output?: Record<string, unknown> | null;
      parent_message_id?: string;
    }
  | { type: "committed"; workflow_id: string }
  | { type: "completed"; status: string; usage?: TurnUsage }
  | {
      type: "activity";
      phase: "tool" | "composing" | "idle";
      label: string;
      tool_name?: string;
      call_id?: string;
      last_completed?: {
        tool_name: string;
        ok: boolean;
        duration_ms: number;
      };
    }
  | {
      type: "diff";
      title: string;
      language: "json" | "yaml" | "text";
      hunks: Array<{ kind: "+" | "-" | " "; text: string }>;
      parent_message_id?: string;
    }
  | {
      type: "next_suggestion";
      suggestion: string | null;
      reason: SuggestNextReason;
      kind: SuggestNextKind | null;
    }
  | {
      type: "citations";
      citations: Citation[];
      parent_message_id?: string;
    };

export interface Citation {
  source_type: "knowledge_chunk" | "connector_doc" | "product_doc";
  id: string;
  source_name?: string;
  excerpt?: string;
}

export interface PendingElicitation {
  id: string;
  tool_name: string;
  tool_call_id?: string | null;
  summary: string;
  input: unknown;
  parent_message_id?: string | null;
}

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
  parent_message_id?: string | null;
}

export interface MessageState {
  role: "user" | "assistant" | "system" | "tool";
  content: string;
  parts?: RenderableMessagePart[];
  id?: string;
  citations?: Citation[];
}

export interface ToolLogEntry {
  call_id: string;
  tool: string;
  level: "debug" | "info" | "warn" | "error";
  message: string;
  ts: string;
}

export interface ActivityState {
  phase: "tool" | "composing" | "idle";
  label: string;
  tool_name?: string;
  call_id?: string;
  last_completed?: { tool_name: string; ok: boolean; duration_ms: number };
  updated_at: number;
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
  streamingAssistantText: string;
  expectedStreamTail: string;
  toolLogs: ToolLogEntry[];
  activity: ActivityState | null;
  sessionTotalTokens: number;
  diffs: Array<{
    id: string;
    title: string;
    language: "json" | "yaml" | "text";
    hunks: Array<{ kind: "+" | "-" | " "; text: string }>;
    parentMessageId?: string;
  }>;
  nextSuggestion: {
    suggestion: string;
    kind: SuggestNextKind;
  } | null;
  nextSuggestionReason: SuggestNextReason | null;
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
    expectedStreamTail: "",
    toolLogs: [],
    activity: null,
    sessionTotalTokens: 0,
    diffs: [],
    nextSuggestion: null,
    nextSuggestionReason: null,
  };
}

function lastAssistantMessageId(state: SkSessionState): string | undefined {
  for (let i = state.messages.length - 1; i >= 0; i--) {
    const m = state.messages[i];
    if (m && m.role === "assistant" && m.id) return m.id;
  }
  return undefined;
}

function applyAssistantMessage(
  state: SkSessionState,
  next: MessageState,
  text: string,
): SkSessionState {
  const buffer = state.streamingAssistantText;
  let accountedPrefix: string | null = text.startsWith(buffer) ? buffer : null;

  let messages = state.messages;
  const sameIdIdx = next.id
    ? messages.findIndex((m) => m.role === "assistant" && m.id === next.id)
    : -1;
  if (sameIdIdx >= 0) {
    const existing = messages[sameIdIdx];
    if (existing) accountedPrefix = text.startsWith(existing.content) ? existing.content : null;
    if (existing && existing.content.length <= text.length) {
      messages = [...messages];
      messages[sameIdIdx] = next;
    }
  } else {
    const prior = messages[messages.length - 1];
    const priorText = prior?.role === "assistant" ? prior.content.trim() : "";
    const newText = text.trim();
    const duplicatesPrior = priorText.length > 0 && newText.startsWith(priorText);
    if (duplicatesPrior && prior) {
      accountedPrefix = text.startsWith(prior.content) ? prior.content : null;
    }
    messages = duplicatesPrior ? [...messages.slice(0, -1), next] : [...messages, next];
  }
  const expectedStreamTail =
    accountedPrefix !== null ? state.expectedStreamTail + text.slice(accountedPrefix.length) : "";
  return { ...state, messages, streamingAssistantText: "", expectedStreamTail };
}

export function applyTurnEvent(state: SkSessionState, ev: TurnEvent, now: number): SkSessionState {
  switch (ev.type) {
    case "message": {
      const parsed = parseRenderableMessageContent(ev.content);
      const next: MessageState = {
        role: ev.role,
        content: parsed.text,
        ...(parsed.parts.length > 0 ? { parts: parsed.parts } : {}),
        ...(ev.id ? { id: ev.id } : {}),
      };
      if (ev.role === "assistant") {
        return applyAssistantMessage(state, next, parsed.text);
      }
      let messages = state.messages;
      const prior = messages[messages.length - 1];
      const isUserEcho = ev.role === "user" && prior?.role === "user";
      const priorIsLocalEcho = isUserEcho && prior?.id === undefined;
      const priorIsDifferentEnginePersist =
        isUserEcho &&
        prior?.id !== undefined &&
        prior.id !== ev.id &&
        prior.content.trim() === parsed.text.trim();
      if (priorIsLocalEcho || priorIsDifferentEnginePersist) {
        messages = [...messages.slice(0, -1), next];
      } else {
        messages = [...messages, next];
      }
      return {
        ...state,
        messages,
        ...(ev.role === "user" ? { expectedStreamTail: "" } : {}),
      };
    }
    case "text_delta": {
      const tail = state.expectedStreamTail;
      if (tail.length > 0) {
        if (tail.startsWith(ev.text)) {
          return { ...state, expectedStreamTail: tail.slice(ev.text.length) };
        }
        if (ev.text.startsWith(tail)) {
          return {
            ...state,
            expectedStreamTail: "",
            streamingAssistantText: state.streamingAssistantText + ev.text.slice(tail.length),
          };
        }
        return {
          ...state,
          expectedStreamTail: "",
          streamingAssistantText: state.streamingAssistantText + ev.text,
        };
      }
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
      const isFailure =
        typeof ev.output === "object" &&
        ev.output !== null &&
        (ev.output as { ok?: unknown }).ok === false;
      const status: ToolStatus = isFailure ? "failed" : "done";
      const calls = [...state.toolCalls];
      const idx = calls.findIndex((c) => c.id === ev.call_id);
      if (idx >= 0) {
        const existing = calls[idx];
        if (existing)
          calls[idx] = {
            ...existing,
            status,
            result: ev.output,
          };
      } else {
        calls.push({
          id: ev.call_id,
          name: ev.tool,
          args: undefined,
          status,
          result: ev.output,
          ...(ev.parent_message_id ? { parent_message_id: ev.parent_message_id } : {}),
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
      return {
        ...state,
        status: "awaiting_input",
        pendingElicitation: {
          id: ev.elicitation_id,
          tool_name: ev.tool_name,
          ...(ev.tool_call_id ? { tool_call_id: ev.tool_call_id } : {}),
          summary: ev.summary,
          input: ev.input,
          ...(ev.parent_message_id ? { parent_message_id: ev.parent_message_id } : {}),
        },
      };
    }
    case "tool_call_start": {
      const input = ev.input_partial;
      return {
        ...state,
        toolCalls: [
          ...state.toolCalls,
          {
            id: ev.call_id,
            name: ev.tool,
            args: input,
            status: "running",
            ...(ev.parent_message_id ? { parent_message_id: ev.parent_message_id } : {}),
          },
        ],
        validationErrors: [],
        status: state.status === "error" ? "running" : state.status,
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
      const turnTokens = ev.usage?.turn_tokens ?? 0;
      return {
        ...state,
        status: nextStatus,
        usage: ev.usage ?? state.usage,
        pendingElicitation: ev.status === "awaiting_input" ? state.pendingElicitation : null,
        activity: null,
        expectedStreamTail: "",
        sessionTotalTokens: state.sessionTotalTokens + turnTokens,
      };
    }
    case "activity": {
      const next: ActivityState = {
        phase: ev.phase,
        label: ev.label,
        ...(ev.tool_name !== undefined ? { tool_name: ev.tool_name } : {}),
        ...(ev.call_id !== undefined ? { call_id: ev.call_id } : {}),
        ...(ev.last_completed !== undefined ? { last_completed: ev.last_completed } : {}),
        updated_at: now,
      };
      return { ...state, activity: next };
    }
    case "diff": {
      const parent = lastAssistantMessageId(state);
      return {
        ...state,
        diffs: [
          ...state.diffs,
          {
            id: `diff-${state.diffs.length}-${now}`,
            title: ev.title,
            language: ev.language,
            hunks: ev.hunks,
            ...(parent ? { parentMessageId: parent } : {}),
          },
        ],
      };
    }
    case "next_suggestion": {
      return {
        ...state,
        nextSuggestion:
          ev.suggestion && ev.kind ? { suggestion: ev.suggestion, kind: ev.kind } : null,
        nextSuggestionReason: ev.reason,
      };
    }
    case "citations": {
      if (ev.citations.length === 0) return state;
      let idx = -1;
      for (let i = state.messages.length - 1; i >= 0; i--) {
        const m = state.messages[i];
        if (m?.role !== "assistant") continue;
        if (ev.parent_message_id ? m.id === ev.parent_message_id : true) {
          idx = i;
          break;
        }
      }
      if (idx === -1) return state;
      const messages = state.messages.slice();
      messages[idx] = { ...messages[idx]!, citations: ev.citations };
      return { ...state, messages };
    }
    default:
      return state;
  }
}

export function lastAssistantText(state: SkSessionState): string {
  for (let i = state.messages.length - 1; i >= 0; i--) {
    const m = state.messages[i];
    if (m && m.role === "assistant") return m.content;
  }
  return "";
}

const EXECUTION_TOOL_NAMES = new Set([
  "run_workflow",
  "dry_run_workflow",
  "call_connector",
  "tenant_call_connector",
]);

function isExecutionTool(name: string): boolean {
  return EXECUTION_TOOL_NAMES.has(name) || name.startsWith("wf_");
}

export interface ExecutionResultRender {
  tool: string;
  output: unknown;
}

export function lastExecutionResult(state: SkSessionState): ExecutionResultRender | null {
  for (let i = state.toolCalls.length - 1; i >= 0; i--) {
    const c = state.toolCalls[i];
    if (c?.status !== "done" || !isExecutionTool(c.name)) continue;
    const envelope = c.result;
    if (envelope === undefined || envelope === null) continue;
    if (typeof envelope === "object") {
      const env = envelope as { ok?: unknown; data?: unknown };
      if (env.ok === false) continue;
      const output = "data" in env ? env.data : envelope;
      if (output === undefined || output === null) continue;
      return { tool: c.name, output };
    }
    return { tool: c.name, output: envelope };
  }
  return null;
}

function sampleForRender(value: unknown, maxItems: number): unknown {
  if (Array.isArray(value)) {
    const items = value.slice(0, maxItems).map((v) => sampleForRender(v, maxItems));
    if (value.length > maxItems) {
      items.push(`… sampled ${maxItems} of ${value.length} items`);
    }
    return items;
  }
  if (value && typeof value === "object") {
    const out: Record<string, unknown> = {};
    for (const [k, v] of Object.entries(value as Record<string, unknown>)) {
      out[k] = sampleForRender(v, maxItems);
    }
    return out;
  }
  return value;
}

export function renderExecutionOutput(
  r: ExecutionResultRender,
  opts?: { maxArrayItems?: number; maxChars?: number },
): string {
  const maxItems = opts?.maxArrayItems ?? 20;
  const maxChars = opts?.maxChars ?? 20000;
  let body: string;
  if (typeof r.output === "string") {
    body = r.output;
  } else {
    try {
      body = JSON.stringify(sampleForRender(r.output, maxItems), null, 2) ?? String(r.output);
    } catch {
      body = String(r.output);
    }
  }
  if (body.length > maxChars) {
    body = `${body.slice(0, maxChars)}\n… [truncated ${body.length - maxChars} chars]`;
  }
  return `[${r.tool}] result:\n${body}`;
}

export function errorFrameToEvents(payload: {
  code: string;
  message: string;
  details?: unknown;
}): TurnEvent[] {
  const events: TurnEvent[] = [
    { type: "validation_error", errors: [{ path: payload.code, message: payload.message }] },
  ];
  if (
    payload.code === "pending_elicitation_blocked" ||
    payload.code === "elicitation_validation_failed"
  ) {
    const pe = (payload.details as { pending_elicitation?: unknown } | null | undefined)
      ?.pending_elicitation;
    if (pe && typeof pe === "object") {
      const e = pe as {
        id?: unknown;
        tool_name?: unknown;
        summary?: unknown;
        tool_call_id?: unknown;
        input?: unknown;
      };
      if (typeof e.id === "string" && typeof e.tool_name === "string") {
        events.push({
          type: "elicit_request",
          elicitation_id: e.id,
          tool_name: e.tool_name,
          summary: typeof e.summary === "string" ? e.summary : "",
          input: e.input ?? {},
          ...(typeof e.tool_call_id === "string" ? { tool_call_id: e.tool_call_id } : {}),
        });
      }
    }
  }
  return events;
}
