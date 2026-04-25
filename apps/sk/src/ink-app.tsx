// Ink-based rich REPL root for `sk`.
//
// Wires together every UX surface described in the Claude Code
// adoption plan:
//
//   * <WelcomeBanner> on first paint (unicode-block logo + tip)
//   * Scriptable status line with rate-limited rebuild ticker
//   * Animated thinking spinner (rotating verbs + elapsed + tokens)
//   * Blinking `●` tool-call dot
//   * Fuzzy slash-command autocomplete footer (Fuse.js)
//   * Ctrl-T alternate-screen transcript toggle
//   * useDeferredValue on the message list so long histories stay
//     responsive when typing
//   * Kind-specific approval router for commit_draft / external_write
//
// The component is a pure consumer of the engine stream — all
// state transitions go through `applyTurnEvent` from @cli-core.

import {
  ConversationBrowser,
  type ElicitationResponse,
  ElicitRouter,
  ExitFlow,
  HistorySearch,
  Pane,
  ScrollView,
  StatusPane,
  ThemeProvider,
  useTheme,
} from "@chat-ui/index.ts";
import type {
  RenderableMessagePart,
  SkSessionState,
  ToolCallState,
  TurnEvent,
} from "@cli-core/index.ts";
import { applyTurnEvent, initialSessionState } from "@cli-core/index.ts";
import { Box, Static, Text, useApp, useInput, useStdout } from "ink";
import type React from "react";
import { memo, useCallback, useDeferredValue, useEffect, useMemo, useRef, useState } from "react";
import { debugLog, serializeDebugError } from "./debug.ts";
import type { SetupValidationResponse, StatusSummary } from "./engine-client.ts";
import { AlternateScreen } from "./repl/alt-screen.tsx";
import { ResumeSummaryCard, renderAuthoringCard } from "./repl/authoring-cards.tsx";
import { BackgroundToolGroup, isBackgroundTool } from "./repl/background-tools.tsx";
import { classifyAttachment, readClipboard } from "./repl/clipboard-read.ts";
import {
  humanizeRequestError,
  humanizeValidationError,
  summarizeToolFailure,
} from "./repl/error-humanize.ts";
import { Footer } from "./repl/footer.tsx";
import { appendHistory, defaultHistoryPath, loadPromptRing } from "./repl/history-store.ts";
import { InlineHistorySearch } from "./repl/inline-history-search.tsx";
import {
  apply as applyInput,
  buffer,
  cursorPosition,
  EMPTY_BUFFER,
  type InputBuffer,
  lineEnd,
  lineStart,
  splitLines,
} from "./repl/input-buffer.ts";
import {
  applyMention,
  extractMention,
  type MentionCandidate,
  MentionPicker,
} from "./repl/mention-picker.tsx";
import { MessageContent } from "./repl/message-content.tsx";
import { type NoticeItem, NoticeStack, type NoticeTone } from "./repl/notices.tsx";
import {
  createPasteStore,
  expandRefs,
  looksLikePaste,
  type PasteStore,
  type StoredPaste,
} from "./repl/paste-store.ts";
import { PendingAttachments } from "./repl/pending-attachments.tsx";
import { createQueue } from "./repl/queue.ts";
import type { PaneSpec } from "./repl/slash-handler.ts";
import { Spinner } from "./repl/spinner.tsx";
import { StarterActions, starterActionsForPersona } from "./repl/starter-actions.tsx";
import { truncateEnd, truncateMiddle } from "./repl/truncate.ts";
import { pickTip, WelcomeBanner } from "./repl/welcome-banner.tsx";
import { findSlashCommand, type PersonaProbe, renderHelp, searchSlashCommands } from "./slash.ts";
import {
  buildStatusLine,
  type PermissionMode,
  resolveRefreshMs,
  type StatusLineConfig,
  type StatusLineInput,
} from "./status-line.ts";

export interface InkAppProps {
  persona: {
    label: string;
    tenant: string | null;
    engineUrl: string;
    profileName: string;
    probe: PersonaProbe;
  };
  /** Status line configuration from merged settings. */
  statusLineConfig?: StatusLineConfig;
  /** Initial conversation id when resuming. */
  initialConversationId?: string | null;
  /** Current model id for the status-line input payload. */
  model?: string | null;
  /** cwd captured at REPL startup so the status line doesn't race chdir. */
  cwd?: string;
  /**
   * Composite snapshot from `GET /v1/status`. The host refreshes this
   * after every completed turn (or on a slower cadence when idle) and
   * passes the latest into the app. Drives the subkit-tailored status
   * line fields: connectors_count, tokens_today, auth_status, etc.
   */
  statusSnapshot?: StatusSummary | null;
  /** Latest setup diagnostics snapshot when the persona can read it. */
  setupSnapshot?: SetupValidationResponse | null;
  /** Live engine-connection state from the host pinger. `null` means
   *  no pinger is active (tests, smoke paths). */
  connectionSnapshot?: {
    state: "online" | "reconnecting" | "offline" | "unknown";
    reason: string | null;
    last_ok_at: number | null;
    last_error_at: number | null;
  } | null;
  /** Active permission mode for the status line badge. */
  permissionMode?: PermissionMode;
  /**
   * Override the persistent-history file path. Tests pass a tmpdir
   * path so they don't read / mutate the real `~/.sk/history.jsonl`.
   */
  historyPath?: string;
  /** Called when the user submits a plain prompt (non-slash). */
  onPrompt: (
    text: string,
    opts?: { permission_mode?: "auto" | "ask" | "plan" },
  ) => Promise<{ events: AsyncIterable<TurnEvent>; conversationId: string }>;
  /** Called when the user submits a slash command other than `/exit`. */
  onSlash?: (
    name: string,
    raw: string,
    openPane: (spec: PaneSpec) => void,
    liveSession: SkSessionState,
  ) => Promise<string | null>;
  /**
   * Resume a past conversation — invoked when the user selects one from
   * the `/resume` browser pane. Returns the newly-attached id so the
   * Ink app can reset its session state.
   */
  onSelectConversation?: (id: string) => Promise<void>;
  /** Called on any elicitation response so the app can POST to the engine. */
  onElicitResponse?: (
    elicitationId: string,
    output: unknown,
    reason?: string,
  ) =>
    | Promise<{ events?: AsyncIterable<TurnEvent>; conversationId?: string | null } | undefined>
    | Promise<void>;
  /** Called when the user exits. */
  onExit?: () => void;
  /**
   * Optional resume summary rendered at the top of the transcript on a
   * fresh attach. Populated by the host from `GET /v1/conversations/:id`'s
   * `resume_summary` field when the user re-enters a paused authoring
   * session.
   */
  resumeSummary?: {
    active_target: {
      kind: "connector" | "workflow" | "none";
      name: string | null;
      environment: string | null;
    };
    stage: string;
    next_action: string;
    one_sentence: string;
    last_successful_probe: string | null;
    last_successful_preview: string | null;
  } | null;
}

// ---------- Tool-call card (Claude Code style) ----------
//
// Indented under the turn with a `⎿` glyph. Status glyph colors by
// state (running yellow, done green, failed red). One-line input
// summary stays visible; full output stays collapsed until the user
// expands (Ctrl+E in a future iteration — for now always compact).

const SPINNER_FRAMES = ["⣾", "⣽", "⣻", "⢿", "⡿", "⣟", "⣯", "⣷"] as const;

// Render an elicitation's `output` payload as a short, human-readable
// string for the transcript. Keeps the assistant turn auditable —
// without this the scrollback silently mutates ("approve" disappears
// from the record after the next LLM response).
function renderElicitAnswer(output: unknown, reason?: string): string {
  const suffix = reason ? ` — ${reason}` : "";
  if (output === null || output === undefined) return `(no answer)${suffix}`;
  if (typeof output === "string") return `${output}${suffix}`;
  if (typeof output === "number" || typeof output === "boolean") {
    return `${String(output)}${suffix}`;
  }
  if (typeof output === "object") {
    const obj = output as Record<string, unknown>;
    if (obj.confirmed === true) return `approve${suffix}`;
    if (obj.confirmed === false || obj.declined === true) return `reject${suffix}`;
    if (obj.tested === true) return `test${suffix}`;
    if (obj.partial === true) return `partial${suffix}`;
    if (typeof obj.value === "string") return `${obj.value}${suffix}`;
    if (typeof obj.choice === "string") return `${obj.choice}${suffix}`;
    if (Array.isArray(obj.choices)) return `${(obj.choices as unknown[]).join(", ")}${suffix}`;
    // Generic form output — show the first few keys inline.
    const parts: string[] = [];
    for (const [k, v] of Object.entries(obj)) {
      if (typeof v === "string") parts.push(`${k}=${v}`);
      else if (typeof v === "number" || typeof v === "boolean") parts.push(`${k}=${v}`);
      if (parts.length >= 3) break;
    }
    if (parts.length > 0) return `${parts.join(", ")}${suffix}`;
  }
  return `(answered)${suffix}`;
}

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

function latestToolOutcome(calls: ToolCallState[], names: Set<string>): string | null {
  for (let i = calls.length - 1; i >= 0; i--) {
    const call = calls[i];
    if (!call || !names.has(call.name)) continue;
    if (call.status === "failed") return "failed";
    if (call.status === "done") return "ok";
    return null;
  }
  return null;
}

const PROBE_TOOLS = new Set(["probe_connector", "probe_connector_draft"]);
const PREVIEW_TOOLS = new Set(["dry_run_step", "dry_run_workflow"]);

interface ToolCardProps {
  call: ToolCallState;
  columns: number;
  detailed: boolean;
}

