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

export const SPINNER_FRAMES = ["⣾", "⣽", "⣻", "⢿", "⡿", "⣟", "⣯", "⣷"] as const;

function summarizeSuccessData(data: unknown): string | null {
  if (data === null || typeof data !== "object") return null;
  const obj = data as Record<string, unknown>;
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

export const MESSAGE_ROW_INDENT = 8;
const MESSAGE_ROW_RIGHT_MARGIN = 2;

export const MessageRow: React.FC<{
  role: string;
  content: string;
  parts?: RenderableMessagePart[] | undefined;
  columns?: number;
  citations?: Citation[] | undefined;
}> = memo(({ role, content, parts, columns, citations }) => {
  const theme = useTheme();
  const footer = formatCitationsFooter(citations);
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

export const StatusBar: React.FC<{ statusLine: string; columns: number }> = memo(
  ({ statusLine, columns }) => {
    const theme = useTheme();
    if (!statusLine) return null;
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

export function renderValidationErrorsBlock(
  validationErrors: SkSessionState["validationErrors"],
  status: SkSessionState["status"],
): React.ReactNode {
  if (
    !(
      validationErrors.length > 0 &&
      (status === "error" || status === "awaiting_input" || status === "completed")
    )
  ) {
    return null;
  }
  const kinds = validationErrors.map((e) =>
    classifyEngineError({
      path: e.path,
      message: typeof e.message === "string" ? e.message : JSON.stringify(e.message),
    }),
  );
  const headerLabel = kinds.includes("spend_limit")
    ? "AI budget"
    : kinds.includes("provider_limit")
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

export function renderTurnSpinner(
  toolCalls: ToolCallState[],
  busy: boolean,
  turnTokens: number | null,
): React.ReactNode {
  const running = toolCalls.find((c) => c.status === "running" || c.status === "pending");
  const completedThisTurn = toolCalls.filter(
    (c) => c.status === "done" || c.status === "failed",
  ).length;
  const failed = toolCalls.filter((c) => c.status === "failed");
  const lastFailure = failed[failed.length - 1];
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
