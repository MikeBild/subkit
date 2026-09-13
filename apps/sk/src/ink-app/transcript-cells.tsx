// Transcript cell components for the Ink REPL.
//
// Pure presentational pieces rendered into the scrollback: the
// tool-call card, next-best-action chips, message rows, the turn
// separator, the telemetry status bar, plus the validation-error and
// thinking-spinner blocks that sit between the transcript and the
// composer. All of them are pure consumers of session state — no
// engine traffic, no input handling.

import { useTheme } from "@chat-ui/index.ts";
import type {
  Citation,
  RenderableMessagePart,
  SkSessionState,
  ToolCallState,
} from "@cli-core/index.ts";
import { Box, Text } from "ink";
import type React from "react";
import { memo, useEffect, useState } from "react";

import { formatCitationsFooter } from "../lib/citations-footer.ts";
import {
  classifyEngineError,
  humanizeValidationError,
  summarizeToolFailure,
} from "../repl/error-humanize.ts";
import { MessageContent } from "../repl/message-content.tsx";
import { Spinner } from "../repl/spinner.tsx";
import { resolveTaskActionSuggestion } from "../repl/task-actions.ts";
import { truncateEnd, truncateMiddle } from "../repl/truncate.ts";

// ---------- Tool-call card ----------
//
// Indented under the turn with a `⎿` glyph. Status glyph colors by
// state (running yellow, done green, failed red). One-line input
// summary stays visible; full output stays collapsed until the user
// expands (Ctrl+E in a future iteration — for now always compact).

export const SPINNER_FRAMES = ["⣾", "⣽", "⣻", "⢿", "⡿", "⣟", "⣯", "⣷"] as const;

function summarizeSuccessData(data: unknown): string | null {
  if (data === null || typeof data !== "object") return null;
  const obj = data as Record<string, unknown>;
  // Most of our tools return `{ok, data: {...}}`; unwrap once so the
  // user sees the meaningful keys instead of just `ok: true`.
  const inner =
    "data" in obj && typeof obj.data === "object" && obj.data !== null
      ? (obj.data as Record<string, unknown>)
      : obj;
  const parts: string[] = [];
  for (const [k, v] of Object.entries(inner)) {
    if (k === "ok" || k.startsWith("_")) continue;
    if (v === null || v === undefined) continue;
    if (typeof v === "string") parts.push(`${k}: ${v}`);
    else if (typeof v === "number" || typeof v === "boolean") parts.push(`${k}: ${v}`);
    else if (Array.isArray(v)) parts.push(`${k}: ${v.length}`);
    if (parts.length >= 4) break;
  }
  return parts.length > 0 ? parts.join(", ") : null;
}

/**
 * Extract the auto-commit envelope from a tool result. A green
 * `dry_run_workflow` returns `{ ok, data: { auto_committed: true,
 * version, slug?, workflow_id? } }`; this surfaces the version + a
 * human label so the CLI can render a one-line committed event.
 */
function autoCommitInfo(result: unknown): { version: number; label: string } | null {
  if (result === null || typeof result !== "object") return null;
  const obj = result as Record<string, unknown>;
  const inner =
    "data" in obj && typeof obj.data === "object" && obj.data !== null
      ? (obj.data as Record<string, unknown>)
      : obj;
  if (inner.auto_committed !== true) return null;
  if (typeof inner.version !== "number") return null;
  const label =
    typeof inner.slug === "string"
      ? inner.slug
      : typeof inner.name === "string"
        ? inner.name
        : typeof inner.workflow_id === "string"
          ? inner.workflow_id
          : "workflow";
  return { version: inner.version, label };
}

interface ToolCardProps {
  call: ToolCallState;
  columns: number;
  detailed: boolean;
}

