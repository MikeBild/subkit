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
import type { SkSessionState, ToolCallState, TurnEvent } from "@cli-core/index.ts";
import { applyTurnEvent, initialSessionState } from "@cli-core/index.ts";
import { Box, Text, useApp, useInput, useStdout } from "ink";
import type React from "react";
import { memo, useCallback, useDeferredValue, useEffect, useMemo, useRef, useState } from "react";
import type { StatusSummary } from "./engine-client.ts";
import { AlternateScreen } from "./repl/alt-screen.tsx";
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
import { DEFAULT_STARTER_ACTIONS, StarterActions } from "./repl/starter-actions.tsx";
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
  /** Active permission mode for the status line badge. */
  permissionMode?: PermissionMode;
  /**
   * Override the persistent-history file path. Tests pass a tmpdir
   * path so they don't read / mutate the real `~/.sk/history.jsonl`.
   */
  historyPath?: string;
  /** Called when the user submits a plain prompt (non-slash). */
  onPrompt: (text: string) => Promise<{ events: AsyncIterable<TurnEvent>; conversationId: string }>;
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
  onElicitResponse?: (elicitationId: string, output: unknown, reason?: string) => Promise<void>;
  /** Called when the user exits. */
  onExit?: () => void;
}

// ---------- Tool-call card (Claude Code style) ----------
//
// Indented under the turn with a `⎿` glyph. Status glyph colors by
// state (running yellow, done green, failed red). One-line input
// summary stays visible; full output stays collapsed until the user
// expands (Ctrl+E in a future iteration — for now always compact).

const SPINNER_FRAMES = ["⣾", "⣽", "⣻", "⢿", "⡿", "⣟", "⣯", "⣷"] as const;

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