const ToolCard: React.FC<ToolCardProps> = memo(({ call, columns, detailed }) => {
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

  // Result/error body — Claude-Code-style transparency block. Always
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

// ---------- Message row (Claude Code style) ----------

const MessageRow: React.FC<{
  role: string;
  content: string;
  parts?: RenderableMessagePart[] | undefined;
}> = memo(({ role, content, parts }) => {
  const theme = useTheme();
  // Speaker label + glyph. Two columns: a 2-char glyph slot, then a
  // fixed-width label so wrapping body text aligns under itself, not
  // under the label. Pattern mirrors the codex-rs / reference-agent
  // chat surface — `›  you` for the operator, `•  sk` for the
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
        <MessageContent content={content} parts={parts} />
      </Box>
    </Box>
  );
});
MessageRow.displayName = "MessageRow";

// ---------- Status bar ----------

const StatusBar: React.FC<{ statusLine: string; columns: number }> = memo(
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

// ---------- Composer ----------
//
// Bordered-input layout, Claude-Code style:
//
//   ─────────────────────────────────────────
//   ❯ <typed text><blinking cursor>
//   ─────────────────────────────────────────
//
// The horizontal rules render `─` repeated to the terminal width so the
// composer frame follows window resizes. When the app is waiting on a
// turn, the `❯` glyph rotates through SPINNER_FRAMES instead of
// blinking — same spinner verbs the ToolCard uses, so the REPL feels
// cohesive.

const DEFAULT_RULE_WIDTH = 80;

interface ComposerProps {
  input: InputBuffer;
  busy: boolean;
  placeholder?: string;
}

const Composer: React.FC<ComposerProps> = memo(({ input, busy, placeholder }) => {
  const theme = useTheme();
  const { stdout } = useStdout();
  const columns = stdout?.columns ?? DEFAULT_RULE_WIDTH;
  const [cursorOn, setCursorOn] = useState(true);
  const [tick, setTick] = useState(0);
  useEffect(() => {
    const id = setInterval(() => setCursorOn((c) => !c), 500);
    return () => clearInterval(id);
  }, []);
  useEffect(() => {
    if (!busy) return;
    const id = setInterval(() => setTick((t) => t + 1), 80);
    return () => clearInterval(id);
  }, [busy]);
  const ruleWidth = Math.max(8, Math.min(columns, 160));
  const rule = "─".repeat(ruleWidth);
  const glyph = busy ? (SPINNER_FRAMES[tick % SPINNER_FRAMES.length] ?? "⣾") : "❯";

  const { row, column } = cursorPosition(input);
  const lines = splitLines(input.value);
  const isEmpty = input.value.length === 0;
  const cursorChar = cursorOn ? "▊" : "·";
  const cursorColor = cursorOn ? theme.role.assistant : theme.severity.dim;
  const prefixColor = busy ? theme.severity.warning : theme.role.assistant;

  return (
    <Box flexDirection="column">
      <Text color={theme.severity.dim}>{rule}</Text>
      {lines.map((line, i) => {
        const prefix = i === 0 ? `${glyph} ` : "  ";
        const before = i === row ? line.slice(0, column) : line;
        const after = i === row ? line.slice(column) : "";
        return (
          <Box key={`composer-row-${i}`}>
            <Text color={prefixColor} bold>
              {prefix}
            </Text>
            {i === 0 && isEmpty && placeholder ? (
              <Text color={theme.severity.dim}>{placeholder}</Text>
            ) : (
              <>
                <Text>{before}</Text>
                {i === row ? <Text color={cursorColor}>{cursorChar}</Text> : null}
                <Text>{after}</Text>
              </>
            )}
          </Box>
        );
      })}
      <Text color={theme.severity.dim}>{rule}</Text>
    </Box>
  );
});
Composer.displayName = "Composer";

// ---------- Slash-command suggestions footer ----------

interface SuggestionListProps {
  query: string;
  probe: PersonaProbe;
  selectedIndex: number;
}

const SuggestionList: React.FC<SuggestionListProps> = memo(({ query, probe, selectedIndex }) => {
  const matches = useMemo(() => searchSlashCommands(query, probe, 5), [query, probe]);
  if (!query.startsWith("/") || matches.length === 0) return null;
  return (
    <Box flexDirection="column" marginTop={1}>
      <Text dimColor>matches (↑/↓ select · Tab complete · Enter run):</Text>
      {matches.map((cmd, idx) => {
        const isSelected = idx === selectedIndex;
        return (
          <Box key={`sug-${cmd.name}`}>
            {isSelected ? <Text color="cyan">▸ </Text> : <Text> </Text>}
            <Text color="cyan" bold={isSelected}>
              /{cmd.name}
            </Text>
            <Text dimColor> — {cmd.help}</Text>
          </Box>
        );
      })}
    </Box>
  );
});
SuggestionList.displayName = "SuggestionList";

type TranscriptMode = "chat" | "inspect";

const WORKFLOW_STARTER_PROMPT = [
  "I want to build a workflow.",
  "Guide me one question at a time.",
  "Ask first which connectors are involved, what should trigger it, and what success looks like.",
  "Preview before commit.",
].join("\n");

const CONNECTOR_STARTER_PROMPT = [
  "I want to create a connector.",
  "Suggest a template only if it clearly helps, but do not require one.",
  "Ask me one high-signal question at a time and probe before saving.",
].join("\n");

const MANAGE_STARTER_PROMPT = [
  "I want to inspect or manage existing tenant resources.",
  "Ground me in the workflows, connectors, runs, or credentials that actually exist first.",
  "If a matching write action exists, use it with confirmation instead of inventing off-surface fallbacks.",
].join("\n");

const SURFACE_HELP_STARTER_PROMPT = [
  "I want help using Subkit surfaces such as sk, MCP, the HTTP API, schedules, or Google Chat.",
  "Answer from actual Subkit behavior and exposed routes only.",
  "If something is not exposed in this conversation surface, say that plainly.",
].join("\n");

interface TranscriptNotice extends NoticeItem {
  expires_at?: number | undefined;
}

const PaneLabelRow: React.FC<{ label: string; value: string; dim?: boolean }> = memo(
  ({ label, value, dim = false }) => (
    <Box>
      <Text dimColor>{label}: </Text>
      {dim ? <Text color="gray">{value}</Text> : <Text>{value}</Text>}
    </Box>
  ),
);
PaneLabelRow.displayName = "PaneLabelRow";

const TemplatePickerPane: React.FC<{
  pane: Extract<PaneSpec, { kind: "template-picker" }>;
  onDismiss: () => void;
}> = memo(({ pane, onDismiss }) => (
  <Pane title={pane.title} onDismiss={onDismiss}>
    {pane.connector_name ? <PaneLabelRow label="connector" value={pane.connector_name} /> : null}
    {pane.current_template ? (
      <PaneLabelRow label="current template" value={pane.current_template} />
    ) : null}
    <Box flexDirection="column" marginTop={1}>
      {pane.lines.map((line, i) => (
        <Text key={`tpl-${i}`}>{line}</Text>
      ))}
    </Box>
  </Pane>
));
TemplatePickerPane.displayName = "TemplatePickerPane";

const ConnectorDraftPane: React.FC<{
  pane: Extract<PaneSpec, { kind: "connector-draft" }>;
  onDismiss: () => void;
}> = memo(({ pane, onDismiss }) => (
  <Pane title={pane.title} onDismiss={onDismiss}>
    <PaneLabelRow label="name" value={pane.connector.name} />
    <PaneLabelRow label="slug" value={pane.connector.slug} />
    <PaneLabelRow label="driver" value={pane.connector.driver} />
    <PaneLabelRow label="environment" value={pane.connector.environment} />
    <PaneLabelRow label="auth" value={pane.connector.auth_type} />
    <PaneLabelRow label="base_url" value={pane.connector.base_url} />
    <PaneLabelRow label="dsn" value={pane.connector.dsn} />
    <PaneLabelRow label="template" value={pane.connector.template} />
    <PaneLabelRow label="saved id" value={pane.connector.saved_id} />
    {pane.missing_fields.length > 0 ? (
      <Box flexDirection="column" marginTop={1}>
        <Text color="yellow" bold>
          validation
        </Text>
        <Text color="yellow">missing: {pane.missing_fields.join(", ")}</Text>
      </Box>
    ) : null}
    {pane.latest_probe ? (
      <Box flexDirection="column" marginTop={1}>
        <Text color={pane.latest_probe.ok ? "green" : "red"} bold>
          latest probe
        </Text>
        <PaneLabelRow
          label="request"
          value={`${pane.latest_probe.method} ${pane.latest_probe.path}`}
        />
        <PaneLabelRow label="environment" value={pane.latest_probe.environment} />
        <PaneLabelRow label="http" value={pane.latest_probe.status} />
        <PaneLabelRow label="duration" value={pane.latest_probe.duration} />
        <PaneLabelRow label="summary" value={pane.latest_probe.summary} />
        <PaneLabelRow label="failure code" value={pane.latest_probe.failure_code} />
      </Box>
    ) : null}
  </Pane>
));
ConnectorDraftPane.displayName = "ConnectorDraftPane";

const WorkflowDraftPane: React.FC<{
  pane: Extract<PaneSpec, { kind: "workflow-draft" }>;
  onDismiss: () => void;
}> = memo(({ pane, onDismiss }) => (
  <Pane title={pane.title} onDismiss={onDismiss}>
    <PaneLabelRow label="name" value={pane.workflow.name} />
    <PaneLabelRow label="slug" value={pane.workflow.slug} />
    <PaneLabelRow label="description" value={pane.workflow.description} />
    <Box flexDirection="column" marginTop={1}>
      <Text color={pane.workflow.steps.length > 0 ? "green" : "yellow"} bold>
        steps · {pane.workflow.steps.length}
      </Text>
      {pane.workflow.steps.map((step) => (
        <Text key={`wf-step-${step.id}`}>
          {step.id} · {step.kind}
        </Text>
      ))}
    </Box>
    {pane.latest_preview ? (
      <Box flexDirection="column" marginTop={1}>
        <Text color={pane.latest_preview.ok ? "green" : "red"} bold>
          latest preview
        </Text>
        <PaneLabelRow label="step" value={pane.latest_preview.step} />
        <PaneLabelRow label="summary" value={pane.latest_preview.summary} />
      </Box>
    ) : null}
  </Pane>
));
WorkflowDraftPane.displayName = "WorkflowDraftPane";

const StepDetailPane: React.FC<{
  pane: Extract<PaneSpec, { kind: "step-detail" }>;
  onDismiss: () => void;
}> = memo(({ pane, onDismiss }) => (
  <Pane title={pane.title} onDismiss={onDismiss}>
    <PaneLabelRow label="ordinal" value={String(pane.step.ordinal)} />
    <PaneLabelRow label="id" value={pane.step.id} />
    <PaneLabelRow label="kind" value={pane.step.kind} />
    <Box flexDirection="column" marginTop={1}>
      {pane.step.lines.map((line, i) => (
        <Text key={`step-line-${i}`}>{line}</Text>
      ))}
    </Box>
  </Pane>
));
StepDetailPane.displayName = "StepDetailPane";

const ContextPane: React.FC<{
  pane: Extract<PaneSpec, { kind: "context" }>;
  onDismiss: () => void;
}> = memo(({ pane, onDismiss }) => (
  <Pane title={pane.title} onDismiss={onDismiss}>
    <PaneLabelRow label="draft mode" value={pane.snapshot.draft_mode} />
    <PaneLabelRow label="authoring mode" value={pane.snapshot.authoring_mode ?? "—"} />
    <PaneLabelRow label="stage" value={pane.snapshot.authoring_stage ?? "—"} />
    <PaneLabelRow label="readiness" value={pane.snapshot.draft_summary?.readiness ?? "—"} />
    <PaneLabelRow
      label="next action"
      value={pane.snapshot.next_required_action ?? pane.snapshot.draft_summary?.next_action ?? "—"}
    />
    <PaneLabelRow
      label="blocked by"
      value={pane.snapshot.draft_summary?.blocked_by.join(", ") || "—"}
    />
    <PaneLabelRow label="messages" value={String(pane.snapshot.messages.total)} />
    <PaneLabelRow label="last role" value={pane.snapshot.messages.last_role ?? "—"} />
    <PaneLabelRow label="calls" value={String(pane.snapshot.tool_calls_total)} />
    <PaneLabelRow label="pending elicitations" value={String(pane.snapshot.pending_elicitations)} />
    {pane.snapshot.active_target ? (
      <Box flexDirection="column" marginTop={1}>
        <Text color="cyan" bold>
          active target
        </Text>
        <Text>
          {pane.snapshot.active_target.kind}
          {pane.snapshot.active_target.name ? ` · ${pane.snapshot.active_target.name}` : ""}
          {pane.snapshot.active_target.slug ? ` · ${pane.snapshot.active_target.slug}` : ""}
          {pane.snapshot.active_target.environment
            ? ` · ${pane.snapshot.active_target.environment}`
            : ""}
          {pane.snapshot.active_target.lifecycle_state
            ? ` · ${pane.snapshot.active_target.lifecycle_state}`
            : ""}
        </Text>
      </Box>
    ) : null}
    {pane.snapshot.checkpoint_statuses.length > 0 ? (
      <Box flexDirection="column" marginTop={1}>
        <Text color="cyan" bold>
          checkpoints
        </Text>
        {pane.snapshot.checkpoint_statuses.map((checkpoint) => (
          <Text key={`ctx-checkpoint-${checkpoint.key}`}>
            {checkpoint.key} · {checkpoint.status}
            {checkpoint.verified_by_tool ? ` · ${checkpoint.verified_by_tool}` : ""}
          </Text>
        ))}
      </Box>
    ) : null}
    <Box flexDirection="column" marginTop={1}>
      <Text color="cyan" bold>
        skills
      </Text>
      <Text>
        global: {pane.snapshot.skills.global.map((skill) => skill.title).join(", ") || "—"}
      </Text>
      <Text>
        connector: {pane.snapshot.skills.connector.map((skill) => skill.title).join(", ") || "—"}
      </Text>
      <Text>
        workflow: {pane.snapshot.skills.workflow.map((skill) => skill.title).join(", ") || "—"}
      </Text>
    </Box>
    {pane.snapshot.attachments.total > 0 ? (
      <Box flexDirection="column" marginTop={1}>
        <Text color="cyan" bold>
          attachments
        </Text>
        {pane.snapshot.attachments.items.map((item) => (
          <Text key={`ctx-attachment-${item.slug}`}>
            @attachment:{item.slug}
            {item.filename ? ` (${item.filename})` : ""}
          </Text>
        ))}
      </Box>
    ) : null}
    {pane.snapshot.latest_execution ? (
      <Box flexDirection="column" marginTop={1}>
        <Text color="cyan" bold>
          latest execution
        </Text>
        <Text>
          {pane.snapshot.latest_execution.status}
          {pane.snapshot.latest_execution.workflow_version_id
            ? ` · ${pane.snapshot.latest_execution.workflow_version_id}`
            : ""}
          {pane.snapshot.latest_execution.warnings_count > 0
            ? ` · ${pane.snapshot.latest_execution.warnings_count} warnings`
            : ""}
          {pane.snapshot.latest_execution.diagnosis_available ? " · diagnosis available" : ""}
        </Text>
      </Box>
    ) : null}
    {pane.snapshot.latest_diagnosis ? (
      <Box flexDirection="column" marginTop={1}>
        <Text color="cyan" bold>
          latest diagnosis
        </Text>
        <Text>{pane.snapshot.latest_diagnosis.reason}</Text>
      </Box>
    ) : null}
  </Pane>
));
ContextPane.displayName = "ContextPane";

const ProbeResultsPane: React.FC<{
  pane: Extract<PaneSpec, { kind: "probe-results" }>;
  onDismiss: () => void;
}> = memo(({ pane, onDismiss }) => (
  <Pane title={pane.title} onDismiss={onDismiss}>
    <Text color={pane.probe.ok ? "green" : "red"} bold>
      {pane.probe.ok ? "probe ok" : "probe failed"}
    </Text>
    <PaneLabelRow label="request" value={`${pane.probe.method} ${pane.probe.path}`} />
    <PaneLabelRow label="environment" value={pane.probe.environment} />
    <PaneLabelRow label="http" value={pane.probe.http} />
    <PaneLabelRow label="duration" value={pane.probe.duration} />
    <PaneLabelRow label="summary" value={pane.probe.summary} />
    <PaneLabelRow label="failure code" value={pane.probe.failure_code} />
  </Pane>
));
ProbeResultsPane.displayName = "ProbeResultsPane";

const PreviewResultsPane: React.FC<{
  pane: Extract<PaneSpec, { kind: "preview-results" }>;
  onDismiss: () => void;
}> = memo(({ pane, onDismiss }) => (
  <Pane title={pane.title} onDismiss={onDismiss}>
    <Text color={pane.preview.ok ? "green" : "red"} bold>
      {pane.preview.ok ? "preview ok" : "preview failed"}
    </Text>
    <PaneLabelRow label="step" value={pane.preview.step} />
    <PaneLabelRow label="summary" value={pane.preview.summary} />
    <Box flexDirection="column" marginTop={1}>
      {pane.preview.lines.map((line, i) => (
        <Text key={`preview-line-${i}`}>{line}</Text>
      ))}
    </Box>
  </Pane>
));
PreviewResultsPane.displayName = "PreviewResultsPane";

const VersionBrowserPane: React.FC<{
  pane: Extract<PaneSpec, { kind: "version-browser" }>;
  onDismiss: () => void;
}> = memo(({ pane, onDismiss }) => (
  <Pane title={pane.title} onDismiss={onDismiss}>
    <PaneLabelRow label="workflow" value={pane.workflow_id} />
    <Box flexDirection="column" marginTop={1}>
      {pane.items.map((item) => (
        <Text key={`version-${item.version}`}>
          v{item.version} · {item.created_at}
          {item.note ? ` · ${item.note}` : ""}
        </Text>
      ))}
    </Box>
    <Box marginTop={1}>
      <Text dimColor>Use /restore &lt;version&gt; to restore a version.</Text>
    </Box>
  </Pane>
));
VersionBrowserPane.displayName = "VersionBrowserPane";

const ApprovalHistoryPane: React.FC<{
  pane: Extract<PaneSpec, { kind: "approval-history" }>;
  onDismiss: () => void;
}> = memo(({ pane, onDismiss }) => (
  <Pane title={pane.title} onDismiss={onDismiss}>
    {pane.items.map((item, i) => (
      <Box key={`approval-${i}`} flexDirection="column" marginBottom={1}>
        <Text
          color={
            item.status === "approved" ? "green" : item.status === "rejected" ? "red" : "yellow"
          }
          bold
        >
          {item.status} · {item.tool}
        </Text>
        <Text>{item.summary}</Text>
        <Text dimColor>{item.created_at}</Text>
      </Box>
    ))}
  </Pane>
));
ApprovalHistoryPane.displayName = "ApprovalHistoryPane";

const setupSectionOrder: Array<keyof SetupValidationResponse["sections"]> = [
  "auth",
  "llm",
  "datastore",
  "storage",
  "crypto",
  "public_urls",
];

function setupStatusColor(status: "ok" | "warn" | "blocked"): string {
  return status === "ok" ? "green" : status === "blocked" ? "red" : "yellow";
}

const SetupDiagnosticsPane: React.FC<{
  pane: Extract<PaneSpec, { kind: "setup-diagnostics" }>;
  onDismiss: () => void;
}> = memo(({ pane, onDismiss }) => (
  <Pane title={pane.title} subtitle={pane.setup.overall_status} onDismiss={onDismiss}>
    <PaneLabelRow label="blockers" value={String(pane.setup.summary_counts.blockers)} />
    <PaneLabelRow label="warnings" value={String(pane.setup.summary_counts.warnings)} />
    <Box flexDirection="column" marginTop={1}>
      {setupSectionOrder.map((sectionKey) => {
        const section = pane.setup.sections[sectionKey];
        return (
          <Box key={`setup-${sectionKey}`} flexDirection="column" marginBottom={1}>
            <Text color={setupStatusColor(section.status)} bold>
              {section.title} · {section.status}
            </Text>
            {section.issues.map((issue) => (
              <Text
                key={`setup-${sectionKey}-${issue.id}`}
                color={issue.severity === "blocker" ? "red" : "yellow"}
              >
                {issue.severity} · {issue.title} — {issue.detail}
              </Text>
            ))}
            {section.values.map((value) => (
              <PaneLabelRow
                key={`setup-${sectionKey}-value-${value.key}`}
                label={value.key}
                value={
                  value.value === null
                    ? value.status_hint
                      ? `— (${value.status_hint})`
                      : "—"
                    : value.status_hint
                      ? `${value.value} (${value.status_hint})`
                      : value.value
                }
                dim={value.value === null}
              />
            ))}
            {section.recommendations.map((recommendation, index) => (
              <Text key={`setup-${sectionKey}-fix-${index}`} color="cyan">
                fix · {recommendation}
              </Text>
            ))}
          </Box>
        );
      })}
    </Box>
  </Pane>
));
SetupDiagnosticsPane.displayName = "SetupDiagnosticsPane";

// ---------- Top-level App ----------

export const InkApp: React.FC<InkAppProps> = ({
  persona,
  statusLineConfig,
  initialConversationId,
  model,
  cwd,
  statusSnapshot,
  setupSnapshot,
  connectionSnapshot,
  permissionMode = "ask",
  historyPath,
  onPrompt,
  onSlash,
  onSelectConversation,
  onElicitResponse,
  onExit,
  resumeSummary,
}) => {
  const { exit } = useApp();
  const { stdout } = useStdout();
  const columns = stdout?.columns ?? DEFAULT_RULE_WIDTH;
  const [session, setSession] = useState<SkSessionState>(() =>
    initialSessionState(initialConversationId ?? null),
  );
  const deferredMessages = useDeferredValue(session.messages);
  const deferredToolCalls = useDeferredValue(session.toolCalls);

  const [input, setInput] = useState<InputBuffer>(EMPTY_BUFFER);
  const [busy, setBusy] = useState(false);
  // Slash-suggestion selection. Only meaningful when the buffer starts
  // with `/` and has no whitespace yet; ↑/↓ cycle the highlighted match,
  // Tab completes it, Enter on an empty-arg slash submits the selected
  // command. Reset on every buffer mutation so the index never points
  // past the live match list.
  const [slashSelectedIndex, setSlashSelectedIndex] = useState(0);
  // Synchronous guard against Enter auto-repeat. `setBusy(true)` is
  // async, so without this ref two Enter presses ~1ms apart both see
  // `busy === false` and each spawn a turn, posting the same prompt
  // twice (or 50 times if the key is held down).
  const busyRef = useRef(false);
  const [altScreen, setAltScreen] = useState(false);
  const [statusLine, setStatusLine] = useState<string>("");
  const [notices, setNotices] = useState<TranscriptNotice[]>([]);
  const [pane, setPane] = useState<PaneSpec | null>(null);
  const setupBannerShownRef = useRef(false);
  // Inline Ctrl-R history search (above-composer widget). The old
  // modal `<HistorySearch>` pane is still available via `historyOpen`
  // as a fallback for constrained terminals.
  const [historyOpen, setHistoryOpen] = useState(false);
  const [inlineSearchOpen, setInlineSearchOpen] = useState(false);
  // Permission mode — cycled by Shift-Tab. Seed from the prop so hosts
  // that persist a preference can drive it, but own the state locally
  // once the user interacts.
  const [activeMode, setActiveMode] = useState<PermissionMode>(permissionMode);
  const [transcriptMode, setTranscriptMode] = useState<TranscriptMode>("chat");
  const tip = useRef<string>(pickTip());
  const starterActions = useMemo(() => starterActionsForPersona(persona.label), [persona.label]);

  // -------- Persistent prompt history --------
  // Load ~/.sk/history.jsonl on mount so ↑/↓ works across sessions.
  // The ring is kept as a ref so rapid keypresses don't trigger
  // re-renders on every navigation.
  const historyRef = useRef<string[]>([]);
  const historyCursorRef = useRef<number>(0);
  // Draft preservation — when the user presses ↑ on a non-empty
  // buffer, stash the in-progress draft so ↓-past-zero restores it.
  const historyDraftRef = useRef<InputBuffer | null>(null);
  const effectiveHistoryPath = historyPath ?? defaultHistoryPath();
  useEffect(() => {
    try {
      const ring = loadPromptRing(effectiveHistoryPath, { tenant: persona.tenant });
      historyRef.current = ring;
      historyCursorRef.current = ring.length;
    } catch {
      // silent — missing / locked file shouldn't crash the REPL
    }
  }, [effectiveHistoryPath, persona.tenant]);

  // -------- Paste store + busy-turn command queue --------
  const pasteStoreRef = useRef<PasteStore>(createPasteStore());
  const queueRef = useRef(createQueue());
  const [queuedCount, setQueuedCount] = useState(0);
  const [pendingAttachments, setPendingAttachments] = useState<StoredPaste[]>([]);
  const syncPendingAttachments = useCallback(() => {
    setPendingAttachments([...pasteStoreRef.current.all()]);
  }, []);
  const pushNotice = useCallback((tone: NoticeTone, message: string, persistent = false) => {
    setNotices((current) => {
      const next: TranscriptNotice = {
        id: `${Date.now().toString(36)}-${Math.random().toString(36).slice(2, 8)}`,
        tone,
        message,
        persistent,
        ...(persistent ? {} : { expires_at: Date.now() + 4500 }),
      };
      return [next, ...current.filter((item) => item.message !== message)].slice(0, 4);
    });
  }, []);
  const dismissNotice = useCallback(() => {
    setNotices((current) => {
      const idx = current.findIndex((item) => item.persistent);
      if (idx < 0) return current;
      return current.filter((_item, itemIdx) => itemIdx !== idx);
    });
  }, []);
  const showInfo = useCallback(
    (message: string) => {
      pushNotice("info", message);
    },
    [pushNotice],
  );
  const showWarning = useCallback(
    (message: string, persistent = true) => {
      pushNotice("warning", message, persistent);
    },
    [pushNotice],
  );
  const showError = useCallback(
    (message: string) => {
      pushNotice("error", message, true);
    },
    [pushNotice],
  );

  useEffect(() => {
    const id = setInterval(() => {
      setNotices((current) => {
        const now = Date.now();
        return current.filter((item) => item.persistent || (item.expires_at ?? 0) > now);
      });
    }, 500);
    return () => clearInterval(id);
  }, []);

  useEffect(() => {
    if (setupBannerShownRef.current) return;
    const canShowSetup =
      persona.probe.allows("audit:read") || persona.probe.allows("identity:read");
    if (!canShowSetup) return;
    if (!setupSnapshot || setupSnapshot.overall_status === "ok") return;
    const blockers = setupSnapshot.summary_counts.blockers;
    const warnings = setupSnapshot.summary_counts.warnings;
    const blockerLabel = `${blockers} blocker${blockers === 1 ? "" : "s"}`;
    const warningLabel = `${warnings} warning${warnings === 1 ? "" : "s"}`;
    showWarning(
      `setup ${setupSnapshot.overall_status} · ${blockerLabel}, ${warningLabel} · /setup`,
    );
    setupBannerShownRef.current = true;
  }, [setupSnapshot, showWarning]);

  // -------- Status line ticker --------
  useEffect(() => {
    const refresh = resolveRefreshMs(statusLineConfig);
    let cancelled = false;
    const tick = async (): Promise<void> => {
      const cwdValue = cwd ?? process.cwd();
      const snapTenant = statusSnapshot?.tenant.slug ?? statusSnapshot?.tenant.id ?? null;
      const snapUser = statusSnapshot?.user.email ?? statusSnapshot?.user.id ?? null;
      const input: StatusLineInput = {
        schema_version: 1,
        profile: persona.profileName,
        persona: persona.label,
        user: snapUser,
        auth_status: statusSnapshot ? "signed_in" : "signed_out",
        tenant: snapTenant ?? persona.tenant,
        engine_url: persona.engineUrl,
        model: model ?? null,
        session_id: session.conversationId,
        turn_tokens: session.usage?.turn_tokens ?? null,
        remaining_monthly_budget_tokens:
          session.usage?.remaining_monthly_budget_tokens ??
          statusSnapshot?.remaining_monthly_budget_tokens ??
          null,
        tokens_today: statusSnapshot?.tokens_today ?? null,
        connectors_count: statusSnapshot?.connectors_count ?? null,
        status_message: null,
        permission_mode: activeMode,
        cwd: cwdValue,
        git_branch: null,
        timestamp: new Date().toISOString(),
        authoring_mode: resumeSummary?.stage ?? null,
        target_kind: resumeSummary?.active_target.kind ?? null,
        target_name: resumeSummary?.active_target.name ?? null,
        environment: resumeSummary?.active_target.environment ?? null,
        pending_approvals: session.pendingElicitation ? 1 : 0,
        latest_probe_state: latestToolOutcome(session.toolCalls, PROBE_TOOLS),
        latest_preview_state: latestToolOutcome(session.toolCalls, PREVIEW_TOOLS),
        connection_state: connectionSnapshot?.state ?? "unknown",
        connection_reason: connectionSnapshot?.reason ?? null,
      };
      const result = await buildStatusLine(statusLineConfig, input);
      if (!cancelled) setStatusLine(result.line);
    };
    void tick();
    const id = setInterval(() => {
      void tick();
    }, refresh);
    return () => {
      cancelled = true;
      clearInterval(id);
    };
  }, [
    statusLineConfig,
    persona.label,
    persona.tenant,
    persona.engineUrl,
    persona.profileName,
    model,
    session.conversationId,
    session.usage,
    cwd,
    statusSnapshot,
    connectionSnapshot,
    activeMode,
    resumeSummary,
  ]);

  // -------- Slash command handlers that live inside ink-app --------
  //
  // `/paste` — read the system clipboard, classify as text / image,
  // push into the paste store, insert the ref at the cursor.
  // `/attach <path>` — read a file path, classify by extension, add
  // to paste store, insert ref at cursor.
  // `/queue` — print queued prompts into the transient banner.
  // `/history` — show / clear the persistent history file.
  //
  // Other slash commands fall through to the host's `onSlash`.
  const handleBuiltinSlash = useCallback(
    async (trimmed: string): Promise<boolean> => {
      const [head, ...rest] = trimmed.split(/\s+/);
      const name = (head ?? "").replace(/^\//, "");
      const mutatePending = (source: "paste" | "attach"): boolean => {
        const sub = (rest[0] ?? "").toLowerCase();
        if (sub !== "clear" && sub !== "remove" && sub !== "rm") return false;
        if (sub === "clear") {
          const count = pasteStoreRef.current.all().length;
          pasteStoreRef.current.clear();
          syncPendingAttachments();
          showInfo(`/${source}: cleared ${count} pending item(s)`);
          return true;
        }
        const rawId = rest[1];
        const id = Number.parseInt(rawId ?? "", 10);
        if (!Number.isFinite(id)) {
          showError(`/${source}: usage \`/${source} remove <id>\``);
          return true;
        }
        if (!pasteStoreRef.current.get(id)) {
          showError(`/${source}: no pending item #${id}`);
          return true;
        }
        pasteStoreRef.current.delete(id);
        syncPendingAttachments();
        showInfo(`/${source}: removed #${id}`);
        return true;
      };
      if (name === "paste") {
        if (mutatePending("paste")) return true;
        const clip = readClipboard();
        if (clip.kind === "none") {
          showInfo("/paste: clipboard is empty");
          return true;
        }
        if (clip.kind === "text") {
          const { ref, lines } = pasteStoreRef.current.addText(clip.text);
          syncPendingAttachments();
          setInput((prev) => applyInput(prev, { type: "insert", text: ref }));
          showInfo(`/paste: inserted ${ref} (${lines + 1} line${lines === 0 ? "" : "s"})`);
          return true;
        }
        const img = pasteStoreRef.current.addImage({
          path: clip.path,
          mediaType: clip.mediaType,
          bytes: clip.bytes,
        });
        syncPendingAttachments();
        setInput((prev) => applyInput(prev, { type: "insert", text: img.ref }));
        showInfo(`/paste: inserted ${img.ref} (${clip.bytes} bytes)`);
        return true;
      }
      if (name === "attach" || name === "file") {
        if (mutatePending("attach")) return true;
        const raw = rest.join(" ").trim();
        if (raw.length === 0) {
          showError("/attach: needs a path — e.g. `/attach ./invoice.pdf`");
          return true;
        }
        const { statSync, existsSync: exists } = await import("node:fs");
        const { resolve: res, basename: base } = await import("node:path");
        const abs = res(cwd ?? process.cwd(), raw);
        if (!exists(abs)) {
          showError(`/attach: not found: ${raw}`);
          return true;
        }
        const st = statSync(abs);
        if (!st.isFile()) {
          showError(`/attach: not a file: ${raw}`);
          return true;
        }
        const cls = classifyAttachment(abs);
        if (cls.kind === "image") {
          const added = pasteStoreRef.current.addImage({
            path: abs,
            mediaType: cls.mediaType,
            bytes: st.size,
          });
          syncPendingAttachments();
          setInput((prev) => applyInput(prev, { type: "insert", text: added.ref }));
          showInfo(`/attach: inserted ${added.ref} (${cls.mediaType}, ${st.size} bytes)`);
          return true;
        }
        const added = pasteStoreRef.current.addFile({
          path: abs,
          filename: base(abs),
          bytes: st.size,
        });
        syncPendingAttachments();
        setInput((prev) => applyInput(prev, { type: "insert", text: added.ref }));
        showInfo(`/attach: inserted ${added.ref} (${cls.mediaType}, ${st.size} bytes)`);
        return true;
      }
      if (name === "queue") {
        const items = [...queueRef.current.items];
        if (items.length === 0) showInfo("/queue: empty");
        else showInfo(`/queue: ${items.length} pending — ${items.slice(0, 3).join(" ; ")}`);
        return true;
      }
      if (name === "history") {
        const sub = rest[0];
        if (sub === "clear") {
          const { clearHistory } = await import("./repl/history-store.ts");
          clearHistory(effectiveHistoryPath);
          historyRef.current = [];
          historyCursorRef.current = 0;
          showInfo("/history: cleared");
          return true;
        }
        showInfo(
          `/history: ${historyRef.current.length} prompt(s) stored at ${effectiveHistoryPath}`,
        );
        return true;
      }
      if (name === "view") {
        const sub = (rest[0] ?? "").toLowerCase();
        if (!sub) {
          showInfo(`/view: ${transcriptMode}`);
          return true;
        }
        if (sub !== "chat" && sub !== "inspect") {
          showError("/view: use `/view chat` or `/view inspect`");
          return true;
        }
        setTranscriptMode(sub);
        showInfo(`/view: ${sub}`);
        return true;
      }
      return false;
    },
    [cwd, effectiveHistoryPath, showError, showInfo, syncPendingAttachments, transcriptMode],
  );

  const applyEventStream = useCallback(
    async (
      base: SkSessionState,
      events: AsyncIterable<TurnEvent> | undefined,
      conversationId?: string | null,
    ): Promise<void> => {
      if (!events) return;
      let next: SkSessionState = {
        ...base,
        ...(conversationId !== undefined ? { conversationId } : {}),
      };
      setSession(next);
      for await (const ev of events) {
        next = applyTurnEvent(next, ev);
        setSession({ ...next });
      }
    },
    [],
  );

  async function submitElicitationResponse(
    elicitationId: string,
    output: unknown,
    reason?: string,
  ): Promise<void> {
    if (!onElicitResponse) return;
    busyRef.current = true;
    setBusy(true);
    try {
      // Synthesize a user-role message capturing what the operator
      // just chose so the transcript doesn't look like the LLM
      // produced the answer out of thin air. Without this, an
      // approve-then-next-turn flow shows the LLM saying "Approve"
      // with no visible source. See bug E in the fix plan.
      const answerText = renderElicitAnswer(output, reason);
      const withAnswer: SkSessionState = {
        ...session,
        messages: [...session.messages, { role: "user", content: answerText }],
        pendingElicitation: null,
        status: "running",
      };
      setSession(withAnswer);
      const outcome = await onElicitResponse(elicitationId, output, reason);
      await applyEventStream(
        withAnswer,
        outcome?.events,
        outcome?.conversationId ?? session.conversationId,
      );
    } catch (err) {
      showError(humanizeRequestError(err));
    } finally {
      busyRef.current = false;
      setBusy(false);
      const nextQueued = queueRef.current.dequeue();
      setQueuedCount(queueRef.current.length);
      if (nextQueued) {
        setTimeout(() => {
          void handleSubmit(nextQueued);
        }, 0);
      }
    }
  }

  // -------- Input handling (printable chars, enter, backspace, Ctrl-C, Ctrl-T) --------
  const handleSubmit = useCallback(
    async (raw: string): Promise<void> => {
      const trimmed = raw.trim();
      setInput(EMPTY_BUFFER);
      historyDraftRef.current = null;
      if (!trimmed) return;
      if (trimmed === "/exit" || trimmed === "/quit") {
        exit();
        onExit?.();
        return;
      }
      if (trimmed.startsWith("/")) {
        // Built-in slash commands that ink-app owns (paste, attach,
        // queue, history). Short-circuit so the host's `onSlash`
        // doesn't see them.
        if (await handleBuiltinSlash(trimmed)) return;
        const cmd = findSlashCommand(trimmed.split(/\s+/)[0] ?? "");
        if (!cmd) {
          showError(`unknown slash: ${trimmed}`);
          return;
        }
        if (cmd.requires && !persona.probe.allows(cmd.requires)) {
          showError(`sk: /${cmd.name} requires ${cmd.requires} (not granted)`);
          return;
        }
        if (cmd.name === "help") {
          const helpLines = renderHelp(persona.probe).split("\n");
          const [title = "slash commands", ...body] = helpLines;
          setPane({
            kind: "text",
            title: title.trim(),
            subtitle: persona.label,
            lines: body,
          });
          return;
        }
        if (cmd.name === "approve" || cmd.name === "reject") {
          if (!session.pendingElicitation || !onElicitResponse) {
            showError("no pending elicitation");
            return;
          }
          const parts = trimmed.split(/\s+/).slice(1);
          const UUID_RE = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i;
          let elicitationId: string;
          let reasonTokens: string[];
          if (parts[0] && UUID_RE.test(parts[0])) {
            elicitationId = parts[0];
            reasonTokens = parts.slice(1);
          } else {
            elicitationId = session.pendingElicitation.id;
            reasonTokens = parts;
          }
          const confirmed = cmd.name === "approve";
          const reason = !confirmed && reasonTokens.length > 0 ? reasonTokens.join(" ") : undefined;
          await submitElicitationResponse(elicitationId, { confirmed }, reason);
          return;
        }
        if (onSlash) {
          try {
            const response = await onSlash(cmd.name, trimmed, setPane, session);
            if (response) showInfo(response);
          } catch (err) {
            // Without this guard a thrown slash handler vanished — no
            // notice, no log entry. Surface it as a user-visible error
            // and a debug record so operators can grep the trace id.
            debugLog(
              "dialog.error",
              {
                stage: "slash_handler",
                cmd: cmd.name,
                error: serializeDebugError(err),
              },
              {},
            );
            showError(`/${cmd.name}: ${humanizeRequestError(err)}`);
          }
        }
        return;
      }

      // Plain prompt → drive a turn. Busy-guard first: if a turn is
      // already in flight, enqueue the prompt and let the draining
      // loop pick it up after the current turn completes.
      if (busyRef.current) {
        queueRef.current.enqueue(trimmed);
        setQueuedCount(queueRef.current.length);
        showInfo(`queued (${queueRef.current.length}) — runs after the current turn`);
        return;
      }
      busyRef.current = true;
      setBusy(true);

      // Expand paste-store refs back inline, fan out image / file
      // refs as `@path` mentions so the existing mention resolver
      // can attach their contents.
      const {
        prompt: expanded,
        attachmentPaths,
        consumedIds,
      } = expandRefs(trimmed, pasteStoreRef.current);
      const finalPrompt =
        attachmentPaths.length > 0
          ? `${expanded}${attachmentPaths.map((p) => ` @${p}`).join("")}`
          : expanded;

      // Record in the in-memory ring + persist (subkit-tenant scoped).
      historyRef.current.push(trimmed);
      historyCursorRef.current = historyRef.current.length;
      try {
        appendHistory(trimmed, { path: effectiveHistoryPath, tenant: persona.tenant ?? null });
      } catch {
        // best-effort
      }
      // Free consumed paste items after a successful submit.
      for (const id of consumedIds) pasteStoreRef.current.delete(id);
      syncPendingAttachments();

      try {
        setNotices((current) => current.filter((item) => item.tone !== "error"));
        const { events, conversationId } = await onPrompt(finalPrompt, {
          permission_mode: activeMode,
        });
        await applyEventStream({ ...session, conversationId }, events, conversationId);
      } catch (err) {
        showError(humanizeRequestError(err));
      } finally {
        busyRef.current = false;
        setBusy(false);
        // Drain the queue — one prompt at a time.
        const nextQueued = queueRef.current.dequeue();
        setQueuedCount(queueRef.current.length);
        if (nextQueued) {
          // Defer to let React flush the `busy=false` frame before
          // we start the next turn.
          setTimeout(() => {
            void handleSubmit(nextQueued);
          }, 0);
        }
      }
    },
    [
      activeMode,
      exit,
      onElicitResponse,
      onExit,
      onPrompt,
      onSlash,
      persona.probe,
      persona.tenant,
      session,
      applyEventStream,
      handleBuiltinSlash,
      showError,
      showInfo,
      submitElicitationResponse,
      syncPendingAttachments,
    ],
  );

  // Gate the main composer input while an elicit prompt is open or a
  // modal pane is capturing keys. Without this, each keystroke fires
  // multiple useInput listeners (composer + pane + elicit children)
  // and the user sees the same characters echoed into two places.
  //
  // Exception: the composer stays ACTIVE during an open elicitation
  // as long as the buffered input starts with `/`, so the user can
  // still type `/approve` or `/reject <reason>` and have it dispatch
  // through the slash handler instead of being swallowed by the
  // ConfirmPrompt's digit-shortcuts. Other keys (printable chars that
  // would grow a non-slash prompt) are gated off so the elicit's own
  // keybindings stay authoritative.
  const elicitOpen = session.pendingElicitation !== null;
  const composerActive = pane === null && !historyOpen && !inlineSearchOpen;
  const slashMode = input.value.startsWith("/");
  // Slash autocomplete is "navigable" only while the user is still
  // typing the command name (no space yet). Once they add an arg
  // (`/profile prod`), arrow keys go back to history and Tab is inert.
  const slashNavigable = slashMode && !/\s/.test(input.value);
  const slashMatches = useMemo(
    () => (slashNavigable ? searchSlashCommands(input.value, persona.probe, 5) : []),
    [slashNavigable, input.value, persona.probe],
  );
  // Clamp the highlighted index whenever the match list shrinks.
  useEffect(() => {
    if (slashMatches.length === 0) {
      if (slashSelectedIndex !== 0) setSlashSelectedIndex(0);
      return;
    }
    if (slashSelectedIndex >= slashMatches.length) {
      setSlashSelectedIndex(slashMatches.length - 1);
    }
  }, [slashMatches.length, slashSelectedIndex]);
  // In-progress @mention — drives the inline mention picker.
  const mentionSpec = useMemo(
    () => (composerActive ? extractMention(input.value, input.cursor) : null),
    [composerActive, input.value, input.cursor],
  );
  const showWelcomeActions =
    session.messages.length === 0 && input.value.length === 0 && pane === null;
  useInput(
    (char, key) => {
      // --- Global shortcuts (active even under modal / busy) ----------
      if (key.ctrl && char === "t") {
        setAltScreen((prev) => !prev);
        return;
      }
      if (key.ctrl && char === "o") {
        setTranscriptMode((mode) => {
          const next = mode === "chat" ? "inspect" : "chat";
          showInfo(`/view: ${next}`);
          return next;
        });
        return;
      }
      if (key.shift && key.tab) {
        setActiveMode((m) => {
          const next = m === "ask" ? "auto" : m === "auto" ? "plan" : "ask";
          showInfo(`/mode: ${next}`);
          return next;
        });
        return;
      }
      // Ctrl-R opens inline history-search (Claude-Code-style
      // above-composer widget). The modal pane is still reachable
      // via `/resume` for users who prefer it.
      if (key.ctrl && char === "r") {
        if (historyRef.current.length > 0) setInlineSearchOpen(true);
        return;
      }
      // Ctrl-L clears the terminal scroll buffer. Route through Ink's
      // own stdout handle so the ANSI escape interleaves with the
      // render tree instead of fighting it.
      if (key.ctrl && char === "l") {
        stdout?.write("\x1b[2J\x1b[H");
        return;
      }
      if (
        key.escape &&
        notices.some((item) => item.persistent) &&
        pane === null &&
        !inlineSearchOpen
      ) {
        dismissNotice();
        return;
      }
      if (busyRef.current) {
        // While busy, still accept keystrokes into the buffer so the
        // user can type ahead. Enter enqueues instead of spawning a
        // concurrent turn (see handleSubmit).
      }
      // Elicitation is open: only accept input that is part of a
      // slash command so the user can still /approve or /reject.
      if (elicitOpen && !slashMode && char !== "/") return;
      if (showWelcomeActions && char && !key.ctrl && !key.meta) {
        if (char === starterActions[0]?.key) {
          void handleSubmit("/resume");
          return;
        }
        if (char === starterActions[1]?.key) {
          setInput(buffer(CONNECTOR_STARTER_PROMPT));
          return;
        }
        if (char === starterActions[2]?.key) {
          setInput(buffer(WORKFLOW_STARTER_PROMPT));
          return;
        }
        if (char === starterActions[3]?.key) {
          setInput(buffer(MANAGE_STARTER_PROMPT));
          return;
        }
        if (char === starterActions[4]?.key) {
          setInput(buffer(SURFACE_HELP_STARTER_PROMPT));
          return;
        }
      }

      // --- Slash-suggestion navigation (precedes history) ------------
      // Only intercept arrows while the user is still typing the
      // command name (no whitespace) and the match list is non-empty.
      // Otherwise ↑/↓ fall through to history navigation below.
      if (slashNavigable && slashMatches.length > 0) {
        if (key.upArrow) {
          setSlashSelectedIndex((i) => (i <= 0 ? slashMatches.length - 1 : i - 1));
          return;
        }
        if (key.downArrow) {
          setSlashSelectedIndex((i) => (i + 1) % slashMatches.length);
          return;
        }
        if (key.tab) {
          const picked = slashMatches[slashSelectedIndex] ?? slashMatches[0];
          if (picked) {
            const next = `/${picked.name} `;
            setInput(buffer(next));
          }
          return;
        }
      }

      // --- History navigation via arrow keys -------------------------
      if (key.upArrow) {
        // Mention picker wraps Up/Down itself; if a mention is open
        // and the picker captured nothing, fall through to history
        // only when the buffer is on the first row.
        if (mentionSpec) return;
        const pos = cursorPosition(input);
        if (pos.row > 0) {
          // Move up one row within the buffer instead of cycling history.
          const targetOffset = Math.max(0, input.cursor - pos.column - 1);
          setInput(applyInput(input, { type: "set", value: input.value, cursor: targetOffset }));
          return;
        }
        if (historyRef.current.length === 0) return;
        if (historyCursorRef.current === historyRef.current.length && input.value.length > 0) {
          historyDraftRef.current = input;
        }
        const next = Math.max(0, historyCursorRef.current - 1);
        historyCursorRef.current = next;
        const entry = historyRef.current[next] ?? "";
        setInput(buffer(entry));
        return;
      }
      if (key.downArrow) {
        if (mentionSpec) return;
        const pos = cursorPosition(input);
        const totalRows = splitLines(input.value).length;
        if (pos.row < totalRows - 1) {
          const thisEnd = lineEnd(input.value, input.cursor);
          const nextStart = thisEnd + 1;
          const nextEnd = lineEnd(input.value, nextStart);
          const targetOffset = Math.min(
            nextEnd,
            nextStart + (input.cursor - lineStart(input.value, input.cursor)),
          );
          setInput(applyInput(input, { type: "set", value: input.value, cursor: targetOffset }));
          return;
        }
        if (historyRef.current.length === 0) return;
        const next = Math.min(historyRef.current.length, historyCursorRef.current + 1);
        historyCursorRef.current = next;
        if (next === historyRef.current.length) {
          // Past the newest entry — restore the stashed draft (if any)
          // or land on an empty buffer.
          setInput(historyDraftRef.current ?? EMPTY_BUFFER);
          historyDraftRef.current = null;
        } else {
          setInput(buffer(historyRef.current[next] ?? ""));
        }
        return;
      }

      // --- Cursor navigation -----------------------------------------
      if (key.leftArrow) {
        if (key.meta || key.ctrl) {
          setInput((prev) => applyInput(prev, { type: "moveWordLeft" }));
        } else {
          setInput((prev) => applyInput(prev, { type: "moveLeft" }));
        }
        return;
      }
      if (key.rightArrow) {
        if (key.meta || key.ctrl) {
          setInput((prev) => applyInput(prev, { type: "moveWordRight" }));
        } else {
          setInput((prev) => applyInput(prev, { type: "moveRight" }));
        }
        return;
      }
      // Home / End
      if (key.ctrl && char === "a") {
        setInput((prev) => applyInput(prev, { type: "moveLineStart" }));
        return;
      }
      if (key.ctrl && char === "e") {
        setInput((prev) => applyInput(prev, { type: "moveLineEnd" }));
        return;
      }
      // Readline-style kill bindings
      if (key.ctrl && char === "u") {
        setInput((prev) => applyInput(prev, { type: "killLine" }));
        return;
      }
      if (key.ctrl && char === "k") {
        setInput((prev) => applyInput(prev, { type: "killToEnd" }));
        return;
      }
      if (key.ctrl && char === "w") {
        setInput((prev) => applyInput(prev, { type: "killPrevWord" }));
        return;
      }
      // Alt / Meta Backspace — also "kill previous word" (terminal may
      // send `\x1b` + DEL or similar; Ink normalizes it to meta + delete).
      if (key.meta && (key.backspace || key.delete)) {
        setInput((prev) => applyInput(prev, { type: "killPrevWord" }));
        return;
      }
      // Alt+D — kill next word (emacs / bash convention)
      if (key.meta && char === "d") {
        setInput((prev) => applyInput(prev, { type: "killNextWord" }));
        return;
      }

      // --- Newline vs submit ----------------------------------------
      // Ctrl-J (line feed) inserts a newline — the tmux / emacs
      // convention. Plain Enter (carriage return) submits the buffer.
      if (key.ctrl && char === "j") {
        setInput((prev) => applyInput(prev, { type: "newline" }));
        return;
      }
      if (key.return) {
        // Slash autocomplete: when the user is still typing the
        // command name and a suggestion is highlighted, Enter submits
        // the highlighted command instead of whatever exact prefix the
        // buffer holds. Saves a Tab keystroke for the common case.
        if (slashNavigable && slashMatches.length > 0) {
          const picked = slashMatches[slashSelectedIndex] ?? slashMatches[0];
          if (picked) {
            void handleSubmit(`/${picked.name}`);
            return;
          }
        }
        void handleSubmit(input.value);
        return;
      }

      // --- Backspace / delete ---------------------------------------
      if (key.backspace) {
        setInput((prev) => applyInput(prev, { type: "deletePrev" }));
        return;
      }
      if (key.delete) {
        setInput((prev) => applyInput(prev, { type: "deleteNext" }));
        return;
      }

      // --- Printable char(s) / paste heuristic ----------------------
      if (char && char.length > 0 && !key.ctrl && !key.meta) {
        // Bracketed paste: the terminal frames pastes with
        // ESC[200~…ESC[201~. Strip both markers and treat whatever was
        // between them as a paste, regardless of length. Stops
        // multi-line pastes from being fragmented into per-char key
        // events.
        const BP_START = "\x1b[200~";
        const BP_END = "\x1b[201~";
        const startIdx = char.indexOf(BP_START);
        const endIdx = char.lastIndexOf(BP_END);
        if (startIdx !== -1 && endIdx !== -1 && endIdx > startIdx) {
          const pasted = char.slice(startIdx + BP_START.length, endIdx);
          const prefix = char.slice(0, startIdx);
          const suffix = char.slice(endIdx + BP_END.length);
          if (prefix) setInput((prev) => applyInput(prev, { type: "insert", text: prefix }));
          if (pasted) {
            const { ref } = pasteStoreRef.current.addText(pasted);
            syncPendingAttachments();
            setInput((prev) => applyInput(prev, { type: "insert", text: ref }));
            showInfo(`pasted ${ref} — sent inline at submit`);
          }
          if (suffix) setInput((prev) => applyInput(prev, { type: "insert", text: suffix }));
          return;
        }
        if (char.length > 1 && looksLikePaste(char)) {
          // Short single-line pastes (typical "copy a name / id"
          // workflow) are inlined verbatim — no attachment, no
          // `[Pasted text #N]` ref. The attachment indirection only
          // earns its keep when the paste is multi-line OR very long;
          // forcing it on a 6-character word produced the confusing
          // `[2] text · 1 line · siemens-stock-price` dialog over the
          // composer in session 64db7189.
          const newlineCount = (char.match(/\n/g) ?? []).length;
          const inlineThreshold = 200; // ~one terminal row
          if (newlineCount === 0 && char.length <= inlineThreshold) {
            setInput((prev) => applyInput(prev, { type: "insert", text: char }));
            return;
          }
          // Big chunk — stash in the paste store, insert the ref
          // inline. Keeps the buffer compact and cursor math sane.
          const { ref } = pasteStoreRef.current.addText(char);
          syncPendingAttachments();
          setInput((prev) => applyInput(prev, { type: "insert", text: ref }));
          showInfo(`pasted ${ref} — sent inline at submit`);
          return;
        }
        setInput((prev) => applyInput(prev, { type: "insert", text: char }));
      }
    },
    { isActive: composerActive },
  );

  // Banner once on mount so we don't cover the terminal prompt on
  // exit; clear it after the first prompt submission so the message
  // list gets the vertical space back.
  const showBanner = session.messages.length === 0;

  // Build transcript rows split across two buckets so Ink can render
  // the committed scrollback through <Static> (written once to stdout,
  // survives re-renders, keeps OS-level mouse selection working) and
  // the currently-running turn through the normal dynamic tree.
  //
  // Static commit point: a message is "finalized" the moment it lands
  // in session.messages — applyTurnEvent only pushes there at the end
  // of a message. Tool calls with status "ok"/"failed"/"declined" are
  // likewise finalized. Anything still running (streaming assistant
  // text, in-flight tool cards, pending elicit) stays dynamic.
  //
  // Tool calls, logs, and pending elicit forms are interleaved under
  // their parent assistant message via `parent_message_id`. Children
  // without an anchor (legacy data, or live events that arrived
  // pre-anchor) render in a trailing block at the end so nothing gets
  // dropped. This is the fix for the chronological-display bug — see
  // the plan at .claude/plans/find-issues-in-display-tranquil-harp.md.
  const staticRows: React.ReactNode[] = [];
  const dynamicRows: React.ReactNode[] = [];
  // Alias used by render helpers below — they push into whichever
  // array is currently "active". Starts with static; we switch to
  // dynamic once a not-yet-finalized node appears.
  let transcriptRows = staticRows;
  const inspectView = transcriptMode === "inspect";
  // A tool call has reached a terminal status and can live in Static.
  // (Pending/running calls stay dynamic so their spinner keeps updating
  // without tearing the scrollback above.)
  const isToolCallFinalized = (call: ToolCallState): boolean =>
    call.status === "done" || call.status === "failed";

  // Bucket tool calls by parent_message_id. Order within each bucket
  // is preserved from `deferredToolCalls` (which the reducer appends
  // in arrival order = chronological).
  const callsByParent = new Map<string, ToolCallState[]>();
  const orphanCalls: ToolCallState[] = [];
  const knownMessageIds = new Set<string>();
  for (const m of deferredMessages) if (m?.id) knownMessageIds.add(m.id);
  for (const call of deferredToolCalls) {
    const anchor = call.parent_message_id;
    if (anchor && knownMessageIds.has(anchor)) {
      const list = callsByParent.get(anchor) ?? [];
      list.push(call);
      callsByParent.set(anchor, list);
    } else {
      orphanCalls.push(call);
    }
  }

  const pushForegroundLogs = (callId: string): void => {
    const logs = session.toolLogs.filter((log) => log.call_id === callId);
    if (logs.length === 0) return;
    transcriptRows.push(
      <Box key={`tl-${callId}`} flexDirection="column" marginLeft={2}>
        {logs.map((log, idx) => (
          <Text key={`${callId}-${idx}`} color="gray">
            · [{log.level}] {log.message}
          </Text>
        ))}
      </Box>,
    );
  };
  const flushBackgroundGroup = (calls: ToolCallState[], keySuffix: string): void => {
    if (calls.length === 0) return;
    const ids = new Set(calls.map((call) => call.id));
    const logs = session.toolLogs.filter((log) => ids.has(log.call_id));
    transcriptRows.push(
      <BackgroundToolGroup
        key={`bg-${keySuffix}-${calls.map((call) => call.id).join("-")}`}
        calls={calls}
        logs={logs}
        detailed={inspectView}
      />,
    );
  };
  /**
   * Render a list of tool calls (already in chronological order)
   * into transcriptRows. Groups consecutive background tools into a
   * compact pill, drops the rest through the authoring-card / ToolCard
   * branches. Mirrors the old single-block logic but is callable
   * per-message-row so children land directly under their parent.
   */
  const renderToolCallList = (calls: ToolCallState[], keyPrefix: string): void => {
    let pendingBackgroundCalls: ToolCallState[] = [];
    let bgIdx = 0;
    for (const call of calls) {
      if (isBackgroundTool(call)) {
        if (!inspectView) continue;
        pendingBackgroundCalls.push(call);
        continue;
      }
      if (pendingBackgroundCalls.length > 0) {
        flushBackgroundGroup(pendingBackgroundCalls, `${keyPrefix}-${bgIdx++}`);
        pendingBackgroundCalls = [];
      }
      const authoringCard = inspectView ? null : renderAuthoringCard(call, transcriptMode);
      if (authoringCard) {
        transcriptRows.push(authoringCard);
        if (inspectView || call.status === "failed") pushForegroundLogs(call.id);
        continue;
      }
      if (inspectView || call.status === "failed") {
        transcriptRows.push(
          <ToolCard key={`tc-${call.id}`} call={call} columns={columns} detailed={inspectView} />,
        );
        pushForegroundLogs(call.id);
      }
    }
    if (inspectView && pendingBackgroundCalls.length > 0) {
      flushBackgroundGroup(pendingBackgroundCalls, `${keyPrefix}-${bgIdx++}`);
    }
  };

  // Pending elicitation gets inlined under its parent message when
  // anchored. Falls back to a bottom-of-screen render below the
  // ScrollView when no anchor is available (legacy data, or events
  // that arrived before the assistant message was persisted).
  const pendingElicit = session.pendingElicitation;
  const elicitAnchor =
    pendingElicit?.parent_message_id && knownMessageIds.has(pendingElicit.parent_message_id)
      ? pendingElicit.parent_message_id
      : null;
  const renderElicitInline = (): void => {
    if (!pendingElicit) return;
    transcriptRows.push(
      <ElicitRouter
        key={`elicit-${pendingElicit.id}`}
        elicitation={pendingElicit}
        inputDisabled={pane !== null || slashMode}
        onResponse={(out) => {
          const resp = out as ElicitationResponse;
          const reason =
            "decision_reason" in resp && typeof resp.decision_reason === "string"
              ? resp.decision_reason
              : undefined;
          void submitElicitationResponse(pendingElicit.id, resp, reason);
        }}
      />,
    );
  };

  for (let i = 0; i < deferredMessages.length; i++) {
    const m = deferredMessages[i];
    if (!m) continue;
    transcriptRows.push(
      <MessageRow key={`msg-${i}`} role={m.role} content={m.content} parts={m.parts} />,
    );
    if (m.id) {
      const childCalls = callsByParent.get(m.id);
      if (childCalls && childCalls.length > 0) {
        // Split children: finalized → static (alongside this message),
        // still-running → dynamic (appended below so the spinner
        // keeps animating without re-rendering the scrollback).
        const finalized = childCalls.filter(isToolCallFinalized);
        const active = childCalls.filter((c) => !isToolCallFinalized(c));
        if (finalized.length > 0) renderToolCallList(finalized, `m${i}`);
        if (active.length > 0) {
          transcriptRows = dynamicRows;
          renderToolCallList(active, `m${i}-active`);
          transcriptRows = staticRows;
        }
      }
      if (elicitAnchor === m.id) {
        // Pending elicit is by definition unresolved → dynamic.
        transcriptRows = dynamicRows;
        renderElicitInline();
        transcriptRows = staticRows;
      }
    }
  }
  // Live streaming assistant buffer — rendered in the dynamic bucket
  // until the next `message` frame arrives and clears it. Keeps the
  // REPL responsive as tokens arrive rather than waiting for the turn
  // to end, while the finished scrollback above stays in Static.
  if (session.streamingAssistantText.length > 0) {
    dynamicRows.push(
      <MessageRow
        key="live-delta"
        role={"assistant" as const}
        content={session.streamingAssistantText}
      />,
    );
  }
  // Orphaned tool calls (no parent_message_id, or anchor not in
  // current messages array). Rendered as a trailing block so nothing
  // is silently dropped — happens for legacy conversations from before
  // engine migration 0032. Split static / dynamic by status like the
  // anchored path above.
  if (orphanCalls.length > 0) {
    const finalized = orphanCalls.filter(isToolCallFinalized);
    const active = orphanCalls.filter((c) => !isToolCallFinalized(c));
    if (finalized.length > 0) renderToolCallList(finalized, "orphan");
    if (active.length > 0) {
      transcriptRows = dynamicRows;
      renderToolCallList(active, "orphan-active");
      transcriptRows = staticRows;
    }
  }

  // Welcome banner + starter actions + resume card are pushed ONCE into
  // the Static stream as the first scrollback rows. Ink's <Static> flushes
  // them to stdout and never re-invokes them; as the transcript grows they
  // scroll up out of the terminal naturally. Rendering them in the live
  // region (the previous behaviour) made the compact-mode chip float
  // between the scrolled-out transcript and the composer once the
  // committed history exceeded one screenful — the cause of the "banner
  // sitzt falsch" reflow visible in long sessions.
  const welcomeRow = (
    <Box key="welcome" flexDirection="column">
      <WelcomeBanner
        persona={persona.label}
        tenant={persona.tenant}
        engineUrl={persona.engineUrl}
        profileName={persona.profileName}
        sessionId={session.conversationId}
        mode={activeMode}
        transcriptMode={transcriptMode}
        connectionState={connectionSnapshot?.state ?? "unknown"}
        connectionReason={connectionSnapshot?.reason ?? null}
        targetKind={resumeSummary?.active_target.kind ?? null}
        targetName={resumeSummary?.active_target.name ?? null}
        environment={resumeSummary?.active_target.environment ?? null}
        tip={tip.current}
      />
      {starterActions.length > 0 ? <StarterActions actions={starterActions} /> : null}
      {resumeSummary ? (
        <ResumeSummaryCard
          active_target={resumeSummary.active_target}
          stage={resumeSummary.stage}
          next_action={resumeSummary.next_action}
          one_sentence={resumeSummary.one_sentence}
          last_successful_probe={resumeSummary.last_successful_probe}
          last_successful_preview={resumeSummary.last_successful_preview}
        />
      ) : null}
    </Box>
  );
  staticRows.unshift(welcomeRow);
  // Suppress the unused-var warning while the legacy guard is still
  // referenced below (e.g. starter-actions visibility tests).
  void showBanner;
  void showWelcomeActions;

  const content = (
    <Box flexDirection="column">
      <NoticeStack items={notices} />

      {/* Committed scrollback — written once to stdout via Ink Static.
          Survives re-renders, so terminal mouse-selection and copy
          keep working while the live area below keeps ticking. The
          Static bucket holds all finalized messages + tool calls; the
          current-turn dynamic bucket renders separately underneath. */}
      {staticRows.length > 0 ? <Static items={staticRows}>{(row) => row}</Static> : null}
      {/* Live/dynamic transcript — streaming assistant text, running
          tool cards, pending elicit boxes. Kept inside ScrollView so
          long in-flight turns still get windowed. */}
      {dynamicRows.length > 0 ? (
        <ScrollView active={composerActive && pane === null}>{dynamicRows}</ScrollView>
      ) : null}

      {/* Elicit router — bottom-of-screen fallback for elicitations
          that arrived without a `parent_message_id` (legacy data, or
          live events that landed before the parent assistant message
          was persisted). Anchored elicitations render inline inside
          the transcript above, under their parent message — see
          `renderElicitInline` in the transcript loop. */}
      {session.pendingElicitation && elicitAnchor === null ? (
        <ElicitRouter
          elicitation={session.pendingElicitation}
          inputDisabled={pane !== null || slashMode}
          onResponse={(out) => {
            const resp = out as ElicitationResponse;
            const reason =
              "decision_reason" in resp && typeof resp.decision_reason === "string"
                ? resp.decision_reason
                : undefined;
            void submitElicitationResponse(session.pendingElicitation!.id, resp, reason);
          }}
        />
      ) : null}

      {/* Modal slot — one pane at a time (/status, /resume browser, …) */}
      {pane?.kind === "status" ? (
        <StatusPane
          title={pane.title ?? "status"}
          {...(pane.subtitle !== undefined ? { subtitle: pane.subtitle } : {})}
          rows={pane.rows}
          onDismiss={() => setPane(null)}
        />
      ) : null}
      {pane?.kind === "conversations" ? (
        <ConversationBrowser
          items={pane.items}
          onSelect={(id) => {
            setPane(null);
            void onSelectConversation?.(id);
          }}
          onDismiss={() => setPane(null)}
        />
      ) : null}
      {pane?.kind === "template-picker" ? (
        <TemplatePickerPane pane={pane} onDismiss={() => setPane(null)} />
      ) : null}
      {pane?.kind === "connector-draft" ? (
        <ConnectorDraftPane pane={pane} onDismiss={() => setPane(null)} />
      ) : null}
      {pane?.kind === "workflow-draft" ? (
        <WorkflowDraftPane pane={pane} onDismiss={() => setPane(null)} />
      ) : null}
      {pane?.kind === "step-detail" ? (
        <StepDetailPane pane={pane} onDismiss={() => setPane(null)} />
      ) : null}
      {pane?.kind === "context" ? (
        <ContextPane pane={pane} onDismiss={() => setPane(null)} />
      ) : null}
      {pane?.kind === "probe-results" ? (
        <ProbeResultsPane pane={pane} onDismiss={() => setPane(null)} />
      ) : null}
      {pane?.kind === "preview-results" ? (
        <PreviewResultsPane pane={pane} onDismiss={() => setPane(null)} />
      ) : null}
      {pane?.kind === "version-browser" ? (
        <VersionBrowserPane pane={pane} onDismiss={() => setPane(null)} />
      ) : null}
      {pane?.kind === "approval-history" ? (
        <ApprovalHistoryPane pane={pane} onDismiss={() => setPane(null)} />
      ) : null}
      {pane?.kind === "setup-diagnostics" ? (
        <SetupDiagnosticsPane pane={pane} onDismiss={() => setPane(null)} />
      ) : null}
      {pane?.kind === "text" ? (
        <Pane
          title={pane.title}
          {...(pane.subtitle !== undefined ? { subtitle: pane.subtitle } : {})}
          onDismiss={() => setPane(null)}
        >
          {pane.lines.map((line, i) => (
            <Text key={`tp-${i}`}>{line}</Text>
          ))}
        </Pane>
      ) : null}
      {pane?.kind === "structured" ? (
        <Pane
          title={pane.title}
          {...(pane.subtitle !== undefined ? { subtitle: pane.subtitle } : {})}
          onDismiss={() => setPane(null)}
        >
          {pane.sections.map((section, sIdx) => {
            const headingColor =
              section.tone === "ok"
                ? "green"
                : section.tone === "fail"
                  ? "red"
                  : section.tone === "warn"
                    ? "yellow"
                    : "cyan";
            return (
              <Box key={`sec-${sIdx}`} flexDirection="column" marginBottom={1}>
                <Text color={headingColor} bold>
                  {section.heading}
                </Text>
                {section.rows.map(([k, v], rIdx) => (
                  <Box key={`sec-${sIdx}-row-${rIdx}`}>
                    <Text dimColor> {k}: </Text>
                    <Text>{v === null || v === undefined || v === "" ? "—" : String(v)}</Text>
                  </Box>
                ))}
              </Box>
            );
          })}
        </Pane>
      ) : null}
      {historyOpen ? (
        <HistorySearch
          entries={historyRef.current}
          onSelect={(prompt) => {
            setHistoryOpen(false);
            setInput(buffer(prompt));
            historyCursorRef.current = historyRef.current.length;
          }}
          onDismiss={() => setHistoryOpen(false)}
        />
      ) : null}
      {/* Inline Ctrl-R search — Claude-Code-style above-composer
          reverse-i-search widget. Commits replace the buffer; cancel
          restores it. */}
      {inlineSearchOpen ? (
        <InlineHistorySearch
          entries={historyRef.current}
          onCommit={(prompt) => {
            setInlineSearchOpen(false);
            setInput(buffer(prompt));
            historyCursorRef.current = historyRef.current.length;
          }}
          onCancel={() => setInlineSearchOpen(false)}
        />
      ) : null}

      {/* Validation errors — humanized: Step N: invalid `kind` + valid-kinds hint */}
      {session.validationErrors.length > 0 ? (
        <Box flexDirection="column" marginBottom={1}>
          <Text color="red" bold>
            validation errors
          </Text>
          {session.validationErrors.map((e, idx) => {
            const h = humanizeValidationError({
              path: e.path,
              message: typeof e.message === "string" ? e.message : JSON.stringify(e.message),
            });
            return (
              <Box key={`err-${idx}`} flexDirection="column">
                <Text color="red">× {h.label}</Text>
                {h.hint ? <Text color="yellow"> ↳ {h.hint}</Text> : null}
                {h.detail ? <Text dimColor> {h.detail}</Text> : null}
              </Box>
            );
          })}
        </Box>
      ) : null}

      {/* Thinking spinner */}
      <Spinner active={busy} turnTokens={session.usage?.turn_tokens ?? null} />

      {/* Subkit-specific telemetry line — tokens, connector count,
          optional shell-hook output. Sits above the footer so the
          footer's identity chrome stays on the last two rows. */}
      <StatusBar statusLine={statusLine} columns={columns} />

      <PendingAttachments items={pendingAttachments} />

      {/* Bordered composer — ────── / ❯ input / ────── */}
      <Composer input={input} busy={busy} />

      {/* Two-line footer — subkit identity + permission mode. Holds
          only engine-facing context (user, tenant, engine, session,
          mode); no cwd / model chrome — sk is not an IDE. */}
      <Footer
        user={statusSnapshot?.user.email ?? statusSnapshot?.user.id ?? persona.label}
        tenant={statusSnapshot?.tenant.slug ?? statusSnapshot?.tenant.id ?? persona.tenant}
        engineUrl={persona.engineUrl}
        sessionId={session.conversationId}
        mode={activeMode}
        transcriptMode={transcriptMode}
        connectionState={connectionSnapshot?.state ?? "unknown"}
        connectionReason={connectionSnapshot?.reason ?? null}
        columns={columns}
      />

      {/* Inline @-mention picker — shown when the buffer has an
          unresolved `@<query>` token at the cursor. Picks splice the
          chosen value back into the buffer. */}
      {mentionSpec && pane === null && !inlineSearchOpen ? (
        <MentionPicker
          query={mentionSpec.query}
          cwd={cwd ?? process.cwd()}
          onPick={(candidate: MentionCandidate) => {
            setInput((prev) => {
              const next = applyMention(prev.value, prev.cursor, mentionSpec.start, candidate);
              return { value: next.value, cursor: next.cursor };
            });
          }}
          onDismiss={() => {
            // Soft dismiss — leave the `@<query>` token untouched and
            // let the user keep typing. The picker will re-render when
            // the token changes.
          }}
        />
      ) : null}

      {/* Queued-commands indicator — shows when the user typed more
          prompts while the turn was running. Drained FIFO once the
          current turn finishes. */}
      {queuedCount > 0 ? (
        <Box>
          <Text color="yellow">⏸ </Text>
          <Text dimColor>{queuedCount} queued — drains when turn completes</Text>
        </Box>
      ) : null}

      {/* Fuzzy slash-command suggestions (hidden while a pane is open) */}
      {pane === null && !mentionSpec ? (
        <SuggestionList
          query={input.value}
          probe={persona.probe}
          selectedIndex={slashSelectedIndex}
        />
      ) : null}

      {/* Double-Ctrl-C exit flow (always-on input — even when a pane captures keys) */}
      <ExitFlow
        onExit={() => {
          exit();
          onExit?.();
        }}
      />
    </Box>
  );

  return (
    <ThemeProvider>
      <AlternateScreen enabled={altScreen}>{content}</AlternateScreen>
    </ThemeProvider>
  );
};