export const ToolCard: React.FC<ToolCardProps> = memo(({ call, columns, detailed }) => {
  const theme = useTheme();
  const [tick, setTick] = useState(0);
  useEffect(() => {
    if (call.status !== "running") return;
    const id = setInterval(() => setTick((t) => t + 1), 80);
    return () => {
      clearInterval(id);
    };
  }, [call.status]);

  // Reserve ~2 (⎿ ), 2 (glyph + space), name length, 2 (parens) for the
  // header line. The remainder is for the args summary.
  const headerOverhead = 6 + call.name.length;
  const argsBudget = Math.max(20, columns - headerOverhead);
  const argsJson =
    typeof call.args === "object" && call.args !== null ? JSON.stringify(call.args) : "";
  const argsSummary = argsJson ? truncateMiddle(argsJson, argsBudget) : "";

  let glyph: string;
  let color: string;
  if (call.status === "running") {
    glyph = SPINNER_FRAMES[tick % SPINNER_FRAMES.length] ?? "⣾";
    color = theme.severity.info;
  } else if (call.status === "done") {
    glyph = "✓";
    color = theme.emphasis.added;
  } else if (call.status === "failed") {
    glyph = "×";
    color = theme.severity.error;
  } else {
    glyph = "·";
    color = theme.severity.dim;
  }

  // Result/error body — transparency block. Always
  // visible for failures (the operator needs the reason to course-
  // correct); collapsed for successes unless explicitly expanded.
  const bodyLines: Array<{ text: string; tone: "ok" | "fail" | "dim" }> = [];
  if (call.status === "failed" && call.result !== undefined) {
    const inner =
      typeof call.result === "object" && call.result !== null && "data" in call.result
        ? (call.result as { data: unknown }).data
        : call.result;
    const summary = summarizeToolFailure(call.name, inner);
    bodyLines.push({ text: summary.label, tone: "fail" });
    if (summary.hint) bodyLines.push({ text: summary.hint, tone: "dim" });
  } else if (detailed && call.status === "done" && call.result !== undefined) {
    const summary = summarizeSuccessData(call.result);
    if (summary) {
      const lineBudget = Math.max(20, columns - 6);
      bodyLines.push({ text: truncateEnd(summary, lineBudget), tone: "dim" });
    }
  }
  // Auto-commit surfacing: a green `dry_run_workflow` persists the
  // workflow inline (`auto_committed: true` with `version` + `slug` /
  // `workflow_id`). Render a clear one-line committed event so the
  // operator sees the write landed instead of it being invisible.
  if (call.status === "done" && call.result !== undefined) {
    const committed = autoCommitInfo(call.result);
    if (committed) {
      bodyLines.push({
        text: `✓ Committed v${committed.version} · ${committed.label}`,
        tone: "ok",
      });
    }
  }

  const toneColor = (tone: "ok" | "fail" | "dim"): string =>
    tone === "fail"
      ? theme.severity.error
      : tone === "ok"
        ? theme.emphasis.added
        : theme.severity.dim;

  return (
    <Box flexDirection="column">
      <Box>
        <Text color={theme.severity.dim}>⎿ </Text>
        <Text color={color} bold>
          {glyph}
        </Text>
        <Text> </Text>
        <Text color={theme.role.tool} bold>
          {call.name}
        </Text>
        {argsSummary ? <Text color={theme.severity.dim}>({argsSummary})</Text> : null}
      </Box>
      {bodyLines.map((ln, i) => (
        <Box key={`tcbody-${call.id}-${i}`}>
          <Text color={theme.severity.dim}> </Text>
          <Text color={toneColor(ln.tone)}>{ln.text}</Text>
        </Box>
      ))}
    </Box>
  );
});
ToolCard.displayName = "ToolCard";

// ---------- Next-best-actions chips ----------
//
// When an engine tool returns `{ ok: false, next_best_actions: [...] }`,
// the suggested follow-up tools render below the tool card as inverse-
// styled numbered chips. The user can either type
// `please run <tool_name>` themselves or — while the composer is empty
// — press the chip number (1..9) to dispatch a synthetic message
// through the same submit path.
//
// The shape lives at one of two paths in `call.result`:
//   * top-level: `{ ok: false, next_best_actions: [...] }`
//   * nested under `data`: `{ ok: false, data: { next_best_actions: [...] } }`
// Both are produced by different tools today; we accept either.

const MAX_CHIPS = 9;

export function extractNextBestActions(result: unknown): string[] {
  if (!result || typeof result !== "object") return [];
  const top = result as Record<string, unknown>;
  if (top.ok !== false) return [];
  const fromTop = Array.isArray(top.next_best_actions) ? top.next_best_actions : null;
  const data = typeof top.data === "object" && top.data !== null ? top.data : null;
  const fromData =
    data && Array.isArray((data as Record<string, unknown>).next_best_actions)
      ? ((data as Record<string, unknown>).next_best_actions as unknown[])
      : null;
  const raw = fromTop ?? fromData ?? [];
  const out: string[] = [];
  for (const entry of raw) {
    if (typeof entry === "string" && entry.trim().length > 0) out.push(entry.trim());
    if (out.length >= MAX_CHIPS) break;
  }
  return out;
}

