// Single ordered transcript of typed cells — the chat-native model
// the `sk` CLI will render in its Ink TUI.
//
// This module ships ahead of the renderer migration. The cell types
// + factories + reducer are pure and have no UI consumers yet; the
// existing `applyTurnEvent` (in `./turn-event.ts`) keeps the legacy
// state shape working until the Ink renderer flips over.
//
// Design contract (read this before changing anything below):
//
// 1. Two-bucket state: a push-only `cells` array of FINALIZED cells,
//    plus exactly ONE in-progress `active` cell at any time. The
//    reducer mutates `active` in place while data streams in, and
//    flips it into `cells` on finalization. Ink's `<Static>` only
//    sees finalized cells, so committed rows never re-render and the
//    transcript never reflows after a turn lands.
//
// 2. Chronological by construction: `tool_call_start` finalizes any
//    streaming `AssistantCell` first so the assistant's "thought"
//    always lands BEFORE the tool that thought triggered. A
//    `tool_result` with `ok:false` synthesizes a trailing `ErrorCell`
//    so failures appear in the transcript at the moment they happen,
//    not as a late-arriving banner.
//
// 3. Stable ids: never regenerate a cell id once assigned. UserCell
//    and AssistantCell prefer the engine-issued `message.id`; tool
//    cells use `call_id`; the welcome cell is the literal `"welcome"`.
//    Ink keys on these ids — duplicates make the transcript flicker.
//
// 4. Invariant: at most one `ToolCell` may be `status:"running"` at a
//    time. The engine serializes tool execution per turn. If the
//    invariant is ever violated, the earlier tool degrades to a
//    static "running…" line — correctness over spinner fidelity.

import type {
  PendingElicitation,
  RenderableMessagePart,
  ToolLogEntry,
  ToolStatus,
  TurnEvent,
  TurnUsage,
} from "./turn-event.ts";
import { parseRenderableMessageContent } from "./turn-event.ts";

export type CellKind =
  | "welcome"
  | "user"
  | "assistant"
  | "tool"
  | "error"
  | "system"
  | "elicit"
  | "diff";

export type ErrorOrigin =
  | "slash"
  | "http"
  | "sse"
  | "tool"
  | "validation"
  | "internal"
  | "transport"
  | "loop_guard";

/**
 * Immutable per-cell audit log. Captures user intent so the engine's
 * agent (and the operator-facing `/audit` pane) can distinguish
 * "user tested" from "user confirmed" from "engine auto-declined"
 * without inferring from message text.
 */
export type InteractionEvent =
  | "user_submitted"
  | "user_approved"
  | "user_declined"
  | "user_edited"
  | "user_stopped"
  | "engine_auto_declined"
  | "engine_retried"
  | "engine_timeout"
  | "engine_error";

export interface InteractionLogEntry {
  id: string;
  event: InteractionEvent;
  at: number;
  payload?: Record<string, unknown>;
}

export interface BaseCell {
  id: string;
  createdAt: number;
  finalized: boolean;
  traceId?: string | null;
  interactionLog?: InteractionLogEntry[];
}

export interface WelcomeCell extends BaseCell {
  kind: "welcome";
}

export interface UserCell extends BaseCell {
  kind: "user";
  text: string;
  parts?: RenderableMessagePart[];
}

export interface AssistantCell extends BaseCell {
  kind: "assistant";
  text: string;
  parts?: RenderableMessagePart[];
  streaming: boolean;
  /** ids of ToolCells the assistant triggered (kept for inline display). */
  toolRefs: string[];
}

export interface ToolCell extends BaseCell {
  kind: "tool";
  name: string;
  args: unknown;
  status: ToolStatus;
  result?: unknown;
  logs: ToolLogEntry[];
  parentMessageId?: string | null;
}

export interface ErrorCell extends BaseCell {
  kind: "error";
  origin: ErrorOrigin;
  message: string;
  hint?: string;
  detail?: string;
}

export interface SystemCell extends BaseCell {
  kind: "system";
  message: string;
  tone: "dim" | "info" | "warn";
  data?: { label: string; body: unknown };
}

export interface ElicitationCell extends BaseCell {
  kind: "elicit";
  elicitationId: string;
  toolName: string;
  summary: string;
  input: unknown;
  status: "open" | "resolved" | "cancelled";
  outcome?: { kind: "approved" | "declined" | "answered"; reason?: string };
  parentMessageId?: string | null;
}