const MessageRow: React.FC<{ role: string; content: string }> = memo(({ role, content }) => {
  const theme = useTheme();
  const prefix = role === "user" ? "▸" : role === "assistant" ? "◆" : "·";
  const color =
    role === "user"
      ? theme.role.user
      : role === "assistant"
        ? theme.role.assistant
        : role === "tool"
          ? theme.role.tool
          : theme.role.system;
  // Ink wraps inside a flex Box automatically. Using `wrap="wrap"` on a
  // single Text node lets long assistant lines (German prose, JSON,
  // bulleted lists) reflow on terminal resize instead of being clipped
  // by the parent flexbox.
  return (
    <Box flexDirection="row" marginBottom={1}>
      <Box flexShrink={0}>
        <Text color={color} bold>
          {prefix}{" "}
        </Text>
      </Box>
      <Box flexDirection="column" flexGrow={1}>
        <Text wrap="wrap">{content}</Text>
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

type TranscriptMode = "compact" | "detail";

const WORKFLOW_STARTER_PROMPT = [
  "Help me design a workflow with these steps:",
  "1. ",
  "2. ",
  "3. ",
].join("\n");

const StickyErrorPanel: React.FC<{ message: string }> = memo(({ message }) => (
  <Box flexDirection="column" marginBottom={1}>
    <Text color="red" bold>
      error
    </Text>
    <Text color="red">{message}</Text>
    <Text dimColor>Esc to dismiss</Text>
  </Box>
));
StickyErrorPanel.displayName = "StickyErrorPanel";

// ---------- Top-level App ----------

export const InkApp: React.FC<InkAppProps> = ({
  persona,
  statusLineConfig,
  initialConversationId,
  model,
  cwd,
  statusSnapshot,
  permissionMode = "ask",
  historyPath,
  onPrompt,
  onSlash,
  onSelectConversation,
  onElicitResponse,
  onExit,
}) => {
  const { exit } = useApp();
  const { stdout } = useStdout();
  const columns = stdout?.columns ?? DEFAULT_RULE_WIDTH;
  const [session, setSession] = useState<SkSessionState>(() =>
    initialSessionState(initialConversationId ?? null),
  );
  const deferredMessages = useDeferredValue(session.messages);
  const deferredToolCalls = useDeferredValue(session.toolCalls);
  // Count consecutive failed propose_step calls in the current turn.
  // The reducer marks `failed` whenever a tool returns ok=false, so we
  // walk the tail of the call list looking for a contiguous run of
  // failed propose_step entries. A single non-propose_step call (or a
  // successful one) breaks the streak. The banner uses this to nudge
  // the user when the model is stuck self-correcting.
  const proposeStepFailureStreak = useMemo(() => {
    let n = 0;
    for (let i = deferredToolCalls.length - 1; i >= 0; i--) {
      const c = deferredToolCalls[i];
      if (!c) break;
      if (c.name !== "propose_step") break;
      if (c.status !== "failed") break;
      n++;
    }
    return n;
  }, [deferredToolCalls]);

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
  const [banner, setBanner] = useState<string | null>(null);
  const [stickyError, setStickyError] = useState<string | null>(null);
  const [pane, setPane] = useState<PaneSpec | null>(null);
  // Inline Ctrl-R history search (above-composer widget). The old
  // modal `<HistorySearch>` pane is still available via `historyOpen`
  // as a fallback for constrained terminals.
  const [historyOpen, setHistoryOpen] = useState(false);
  const [inlineSearchOpen, setInlineSearchOpen] = useState(false);
  // Permission mode — cycled by Shift-Tab. Seed from the prop so hosts
  // that persist a preference can drive it, but own the state locally
  // once the user interacts.
  const [activeMode, setActiveMode] = useState<PermissionMode>(permissionMode);
  const [transcriptMode, setTranscriptMode] = useState<TranscriptMode>("compact");
  const tip = useRef<string>(pickTip());

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
  const showInfo = useCallback((message: string) => {
    setBanner(message);
    setStickyError(null);
  }, []);
  const showError = useCallback((message: string) => {
    setStickyError(message);
    setBanner(null);
  }, []);

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
    activeMode,
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
      return false;
    },
    [cwd, effectiveHistoryPath, showError, showInfo, syncPendingAttachments],
  );

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
          await onElicitResponse(elicitationId, { confirmed }, reason);
          setSession((s) => ({ ...s, pendingElicitation: null, status: "running" }));
          return;
        }
        if (onSlash) {
          const response = await onSlash(cmd.name, trimmed, setPane, session);
          if (response) showInfo(response);
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
        setStickyError(null);
        const { events, conversationId } = await onPrompt(finalPrompt);
        let next: SkSessionState = { ...session, conversationId };
        setSession(next);
        for await (const ev of events) {
          next = applyTurnEvent(next, ev);
          setSession({ ...next });
        }
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
      exit,
      onElicitResponse,
      onExit,
      onPrompt,
      onSlash,
      persona.probe,
      persona.tenant,
      session,
      handleBuiltinSlash,
      showError,
      showInfo,
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
        setTranscriptMode((mode) => (mode === "compact" ? "detail" : "compact"));
        return;
      }
      if (key.shift && key.tab) {
        setActiveMode((m) => (m === "ask" ? "auto" : m === "auto" ? "plan" : "ask"));
        return;
      }
      // Ctrl-R opens inline history-search (Claude-Code-style
      // above-composer widget). The modal pane is still reachable
      // via `/resume` for users who prefer it.
      if (key.ctrl && char === "r") {
        if (historyRef.current.length > 0) setInlineSearchOpen(true);
        return;
      }
      // Ctrl-L clears the terminal scroll buffer.
      if (key.ctrl && char === "l") {
        process.stdout.write("\x1b[2J\x1b[H");
        return;
      }
      if (key.escape && stickyError && pane === null && !inlineSearchOpen) {
        setStickyError(null);
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
        if (char === DEFAULT_STARTER_ACTIONS[0]?.key) {
          void handleSubmit("/resume");
          return;
        }
        if (char === DEFAULT_STARTER_ACTIONS[1]?.key) {
          setInput(buffer(WORKFLOW_STARTER_PROMPT));
          return;
        }
        if (char === DEFAULT_STARTER_ACTIONS[2]?.key) {
          void handleSubmit("/status");
          return;
        }
        if (char === DEFAULT_STARTER_ACTIONS[3]?.key) {
          void handleSubmit("/help");
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
        if (char.length > 1 && looksLikePaste(char)) {
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

  // Build one child per transcript row so ScrollView can window them.
  const transcriptRows: React.ReactNode[] = [];
  for (let i = 0; i < deferredMessages.length; i++) {
    const m = deferredMessages[i];
    if (m) transcriptRows.push(<MessageRow key={`msg-${i}`} role={m.role} content={m.content} />);
  }
  // Live streaming assistant buffer — rendered below finalised messages
  // until the next `message` frame arrives and clears it. Keeps the REPL
  // responsive as tokens arrive rather than waiting for the turn to end.
  if (session.streamingAssistantText.length > 0) {
    transcriptRows.push(
      <MessageRow
        key="live-delta"
        role={"assistant" as const}
        content={session.streamingAssistantText}
      />,
    );
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
  const flushBackgroundGroup = (calls: ToolCallState[]): void => {
    if (calls.length === 0) return;
    const ids = new Set(calls.map((call) => call.id));
    const logs = session.toolLogs.filter((log) => ids.has(log.call_id));
    transcriptRows.push(
      <BackgroundToolGroup
        key={`bg-${calls.map((call) => call.id).join("-")}`}
        calls={calls}
        logs={logs}
        detailed={transcriptMode === "detail"}
      />,
    );
  };
  let pendingBackgroundCalls: ToolCallState[] = [];
  for (const call of deferredToolCalls) {
    if (isBackgroundTool(call)) {
      pendingBackgroundCalls.push(call);
      continue;
    }
    flushBackgroundGroup(pendingBackgroundCalls);
    pendingBackgroundCalls = [];
    transcriptRows.push(
      <ToolCard
        key={`tc-${call.id}`}
        call={call}
        columns={columns}
        detailed={transcriptMode === "detail"}
      />,
    );
    pushForegroundLogs(call.id);
  }
  flushBackgroundGroup(pendingBackgroundCalls);

  const content = (
    <Box flexDirection="column">
      {showBanner ? (
        <>
          <WelcomeBanner
            persona={persona.label}
            tenant={persona.tenant}
            engineUrl={persona.engineUrl}
            profileName={persona.profileName}
            tip={tip.current}
          />
          {showWelcomeActions ? <StarterActions /> : null}
        </>
      ) : null}

      {/* Transient banner (help / errors / command feedback) */}
      {banner ? (
        <Box marginBottom={1}>
          <Text color="cyan">{banner}</Text>
        </Box>
      ) : null}
      {stickyError ? <StickyErrorPanel message={stickyError} /> : null}

      {/* Scrollable transcript. Shift+↑/↓ or PgUp/PgDn to move,
          Meta+↑/↓ jump to top/bottom. Auto-pins to bottom as turns
          stream in, until the user manually scrolls. */}
      <ScrollView active={composerActive && pane === null}>{transcriptRows}</ScrollView>

      {/* Elicit router — inline ask_user_* prompt. Renders above the
          modal slot so tool-driven elicits always feel "in the flow",
          while explicit slash commands (`/status`, `/resume`) open in
          the modal slot below. While the user is typing a `/` command
          we disable the router's keybindings so `/reject` doesn't get
          swallowed by the ConfirmPrompt's digit shortcuts. */}
      {session.pendingElicitation ? (
        <ElicitRouter
          elicitation={session.pendingElicitation}
          inputDisabled={pane !== null || slashMode}
          onResponse={(out) => {
            if (!onElicitResponse) return;
            const resp = out as ElicitationResponse;
            const reason =
              "decision_reason" in resp && typeof resp.decision_reason === "string"
                ? resp.decision_reason
                : undefined;
            void onElicitResponse(session.pendingElicitation!.id, resp, reason);
            setSession((s) => ({ ...s, pendingElicitation: null, status: "running" }));
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

      {/* Failure-streak banner — when the model can't shape the workflow */}
      {proposeStepFailureStreak >= 3 ? (
        <Box marginBottom={1} flexDirection="column">
          <Text color="yellow" bold>
            ⚠ the model is struggling to shape this workflow
          </Text>
          <Text color="yellow">
            try /clear and rephrase, or describe the steps yourself (kinds: request, transform,
            call, wait, branch, parallel, loop, tool)
          </Text>
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
