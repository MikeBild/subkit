// TurnEvent union + shared reducer. Used by `apps/sk` across its
// interactive and headless surfaces. Mirrors the engine's `TurnEvent` shape in
// `apps/engine/src/conversations/types.ts`, with the
// CLI-friendly richer `completed` frame that carries usage.

import type { SuggestNextKind, SuggestNextReason } from "@shared/suggest-next-reasons.ts";

export interface TurnUsage {
  turn_tokens: number;
  remaining_monthly_budget_tokens: number | null;
  /** Effective per-prompt context cap for the model that just ran. The
   *  REPL footer renders a `ctx N/M` gauge against this so the operator
   *  sees pressure on the model's window before they hit it. Optional
   *  for backward compat. */
  context_cap_tokens?: number;
  /** Per-section breakdown of the prompt that drove this turn — what
   *  the engine actually fed the LLM. When present, the spinner /
   *  status line render `skills 4.2k · transcript 6.1k · draft 1.3k`
   *  so the operator can see WHERE the tokens went, not just how
   *  many. Optional: omit when the engine has no breakdown to share
   *  (e.g. a non-LLM tool turn). */
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
      /**
       * The originating `conversation_tool_calls` row id (the gated
       * tool, OR the ask_user_* tool the LLM emitted directly). Clients
       * can correlate the elicitation back to "the tool call that
       * paused" without a follow-up DB read, and may resume by either id.
       */
      tool_call_id?: string;
      /** Which `ask_user_*` tool paused the loop. */
      tool_name: string;
      /** Short row-level summary (audit + list view). */
      summary: string;
      /** Full tool input payload (question, options, fields, diff, target, etc). */
      input: unknown;
      /** Structured pending-output preview from the gated tool, for rich confirm UIs. */
      pending_output?: Record<string, unknown> | null;
      parent_message_id?: string;
    }
  | { type: "committed"; workflow_id: string }
  | { type: "completed"; status: string; usage?: TurnUsage }
  /**
   * Single-line activity ticker — see `ActivityState`. Mirrors the
   * engine's `apps/engine/src/conversations/types.ts` discriminant.
   */
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
  /**
   * Inline unified-diff cell. Engine pre-computes the line hunks; the
   * CLI renders a colored gutter + content cell. Used for workflow /
   * connector mutations so the operator sees structural changes
   * inline as a patch-history cell.
   */
  | {
      type: "diff";
      title: string;
      language: "json" | "yaml" | "text";
      hunks: Array<{ kind: "+" | "-" | " "; text: string }>;
      parent_message_id?: string;
    }
  /**
   * Next-message preview frame — emitted exactly once per turn, after
   * `completed`, before the SSE outcome envelope. Drives the ghost-text
   * suggestion in the input composer. The `reason` and `kind` enums
   * come from `@shared/suggest-next-reasons` so this stays in lockstep
   * with the engine's TurnEvent + Zod schema with no hand-maintained
   * mirror to drift.
   */
  | {
      type: "next_suggestion";
      suggestion: string | null;
      reason: SuggestNextReason;
      kind: SuggestNextKind | null;
    };

/**
 * Pending user-input request — populated when the loop pauses on any
 * `askUser.*` tool. The client renders a component based on
 * `tool_name` and posts the answer to
 * `POST /v1/conversations/:id/elicitations/:eid/respond`.
 */