/**
 * Inline unified-diff cell. Holds engine-computed line hunks for a
 * structural mutation (workflow build, patch). The renderer paints a
 * codex-style colored gutter + content view.
 */
export interface DiffCell extends BaseCell {
  kind: "diff";
  title: string;
  language: "json" | "yaml" | "text";
  hunks: Array<{ kind: "+" | "-" | " "; text: string }>;
  parentMessageId?: string | null;
}

export type TranscriptCell =
  | WelcomeCell
  | UserCell
  | AssistantCell
  | ToolCell
  | ErrorCell
  | SystemCell
  | ElicitationCell
  | DiffCell;

/**
 * Ephemeral, TTL-bounded notice rendered in a fixed-height slot above
 * the composer — for "queued (N)" style confirmations that should
 * NOT scroll into the transcript.
 */
export interface NoticeCell {
  id: string;
  tone: "info" | "success" | "warn";
  message: string;
  expiresAt: number;
}

let cellCounter = 0;
export function nextCellId(prefix: string): string {
  cellCounter += 1;
  const ts = Date.now().toString(36);
  return `${prefix}-${ts}-${cellCounter.toString(36)}`;
}

export function newWelcomeCell(): WelcomeCell {
  return {
    kind: "welcome",
    id: "welcome",
    createdAt: Date.now(),
    finalized: true,
  };
}

export function newUserCell(args: {
  id?: string;
  text: string;
  parts?: RenderableMessagePart[];
  traceId?: string | null;
}): UserCell {
  const cell: UserCell = {
    kind: "user",
    id: args.id ?? nextCellId("u"),
    createdAt: Date.now(),
    finalized: true,
    text: args.text,
  };
  if (args.parts && args.parts.length > 0) cell.parts = args.parts;
  if (args.traceId) cell.traceId = args.traceId;
  return cell;
}

export function newAssistantCell(args: {
  id?: string;
  text?: string;
  parts?: RenderableMessagePart[];
  streaming: boolean;
  traceId?: string | null;
}): AssistantCell {
  const cell: AssistantCell = {
    kind: "assistant",
    id: args.id ?? nextCellId("a"),
    createdAt: Date.now(),
    finalized: !args.streaming,
    text: args.text ?? "",
    streaming: args.streaming,
    toolRefs: [],
  };
  if (args.parts && args.parts.length > 0) cell.parts = args.parts;
  if (args.traceId) cell.traceId = args.traceId;
  return cell;
}

export function newToolCell(args: {
  id: string;
  name: string;
  args: unknown;
  parentMessageId?: string | null;
  traceId?: string | null;
}): ToolCell {
  return {
    kind: "tool",
    id: args.id,
    createdAt: Date.now(),
    finalized: false,
    name: args.name,
    args: args.args,
    status: "running",
    logs: [],
    ...(args.parentMessageId ? { parentMessageId: args.parentMessageId } : {}),
    ...(args.traceId ? { traceId: args.traceId } : {}),
  };
}

export function newErrorCell(args: {
  origin: ErrorOrigin;
  message: string;
  hint?: string;
  detail?: string;
  traceId?: string | null;
}): ErrorCell {
  const cell: ErrorCell = {
    kind: "error",
    id: nextCellId("e"),
    createdAt: Date.now(),
    finalized: true,
    origin: args.origin,
    message: args.message,
  };
  if (args.hint) cell.hint = args.hint;
  if (args.detail) cell.detail = args.detail;
  if (args.traceId) cell.traceId = args.traceId;
  return cell;
}

export function newSystemCell(args: {
  message: string;
  tone?: "dim" | "info" | "warn";
  data?: { label: string; body: unknown };
  traceId?: string | null;
}): SystemCell {
  const cell: SystemCell = {
    kind: "system",
    id: nextCellId("s"),
    createdAt: Date.now(),
    finalized: true,
    message: args.message,
    tone: args.tone ?? "dim",
  };
  if (args.data) cell.data = args.data;
  if (args.traceId) cell.traceId = args.traceId;
  return cell;
}

export function newElicitationCell(args: {
  elicitationId: string;
  toolName: string;
  summary: string;
  input: unknown;
  parentMessageId?: string | null;
  traceId?: string | null;
}): ElicitationCell {
  return {
    kind: "elicit",
    id: `elicit-${args.elicitationId}`,
    createdAt: Date.now(),
    finalized: false,
    elicitationId: args.elicitationId,
    toolName: args.toolName,
    summary: args.summary,
    input: args.input,
    status: "open",
    ...(args.parentMessageId ? { parentMessageId: args.parentMessageId } : {}),
    ...(args.traceId ? { traceId: args.traceId } : {}),
  };
}