interface NextBestActionsChipsProps {
  actions: string[];
}

export const NextBestActionsChips: React.FC<NextBestActionsChipsProps> = memo(({ actions }) => {
  const theme = useTheme();
  if (actions.length === 0) return null;
  return (
    <Box>
      <Text color={theme.severity.dim}> suggested next: </Text>
      {actions.map((action, idx) => {
        const mapped = resolveTaskActionSuggestion(action);
        const label = mapped ? mapped.label : action;
        return (
          <Box key={`chip-${idx}-${action}`}>
            <Text inverse>{` [${idx + 1}] ${label} `}</Text>
            <Text> </Text>
          </Box>
        );
      })}
    </Box>
  );
});
NextBestActionsChips.displayName = "NextBestActionsChips";

// ---------- Message row ----------

export const MESSAGE_ROW_INDENT = 8; // 2 glyph + 6 label
const MESSAGE_ROW_RIGHT_MARGIN = 2; // safety so a wide ¶ doesn't kiss the right edge

export const MessageRow: React.FC<{
  role: string;
  content: string;
  parts?: RenderableMessagePart[] | undefined;
  /**
   * Terminal column count, used to constrain the body box width so
   * continuation lines don't lose the speaker indent. Pre-fix the
   * absence of this prop made Ink wrap at full terminal width and
   * split words across the column origin (session 86de186b).
   */
  columns?: number;
  /** Source refs for an assistant answer → dim "Sources: …" footer.
   *  Absent/empty on citation-less turns (no footer, byte-identical). */
  citations?: Citation[] | undefined;
}> = memo(({ role, content, parts, columns, citations }) => {
  const theme = useTheme();
  const footer = formatCitationsFooter(citations);
  // Speaker label + glyph. Two columns: a 2-char glyph slot, then a
  // fixed-width label so wrapping body text aligns under itself, not
  // under the label — `›  you` for the operator, `•  sk` for the
  // assistant, `$  tool` for tool calls, `·` for system rows.
  const glyph = role === "user" ? "›" : role === "assistant" ? "•" : role === "tool" ? "$" : "·";
  const label =
    role === "user" ? "you" : role === "assistant" ? "sk" : role === "tool" ? "tool" : "";
  const color =
    role === "user"
      ? theme.role.user
      : role === "assistant"
        ? theme.role.assistant
        : role === "tool"
          ? theme.role.tool
          : theme.role.system;
  return (
    <Box flexDirection="row" marginBottom={1}>
      <Box flexShrink={0} width={2}>
        <Text color={color} bold>
          {glyph}
        </Text>
      </Box>
      <Box flexShrink={0} width={6}>
        <Text color={color} bold>
          {label}
        </Text>
      </Box>
      <Box flexDirection="column" flexGrow={1}>
        <MessageContent
          content={content}
          parts={parts}
          {...(typeof columns === "number" && columns > 0
            ? {
                width: Math.max(16, columns - MESSAGE_ROW_INDENT - MESSAGE_ROW_RIGHT_MARGIN),
              }
            : {})}
        />
        {role === "assistant" && footer ? <Text color={theme.role.system}>{footer}</Text> : null}
      </Box>
    </Box>
  );
});
MessageRow.displayName = "MessageRow";

export const TurnSeparator: React.FC<{ columns?: number | undefined }> = memo(({ columns }) => {
  const theme = useTheme();
  const width = Math.max(20, Math.min(columns ?? 80, 120));
  return (
    <Box marginBottom={1}>
      <Text color={theme.severity.dim} dimColor>
        {"─".repeat(width)}
      </Text>
    </Box>
  );
});
TurnSeparator.displayName = "TurnSeparator";

// ---------- Status bar ----------

export const StatusBar: React.FC<{ statusLine: string; columns: number }> = memo(
  ({ statusLine, columns }) => {
    const theme = useTheme();
    if (!statusLine) return null;
    // Reserve 4 cols for the leading `╌ ` prefix + a small safety
    // margin so resize does not push the line onto a second row mid-
    // glyph.
    const clamped = truncateEnd(statusLine, Math.max(20, columns - 4));
    return (
      <Box marginBottom={1}>
        <Text color={theme.severity.dim}>╌ </Text>
        <Text color={theme.severity.dim}>{clamped}</Text>
      </Box>
    );
  },
);
StatusBar.displayName = "StatusBar";