export interface PendingElicitation {
  id: string;
  tool_name: string;
  /**
   * Originating tool-call id, when the engine surfaces it on the
   * elicit_request event. Lets the UI correlate the prompt to "the
   * tool that paused" and lets clients resume by either id.
   */
  tool_call_id?: string | null;
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

/**
 * Activity ticker payload — single-line "what's happening right now"
 * status the CLI renders between the transcript and the spinner. Set
 * by every `activity` TurnEvent; cleared on `completed`.
 *
 * Intentionally NOT folded into transcript cells: keep transient
 * progress separate from durable history. Pre-fix the
 * `summarising N tool results` line was the only signal during long
 * LLM-text-composition phases — operators saw the spinner and a token
 * count but no hint of WHAT the engine was doing.
 */
export interface ActivityState {
  phase: "tool" | "composing" | "idle";
  label: string;
  tool_name?: string;
  call_id?: string;
  last_completed?: { tool_name: string; ok: boolean; duration_ms: number };
  /** Wall-clock timestamp of the last update — used by the CLI's
   *  ActivityLine to render an "elapsed" hint when the same phase
   *  stays active for a long time. */
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
  /** Live streaming buffer — assistant text being built token-by-token. */
  streamingAssistantText: string;
  /**
   * Remainder of the persisted assistant text the stream has not
   * delivered yet. The engine can emit the persisted `message` event
   * MID-STREAM (observed in conversation 68b5c87e: text_delta*,
   * message with identical full text — self-parented —, then more
   * text_delta frames replaying the tail). The `message` handler
   * records `persistedText.slice(buffer.length)` here; subsequent
   * deltas that replay that tail are swallowed instead of
   * re-accumulating into `streamingAssistantText`, which pre-fix
   * rendered a dangling mid-sentence duplicate below the full message.
   * A delta that diverges from the tail is a genuinely new stream and
   * accumulates normally.
   */
  expectedStreamTail: string;
  /** Live per-tool-call log entries (cleared when the tool result arrives). */
  toolLogs: ToolLogEntry[];
  /** Latest activity ticker payload — see ActivityState. `null` while
   *  no `activity` event has arrived in the current turn. */
  activity: ActivityState | null;
  /** Running total of `turn_tokens` accumulated across every
   *  `completed` event in this conversation. The footer renders it as
   *  `session <N>` so the operator sees what the current chat has
   *  cost so far. Reset only by `initialSessionState` (a fresh REPL /
   *  conversation). */
  sessionTotalTokens: number;
  /** Inline diff cells emitted by mutation tools (build_workflow,
   *  edit_workflow_patch). Threaded by `parent_message_id` so they
   *  render under the assistant message that triggered them. */
  diffs: Array<{
    id: string;
    title: string;
    language: "json" | "yaml" | "text";
    hunks: Array<{ kind: "+" | "-" | " "; text: string }>;
    parentMessageId?: string;
  }>;
  /**
   * Latest next-message suggestion frame emitted by the engine. The
   * Composer reads this AFTER the SSE stream closes (in `applyEventStream`)
   * and dispatches a `ghostSet` action when `suggestion !== null`.
   * Cleared on every new turn start so a stale suggestion doesn't leak
   * across turns.
   */
  nextSuggestion: {
    suggestion: string;
    kind: SuggestNextKind;
  } | null;
  /** Last reason emitted on a `next_suggestion` frame — used by tests + telemetry. */
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

export function parseRenderableMessageContent(content: unknown): {
  text: string;
  parts: RenderableMessagePart[];
} {
  const extracted = extractTextSegments(content);
  const text =
    extracted.length > 0
      ? extracted.join("\n\n")
      : isEffectivelyEmpty(content)
        ? ""
        : safeStringify(content);
  if (text.length === 0) return { text, parts: [] };
  return { text, parts: splitRenderableParts(text) };
}

// Engine assistant rows for tool-only steps carry `content: {}` (empty
// object) — they exist as a parent-id anchor for child tool calls but
// have no displayable text. Without this guard, `safeStringify({})`
// would emit the literal "{}" string into the transcript and the
// downstream empty-stub suppression in ink-app would miss because
// `parts` is non-empty.
function isEffectivelyEmpty(content: unknown): boolean {
  if (content === null || content === undefined) return true;
  if (typeof content === "string") return content.length === 0;
  if (Array.isArray(content)) return content.length === 0;
  if (typeof content === "object") return Object.keys(content as object).length === 0;
  return false;
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

/** Find the most recent assistant message ID. */
function lastAssistantMessageId(state: SkSessionState): string | undefined {
  for (let i = state.messages.length - 1; i >= 0; i--) {
    const m = state.messages[i];
    if (m && m.role === "assistant" && m.id) return m.id;
  }
  return undefined;
}

/**
 * Fold a persisted assistant `message` event into the session.
 *
 * Duplicate-output forensics (conversation 68b5c87e, elicitation-
 * resolution turn; conversation 35a3b9ba, pending ask_user_form turn):
 * the engine's delta stream is a CONTINUOUS lagging replay of the
 * concatenated assistant texts. The persisted `message` can land
 * mid-stream (68b5c87e), or AHEAD of every one of its deltas
 * (35a3b9ba: elicit_request → message → full-text delta), and a single
 * delta can span a message boundary (tail of the previous message +
 * the full next text in one frame). Three reconciliations keep each
 * message a single cell:
 *
 *   1. same-id replay → reconcile in place (longer text wins) instead
 *      of appending a clone;
 *   2. adjacent assistant message whose text equals (or is a
 *      prefix-extension of) the previous one → replace the previous
 *      cell, mirroring the user-echo dedupe precedent;
 *   3. persisted text the delta stream has not delivered yet is
 *      APPENDED to `expectedStreamTail` — a queue of
 *      persisted-but-not-yet-replayed text — so the `text_delta`
 *      handler swallows lagging replays (including ones that cross a
 *      message boundary) instead of re-rendering them. Pre-fix the
 *      tail was only armed when the buffer was a NON-EMPTY prefix, so
 *      a message arriving ahead of its deltas armed nothing and the
 *      replay rendered the same text again — visually duplicated
 *      around the pending elicitation panel.
 *
 * Distinct assistant messages (different texts between tool calls)
 * still append normally — multi-message turns keep every cell.
 */
function applyAssistantMessage(
  state: SkSessionState,
  next: MessageState,
  text: string,
): SkSessionState {
  const buffer = state.streamingAssistantText;
  // Portion of `text` already accounted for: delivered live by the
  // delta stream (the buffer), or armed into the replay queue when an
  // earlier copy of this message landed (same-id replay / adjacent
  // duplicate). Only the remainder joins `expectedStreamTail`. `null`
  // means the live buffer diverged from the persisted text — the
  // stream position is unknown, so the queue resets conservatively.
  let accountedPrefix: string | null = text.startsWith(buffer) ? buffer : null;

  let messages = state.messages;
  const sameIdIdx = next.id
    ? messages.findIndex((m) => m.role === "assistant" && m.id === next.id)
    : -1;
  if (sameIdIdx >= 0) {
    const existing = messages[sameIdIdx];
    // The first arrival already armed its full text — a replay must
    // not double-arm, or the queue would expect the replay twice.
    if (existing) accountedPrefix = text.startsWith(existing.content) ? existing.content : null;
    // Longer text wins — a replay carrying extended text reconciles to
    // the fuller form; a truncated replay never shrinks the cell.
    if (existing && existing.content.length <= text.length) {
      messages = [...messages];
      messages[sameIdIdx] = next;
    }
  } else {
    const prior = messages[messages.length - 1];
    const priorText = prior?.role === "assistant" ? prior.content.trim() : "";
    const newText = text.trim();
    const duplicatesPrior =
      priorText.length > 0 && (newText === priorText || newText.startsWith(priorText));
    if (duplicatesPrior && prior) {
      // The superseded cell's text was armed when it arrived — only
      // the extension (if any) is new to the replay queue.
      accountedPrefix = text.startsWith(prior.content) ? prior.content : null;
    }
    messages = duplicatesPrior ? [...messages.slice(0, -1), next] : [...messages, next];
  }
  const expectedStreamTail =
    accountedPrefix !== null ? state.expectedStreamTail + text.slice(accountedPrefix.length) : "";
  return { ...state, messages, streamingAssistantText: "", expectedStreamTail };
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
      if (ev.role === "assistant") {
        return applyAssistantMessage(state, next, parsed.text);
      }
      // Dedupe optimistic user echoes: when the CLI synthesised a
      // local `user` message before the engine round-trip (so the
      // operator sees their input immediately), the engine then
      // replays the persisted form as a `message` event with an id.
      // Replace the local optimistic copy in-place rather than
      // appending a duplicate `you` line. Two cases collapse:
      //
      //   1. prior message is local (no id) → ALWAYS supersede.
      //      Content equality is NOT required: client-side preprocessors
      //      (e.g. `apps/sk/src/lib/path-preprocessor.ts` swaps an
      //      absolute path token for `{"$file":"fid_..."}` before the
      //      prompt reaches the engine) rewrite content between the
      //      optimistic echo and the engine-persisted form. The
      //      busy-flag (`busyRef.current`) at the submit site
      //      guarantees only one optimistic echo is in flight per
      //      turn, so the next engine-emitted user message is
      //      unambiguously its persisted partner.
      //   2. prior message is engine-anchored (has id) but its
      //      trimmed content matches the new event AND its id differs
      //      → replace (engine replayed the same user turn twice;
      //      seen in session dcdcf246's "› you 1 / › you 1"
      //      double-render).
      let messages = state.messages;
      const prior = messages[messages.length - 1];
      const isUserEcho = ev.role === "user" && messages.length > 0 && prior?.role === "user";
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
        // A user message starts a new turn — any leftover tail
        // expectation from the previous assistant message is stale.
        ...(ev.role === "user" ? { expectedStreamTail: "" } : {}),
      };
    }
    case "text_delta": {
      const tail = state.expectedStreamTail;
      if (tail.length > 0) {
        if (tail.startsWith(ev.text)) {
          // Replay of text the persisted assistant message already
          // materialized (engine emitted `message` mid-stream) —
          // swallow the delta, advance the expectation. Pre-fix this
          // re-accumulated into streamingAssistantText and rendered a
          // mid-sentence duplicate below the full message.
          return { ...state, expectedStreamTail: tail.slice(ev.text.length) };
        }
        if (ev.text.startsWith(tail)) {
          // Delta covers the rest of the materialized text AND
          // continues beyond it — swallow the covered part, stream
          // only the genuinely new overflow.
          return {
            ...state,
            expectedStreamTail: "",
            streamingAssistantText: state.streamingAssistantText + ev.text.slice(tail.length),
          };
        }
        // Divergent — a new assistant stream started; drop the stale
        // expectation and accumulate normally.
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
      if (idx >= 0) {
        const existing = calls[idx];
        if (existing)
          calls[idx] = {
            ...existing,
            status,
            result: ev.output,
            ...(existing.parent_message_id ? {} : {}),
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
      const input = ev.input_partial === undefined ? undefined : ev.input_partial;
      // Starting a new tool call invalidates any stale top-level
      // validation errors emitted by the previous failed attempt. The
      // LLM is iterating; the previous draft's errors aren't the
      // user's problem to solve. The new attempt either succeeds
      // (errors stay cleared) or emits its own fresh validation_error
      // event. Without this reset, the red "validation errors" block
      // sits in the transcript for the entire mid-turn loop, looking
      // like a permanent failure even when the next call succeeds.
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
        // Restore "running" status — the previous validation_error
        // event flipped it to "error" but a new tool call means the
        // turn is still active.
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
      // Accumulate session tokens across every turn so the footer
      // can render `session <N>` without re-querying the engine. The
      // engine's `tokens_today` / `tokens_month` come from /v1/status
      // (refreshed by ink-repl on `completed`); session-scoped totals
      // are CLI-only and live in this slot.
      const turnTokens = ev.usage?.turn_tokens ?? 0;
      return {
        ...state,
        status: nextStatus,
        usage: ev.usage ?? state.usage,
        pendingElicitation: ev.status === "awaiting_input" ? state.pendingElicitation : null,
        // Clear the activity ticker when the turn finishes — the
        // ActivityLine component then unmounts cleanly. Without this
        // an `idle · last: <tool>` line would linger past the turn.
        activity: null,
        // Each turn is its own SSE stream — a delta replay that hasn't
        // arrived by `completed` never will. Dropping the expectation
        // here keeps a stale queue from mis-swallowing (or diverging
        // on) the NEXT turn's stream.
        expectedStreamTail: "",
        sessionTotalTokens: state.sessionTotalTokens + turnTokens,
      };
    }
    case "activity": {
      // Single source of truth for the live ticker. Replaces (not
      // appends to) the previous payload — the renderer reads the
      // current activity slot and shows ONE line. Keep transient
      // progress separate from durable history. Never
      // appended to messages or cells, never persisted.
      const next: ActivityState = {
        phase: ev.phase,
        label: ev.label,
        ...(ev.tool_name !== undefined ? { tool_name: ev.tool_name } : {}),
        ...(ev.call_id !== undefined ? { call_id: ev.call_id } : {}),
        ...(ev.last_completed !== undefined ? { last_completed: ev.last_completed } : {}),
        updated_at: Date.now(),
      };
      return { ...state, activity: next };
    }
    case "diff": {
      // Append a diff entry threaded under the most recent assistant
      // message. The Ink renderer pulls these from session.diffs and
      // paints them inline below the parent assistant cell as a
      // patch-history cell.
      const parent = lastAssistantMessageId(state);
      return {
        ...state,
        diffs: [
          ...state.diffs,
          {
            id: `diff-${state.diffs.length}-${Date.now()}`,
            title: ev.title,
            language: ev.language,
            hunks: ev.hunks,
            ...(parent ? { parentMessageId: parent } : {}),
          },
        ],
      };
    }
    case "next_suggestion": {
      // Stash the latest frame so the Composer can dispatch ghostSet
      // after the SSE stream closes. We deliberately keep the reason
      // even when the suggestion is null so dashboards / tests can
      // pivot on suppression cause without re-parsing the stream.
      return {
        ...state,
        nextSuggestion:
          ev.suggestion && ev.kind ? { suggestion: ev.suggestion, kind: ev.kind } : null,
        nextSuggestionReason: ev.reason,
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

// Tools whose result payload IS the deliverable the user asked for. When a
// turn ends with no assistant prose (tool-only turn / synthesized fallback),
// `--output text` renders the last succeeded one of these instead of
// printing nothing — production sessions repeatedly saw `sk -p "run X and
// show results"` exit silently while the data sat in `toolCalls[i].result`.
const EXECUTION_TOOL_NAMES = new Set([
  "run_workflow",
  "dry_run_workflow",
  "call_connector",
  "tenant_call_connector",
]);

function isExecutionTool(name: string): boolean {
  // `wf_<slug>` are the per-workflow product tools.
  return EXECUTION_TOOL_NAMES.has(name) || name.startsWith("wf_");
}

export interface ExecutionResultRender {
  tool: string;
  output: unknown;
}

/**
 * Last succeeded execution-shaped tool result of the turn, or null. Failed
 * calls (`status==="failed"` or an `ok:false` envelope) never match — a
 * failure must fall through to the error/guidance text, not render as data.
 */
export function lastExecutionResult(state: SkSessionState): ExecutionResultRender | null {
  for (let i = state.toolCalls.length - 1; i >= 0; i--) {
    const c = state.toolCalls[i];
    if (!c || c.status !== "done" || !isExecutionTool(c.name)) continue;
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

/** Recursively cap arrays for display, marking what was sampled IN-BAND so a
 *  human (or downstream agent) reading the text knows the payload is partial
 *  rather than mistaking the sample for the full result. */
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

/**
 * Compact, metadata-preserving text rendering of an execution result.
 * Arrays are sampled (marker appended in-band), the whole body is capped,
 * and the tool name headers the block so the output is self-describing.
 */
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

/**
 * Translate an engine `error` SSE frame into the synthetic `TurnEvent`s
 * the session reducer should apply.
 *
 * Every error becomes a `validation_error` so the rejection is visible.
 * For `pending_elicitation_blocked` the engine also ships the still-open
 * dialog in `details.pending_elicitation` — we replay it as an
 * `elicit_request` so the client RESTORES the dialog and routes the next
 * answer to it. Without this the reducer's fresh per-turn state left
 * `pendingElicitation` null after a blocked prompt, and the session
 * deadlocked: the engine kept rejecting every prompt while the client
 * showed no dialog to resolve.
 */
export function errorFrameToEvents(payload: {
  code: string;
  message: string;
  details?: unknown;
}): TurnEvent[] {
  const events: TurnEvent[] = [
    { type: "validation_error", errors: [{ path: payload.code, message: payload.message }] },
  ];
  // Both codes ship a live pending dialog in `details.pending_elicitation`:
  // `pending_elicitation_blocked` (a prompt arrived while input was
  // pending) and `elicitation_validation_failed` (the answer was rejected
  // server-side — the row stays pending and the re-sent input carries
  // `error_message` pins on the offending fields).
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
        // Applied AFTER the validation_error so `status` ends
        // `awaiting_input` (not `error`) and the dialog is live again.
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