export function newDiffCell(args: {
  title: string;
  language: "json" | "yaml" | "text";
  hunks: Array<{ kind: "+" | "-" | " "; text: string }>;
  parentMessageId?: string | null;
  traceId?: string | null;
}): DiffCell {
  return {
    kind: "diff",
    id: nextCellId("diff"),
    createdAt: Date.now(),
    finalized: true,
    title: args.title,
    language: args.language,
    hunks: args.hunks,
    ...(args.parentMessageId ? { parentMessageId: args.parentMessageId } : {}),
    ...(args.traceId ? { traceId: args.traceId } : {}),
  };
}

export function appendInteraction(
  cell: TranscriptCell,
  event: InteractionEvent,
  payload?: Record<string, unknown>,
): TranscriptCell {
  const entry: InteractionLogEntry = {
    id: nextCellId("i"),
    event,
    at: Date.now(),
    ...(payload ? { payload } : {}),
  };
  return {
    ...cell,
    interactionLog: [...(cell.interactionLog ?? []), entry],
  };
}

export function isAssistantCell(c: TranscriptCell): c is AssistantCell {
  return c.kind === "assistant";
}
export function isToolCell(c: TranscriptCell): c is ToolCell {
  return c.kind === "tool";
}
export function isErrorCell(c: TranscriptCell): c is ErrorCell {
  return c.kind === "error";
}
export function isElicitationCell(c: TranscriptCell): c is ElicitationCell {
  return c.kind === "elicit";
}

// --------------------------------------------------------------------
// Cell-based reducer + state. PARALLEL to the legacy `applyTurnEvent`
// in `./turn-event.ts`. The Ink renderer migrates to this in a
// follow-up PR; for now this is exported as foundation and exercised
// directly by `cell-reducer.test.ts`.
// --------------------------------------------------------------------

export interface CellState {
  cells: TranscriptCell[];
  active: TranscriptCell | null;
  pendingElicitation: PendingElicitation | null;
  status: "running" | "awaiting_input" | "completed" | "error";
  usage: TurnUsage | null;
  committedWorkflowId: string | null;
  /** Trace id of the most recent inbound turn, propagated onto cells. */
  currentTraceId: string | null;
}

export function initialCellState(): CellState {
  return {
    cells: [],
    active: null,
    pendingElicitation: null,
    status: "running",
    usage: null,
    committedWorkflowId: null,
    currentTraceId: null,
  };
}

function commitActive(state: CellState): CellState {
  if (!state.active) return state;
  const finalized: TranscriptCell = { ...state.active, finalized: true };
  return { ...state, cells: [...state.cells, finalized], active: null };
}

function lastAssistantCellId(state: CellState): string | undefined {
  for (let i = state.cells.length - 1; i >= 0; i--) {
    const c = state.cells[i];
    if (c && c.kind === "assistant") return c.id;
  }
  if (state.active && state.active.kind === "assistant") return state.active.id;
  return undefined;
}

function findToolCell(
  state: CellState,
  callId: string,
): { location: "active" | "cells"; index: number; cell: ToolCell } | null {
  if (state.active && state.active.kind === "tool" && state.active.id === callId) {
    return { location: "active", index: -1, cell: state.active };
  }
  for (let i = state.cells.length - 1; i >= 0; i--) {
    const c = state.cells[i];
    if (c && c.kind === "tool" && c.id === callId) {
      return { location: "cells", index: i, cell: c };
    }
  }
  return null;
}

function replaceCell(
  state: CellState,
  location: "active" | "cells",
  index: number,
  next: TranscriptCell,
): CellState {
  if (location === "active") {
    return { ...state, active: next };
  }
  const cells = [...state.cells];
  cells[index] = next;
  return { ...state, cells };
}

function humanizeToolFailure(toolName: string, output: unknown): string {
  if (output === null || typeof output !== "object") return `${toolName} failed`;
  const obj = output as Record<string, unknown>;
  if (typeof obj.error === "string") return `${toolName}: ${obj.error}`;
  if (typeof obj.message === "string") return `${toolName}: ${obj.message}`;
  if (Array.isArray(obj.errors) && obj.errors.length > 0) {
    const first = obj.errors[0] as { message?: unknown } | undefined;
    if (first && typeof first.message === "string") return `${toolName}: ${first.message}`;
  }
  return `${toolName} failed`;
}