// ---------- Validation-error block ----------

/* Validation errors — surfaced only when the turn is actually
   in a terminal failure state. Mid-turn iterations clear via
   the `tool_call_start` reducer reset; the block here stays
   for awaiting_input / completed / error so the user has the
   last word on what failed. Tone follows status: error → red
   (real failure), other → yellow (the LLM may still recover). */
export function renderValidationErrorsBlock(
  validationErrors: SkSessionState["validationErrors"],
  status: SkSessionState["status"],
): React.ReactNode {
  if (!(
    validationErrors.length > 0 &&
    (status === "error" || status === "awaiting_input" || status === "completed")
  )) {
    return null;
  }
  // Pick a header that matches the *kind* of error. Pre-fix
  // every error landed under "validation errors" — so an
  // upstream-Anthropic quota reset to "validation errors ·
  // internal" left the operator hunting for a workflow bug
  // that didn't exist.
  const kinds = validationErrors.map((e) =>
    classifyEngineError({
      path: e.path,
      message: typeof e.message === "string" ? e.message : JSON.stringify(e.message),
    }),
  );
  const headerLabel = kinds.includes("provider_limit")
    ? "LLM provider limit"
    : kinds.includes("provider_unavailable")
      ? "LLM provider unavailable"
      : status === "error"
        ? "validation errors"
        : "draft validation";
  const tone = status === "error" ? "red" : "yellow";
  return (
    <Box flexDirection="column" marginBottom={1}>
      <Text color={tone} bold>
        {headerLabel}
      </Text>
      {validationErrors.map((e, idx) => {
        const h = humanizeValidationError({
          path: e.path,
          message: typeof e.message === "string" ? e.message : JSON.stringify(e.message),
        });
        return (
          <Box key={`err-${idx}`} flexDirection="column">
            <Text color={tone}>× {h.label}</Text>
            {h.hint ? <Text color="yellow"> ↳ {h.hint}</Text> : null}
            {h.detail ? <Text dimColor> {h.detail}</Text> : null}
          </Box>
        );
      })}
    </Box>
  );
}

// ---------- Thinking spinner block ----------

/* Thinking spinner — surfaces the in-flight tool name so the
   user sees concrete progress instead of just "thinking…" for
   long turns. Pre-fix session 86de186b sat on "thinking…
   1m16s" while the engine ran author_workflow → validate_draft
   → dry_run_workflow with no visibility. */
export function renderTurnSpinner(
  toolCalls: ToolCallState[],
  busy: boolean,
  turnTokens: number | null,
): React.ReactNode {
  const running = toolCalls.find((c) => c.status === "running" || c.status === "pending");
  // Count tools that COMPLETED this turn (status done/failed)
  // so we can show "processing N tool result(s)…" instead of
  // the rotating verb when the LLM is composing without an
  // active tool call.
  const completedThisTurn = toolCalls.filter(
    (c) => c.status === "done" || c.status === "failed",
  ).length;
  const failed = toolCalls.filter((c) => c.status === "failed");
  const lastFailure = failed[failed.length - 1];
  // Best-effort: pull `error_code` from the last failed tool's
  // result envelope. Surface it in the spinner so a long
  // recovery flow reads "5 tools failed (slug_already_in_use)"
  // instead of an opaque "processing 5 tool results" — the
  // exact symptom of session 975a64b0 (3m09s of opaque
  // summarisation while the LLM tried to recover from a
  // 23505 unique-violation).
  const lastFailureCode = (() => {
    const result = lastFailure?.result as
      | {
          error_code?: unknown;
          error?: unknown;
          data?: { error_code?: unknown };
        }
      | undefined;
    if (!result) return null;
    if (typeof result.error_code === "string") return result.error_code;
    if (typeof result.data?.error_code === "string") return result.data.error_code;
    if (typeof result.error === "string") return result.error;
    return null;
  })();
  return (
    <Spinner
      active={busy}
      turnTokens={turnTokens}
      currentTool={running?.name ?? null}
      completedToolsThisTurn={running ? 0 : completedThisTurn}
      failedToolsThisTurn={failed.length}
      lastFailureCode={lastFailureCode}
    />
  );
}