/**
 * Synthetic frame yielded by SSE consumers when a frame fails to
 * parse. The reducer renders it as an inline ErrorCell so the user
 * sees the failure in the transcript instead of a silent skip.
 */
export type CellTurnEvent = TurnEvent | { type: "__sse_parse_error"; raw: string; reason: string };

/** Pure cell reducer. */
export function applyTurnEventToCells(state: CellState, ev: CellTurnEvent): CellState {
  const traceId = state.currentTraceId;
  switch (ev.type) {
    case "message": {
      const parsed = parseRenderableMessageContent(ev.content);
      if (ev.role === "user") {
        const flushed = state.active ? commitActive(state) : state;
        return {
          ...flushed,
          cells: [
            ...flushed.cells,
            newUserCell({
              ...(ev.id ? { id: ev.id } : {}),
              text: parsed.text,
              ...(parsed.parts.length > 0 ? { parts: parsed.parts } : {}),
              traceId,
            }),
          ],
        };
      }
      if (ev.role === "assistant") {
        if (state.active && isAssistantCell(state.active)) {
          const finalized: AssistantCell = {
            ...state.active,
            ...(ev.id ? { id: ev.id } : {}),
            text: parsed.text,
            ...(parsed.parts.length > 0 ? { parts: parsed.parts } : {}),
            streaming: false,
            finalized: true,
          };
          return { ...state, active: null, cells: [...state.cells, finalized] };
        }
        return {
          ...state,
          cells: [
            ...state.cells,
            newAssistantCell({
              ...(ev.id ? { id: ev.id } : {}),
              text: parsed.text,
              ...(parsed.parts.length > 0 ? { parts: parsed.parts } : {}),
              streaming: false,
              traceId,
            }),
          ],
        };
      }
      return {
        ...state,
        cells: [
          ...state.cells,
          newSystemCell({
            message: parsed.text,
            tone: ev.role === "tool" ? "info" : "dim",
            traceId,
          }),
        ],
      };
    }

    case "text_delta": {
      if (state.active && isAssistantCell(state.active)) {
        const next: AssistantCell = {
          ...state.active,
          text: state.active.text + ev.text,
        };
        return { ...state, active: next };
      }
      return {
        ...state,
        active: newAssistantCell({ streaming: true, text: ev.text, traceId }),
      };
    }

    case "tool_call_start": {
      let next = state;
      let assistantId: string | null = null;
      if (next.active && isAssistantCell(next.active)) {
        assistantId = next.active.id;
        next = commitActive(next);
      } else if (next.active && isToolCell(next.active)) {
        next = commitActive(next);
      }
      const parentMessageId =
        ev.parent_message_id ?? assistantId ?? lastAssistantCellId(next) ?? null;
      const tool = newToolCell({
        id: ev.call_id,
        name: ev.tool,
        args: ev.input_partial,
        parentMessageId,
        traceId,
      });
      let cells = next.cells;
      if (parentMessageId) {
        cells = next.cells.map((c) => {
          if (c.kind === "assistant" && c.id === parentMessageId) {
            return { ...c, toolRefs: [...c.toolRefs, tool.id] };
          }
          return c;
        });
      }
      return { ...next, cells, active: tool };
    }

    case "tool_call_delta": {
      const found = findToolCell(state, ev.call_id);
      if (!found) return state;
      const merged =
        typeof found.cell.args === "object" && found.cell.args !== null
          ? {
              ...(found.cell.args as Record<string, unknown>),
              ...(ev.input_patch as Record<string, unknown>),
            }
          : ev.input_patch;
      return replaceCell(state, found.location, found.index, { ...found.cell, args: merged });
    }

    case "tool_call_end": {
      const found = findToolCell(state, ev.call_id);
      if (!found) return state;
      return replaceCell(state, found.location, found.index, { ...found.cell, args: ev.input });
    }

    case "tool_log": {
      const found = findToolCell(state, ev.call_id);
      if (!found) return state;
      const log: ToolLogEntry = {
        call_id: ev.call_id,
        tool: ev.tool,
        level: ev.level,
        message: ev.message,
        ts: ev.ts,
      };
      return replaceCell(state, found.location, found.index, {
        ...found.cell,
        logs: [...found.cell.logs, log],
      });
    }

    case "tool_result": {
      const found = findToolCell(state, ev.call_id);
      const isFailure =
        typeof ev.output === "object" &&
        ev.output !== null &&
        (ev.output as { ok?: unknown }).ok === false;
      const status: ToolStatus = isFailure ? "failed" : "done";
      let next: CellState;
      if (found) {
        const updated: ToolCell = {
          ...found.cell,
          status,
          result: ev.output,
          finalized: true,
        };
        if (found.location === "active") {
          next = { ...state, active: null, cells: [...state.cells, updated] };
        } else {
          const cells = [...state.cells];
          cells[found.index] = updated;
          next = { ...state, cells };
        }
      } else {
        const tool = newToolCell({
          id: ev.call_id,
          name: ev.tool,
          args: undefined,
          ...(ev.parent_message_id ? { parentMessageId: ev.parent_message_id } : {}),
          traceId,
        });
        next = {
          ...state,
          cells: [...state.cells, { ...tool, status, result: ev.output, finalized: true }],
        };
      }
      if (isFailure) {
        next = {
          ...next,
          cells: [
            ...next.cells,
            newErrorCell({
              origin: "tool",
              message: humanizeToolFailure(ev.tool, ev.output),
              traceId,
            }),
          ],
        };
      }
      return next;
    }

    case "data_part":
      return state; // pure transcript model — data parts are tracked elsewhere

    case "validation_error": {
      const errorCells = ev.errors.map((e) =>
        newErrorCell({
          origin: "validation",
          message: e.message,
          detail: e.path,
          traceId,
        }),
      );
      return {
        ...state,
        status: "error",
        cells: [...state.cells, ...errorCells],
      };
    }

    case "elicit_request": {
      const parentMessageId = ev.parent_message_id ?? lastAssistantCellId(state) ?? null;
      const cell = newElicitationCell({
        elicitationId: ev.elicitation_id,
        toolName: ev.tool_name,
        summary: ev.summary,
        input: ev.input,
        parentMessageId,
        traceId,
      });
      let next = state;
      if (next.active && isAssistantCell(next.active)) {
        next = commitActive(next);
      }
      return {
        ...next,
        status: "awaiting_input",
        cells: [...next.cells, cell],
        pendingElicitation: {
          id: ev.elicitation_id,
          tool_name: ev.tool_name,
          summary: ev.summary,
          input: ev.input,
          ...(parentMessageId ? { parent_message_id: parentMessageId } : {}),
        },
      };
    }

    case "committed":
      return {
        ...state,
        committedWorkflowId: ev.workflow_id,
        pendingElicitation: null,
        cells: [
          ...state.cells,
          newSystemCell({
            message: `committed workflow ${ev.workflow_id}`,
            tone: "info",
            traceId,
          }),
        ],
      };

    case "completed": {
      const nextStatus: CellState["status"] =
        ev.status === "awaiting_input" ? "awaiting_input" : "completed";
      let flushed = state;
      if (flushed.active) flushed = commitActive(flushed);
      return {
        ...flushed,
        status: nextStatus,
        usage: ev.usage ?? flushed.usage,
        pendingElicitation: ev.status === "awaiting_input" ? flushed.pendingElicitation : null,
      };
    }

    case "__sse_parse_error":
      return {
        ...state,
        cells: [
          ...state.cells,
          newErrorCell({
            origin: "sse",
            message: "malformed SSE frame — see ~/.sk/debug.log",
            detail: ev.reason,
            traceId,
          }),
        ],
      };

    case "diff": {
      // Inline diff cell — engine emits these after a draft mutation
      // (build_workflow / edit_workflow_patch). Codex pattern: render
      // a colored unified diff inline so the operator sees structural
      // change without scrolling back. Always finalized at insertion.
      let flushed = state;
      if (flushed.active) flushed = commitActive(flushed);
      // Anchor under the most recent assistant cell so the diff threads
      // with the message that triggered it.
      let parent: string | null = null;
      for (let i = flushed.cells.length - 1; i >= 0; i--) {
        const c = flushed.cells[i];
        if (c && isAssistantCell(c)) {
          parent = c.id;
          break;
        }
      }
      return {
        ...flushed,
        cells: [
          ...flushed.cells,
          newDiffCell({
            title: ev.title,
            language: ev.language,
            hunks: ev.hunks,
            ...(parent ? { parentMessageId: parent } : {}),
            traceId,
          }),
        ],
      };
    }

    default:
      return state;
  }
}

export type { RenderableMessagePart, ToolLogEntry, ToolStatus, TurnUsage };
