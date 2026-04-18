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
import { classifyAttachment, readClipboard } from "./repl/clipboard-read.ts";
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
} from "./repl/paste-store.ts";
import { createQueue } from "./repl/queue.ts";
import type { PaneSpec } from "./repl/slash-handler.ts";
import { Spinner } from "./repl/spinner.tsx";
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

const ToolCard: React.FC<{ call: ToolCallState }> = memo(({ call }) => {
  const theme = useTheme();
  const [tick, setTick] = useState(0);
  useEffect(() => {
    if (call.status !== "running") return;
    const id = setInterval(() => setTick((t) => t + 1), 80);
    return () => {
      clearInterval(id);
    };
  }, [call.status]);
  const summary =
    typeof call.args === "object" && call.args !== null
      ? JSON.stringify(call.args).slice(0, 72)
      : "";
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
  return (
    <Box>
      <Text color={theme.severity.dim}>⎿ </Text>
      <Text color={color} bold>
        {glyph}
      </Text>
      <Text> </Text>
      <Text color={theme.role.tool} bold>
        {call.name}
      </Text>
      {summary ? <Text color={theme.severity.dim}>({summary})</Text> : null}
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
  return (
    <Box flexDirection="row" marginBottom={1}>
      <Text color={color} bold>
        {prefix}{" "}
      </Text>
      <Box flexDirection="column">
        {content.split("\n").map((line, i) => (
          <Text key={`ln-${i}`}>{line}</Text>
        ))}
      </Box>
    </Box>
  );
});
MessageRow.displayName = "MessageRow";

// ---------- Status bar ----------

const StatusBar: React.FC<{ statusLine: string }> = memo(({ statusLine }) => {
  const theme = useTheme();
  if (!statusLine) return null;
  return (
    <Box marginBottom={1}>
      <Text color={theme.severity.dim}>╌ </Text>
      <Text color={theme.severity.dim}>{statusLine}</Text>
    </Box>
  );
});
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

const SuggestionList: React.FC<{ query: string; probe: PersonaProbe }> = memo(
  ({ query, probe }) => {
    const matches = useMemo(() => searchSlashCommands(query, probe, 5), [query, probe]);
    if (!query.startsWith("/") || matches.length === 0) return null;
    return (
      <Box flexDirection="column" marginTop={1}>
        <Text dimColor>matches:</Text>
        {matches.map((cmd) => (
          <Text key={`sug-${cmd.name}`}>
            <Text color="cyan">/{cmd.name}</Text>
            <Text dimColor> — {cmd.help}</Text>
          </Text>
        ))}
      </Box>
    );
  },
);
SuggestionList.displayName = "SuggestionList";

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
  const [session, setSession] = useState<SkSessionState>(() =>
    initialSessionState(initialConversationId ?? null),
  );
  const deferredMessages = useDeferredValue(session.messages);
  const deferredToolCalls = useDeferredValue(session.toolCalls);

  const [input, setInput] = useState<InputBuffer>(EMPTY_BUFFER);
  const [busy, setBusy] = useState(false);
  // Synchronous guard against Enter auto-repeat. `setBusy(true)` is
  // async, so without this ref two Enter presses ~1ms apart both see
  // `busy === false` and each spawn a turn, posting the same prompt
  // twice (or 50 times if the key is held down).
  const busyRef = useRef(false);
  const [altScreen, setAltScreen] = useState(false);
  const [statusLine, setStatusLine] = useState<string>("");
  const [banner, setBanner] = useState<string | null>(null);
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
      if (name === "paste") {
        const clip = readClipboard();
        if (clip.kind === "none") {
          setBanner("/paste: clipboard is empty");
          return true;
        }
        if (clip.kind === "text") {
          const { ref, lines } = pasteStoreRef.current.addText(clip.text);
          setInput((prev) => applyInput(prev, { type: "insert", text: ref }));
          setBanner(`/paste: inserted ${ref} (${lines + 1} line${lines === 0 ? "" : "s"})`);
          return true;
        }
        const img = pasteStoreRef.current.addImage({
          path: clip.path,
          mediaType: clip.mediaType,
          bytes: clip.bytes,
        });
        setInput((prev) => applyInput(prev, { type: "insert", text: img.ref }));
        setBanner(`/paste: inserted ${img.ref} (${clip.bytes} bytes)`);
        return true;
      }
      if (name === "attach" || name === "file") {
        const raw = rest.join(" ").trim();
        if (raw.length === 0) {
          setBanner("/attach: needs a path — e.g. `/attach ./invoice.pdf`");
          return true;
        }
        const { statSync, existsSync: exists } = await import("node:fs");
        const { resolve: res, basename: base } = await import("node:path");
        const abs = res(cwd ?? process.cwd(), raw);
        if (!exists(abs)) {
          setBanner(`/attach: not found: ${raw}`);
          return true;
        }
        const st = statSync(abs);
        if (!st.isFile()) {
          setBanner(`/attach: not a file: ${raw}`);
          return true;
        }
        const cls = classifyAttachment(abs);
        if (cls.kind === "image") {
          const added = pasteStoreRef.current.addImage({
            path: abs,
            mediaType: cls.mediaType,
            bytes: st.size,
          });
          setInput((prev) => applyInput(prev, { type: "insert", text: added.ref }));
          setBanner(`/attach: inserted ${added.ref} (${cls.mediaType}, ${st.size} bytes)`);
          return true;
        }
        const added = pasteStoreRef.current.addFile({
          path: abs,
          filename: base(abs),
          bytes: st.size,
        });
        setInput((prev) => applyInput(prev, { type: "insert", text: added.ref }));
        setBanner(`/attach: inserted ${added.ref} (${cls.mediaType}, ${st.size} bytes)`);
        return true;
      }
      if (name === "queue") {
        const items = [...queueRef.current.items];
        if (items.length === 0) setBanner("/queue: empty");
        else setBanner(`/queue: ${items.length} pending — ${items.slice(0, 3).join(" ; ")}`);
        return true;
      }
      if (name === "history") {
        const sub = rest[0];
        if (sub === "clear") {
          const { clearHistory } = await import("./repl/history-store.ts");
          clearHistory(defaultHistoryPath());
          historyRef.current = [];
          historyCursorRef.current = 0;
          setBanner("/history: cleared");
          return true;
        }
        setBanner(
          `/history: ${historyRef.current.length} prompt(s) stored at ${defaultHistoryPath()}`,
        );
        return true;
      }
      return false;
    },
    [cwd],
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
          setBanner(`unknown slash: ${trimmed}`);
          return;
        }
        if (cmd.requires && !persona.probe.allows(cmd.requires)) {
          setBanner(`sk: /${cmd.name} requires ${cmd.requires} (not granted)`);
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
            setBanner("no pending elicitation");
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
          if (response) setBanner(response);
        }
        return;
      }

      // Plain prompt → drive a turn. Busy-guard first: if a turn is
      // already in flight, enqueue the prompt and let the draining
      // loop pick it up after the current turn completes.
      if (busyRef.current) {
        queueRef.current.enqueue(trimmed);
        setQueuedCount(queueRef.current.length);
        setBanner(`queued (${queueRef.current.length}) — runs after the current turn`);
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

      try {
        const { events, conversationId } = await onPrompt(finalPrompt);
        let next: SkSessionState = { ...session, conversationId };
        setSession(next);
        for await (const ev of events) {
          next = applyTurnEvent(next, ev);
          setSession({ ...next });
        }
      } catch (err) {
        setBanner(`sk: ${err instanceof Error ? err.message : String(err)}`);
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
  // In-progress @mention — drives the inline mention picker.
  const mentionSpec = useMemo(
    () => (composerActive ? extractMention(input.value, input.cursor) : null),
    [composerActive, input.value, input.cursor],
  );
  useInput(
    (char, key) => {
      // --- Global shortcuts (active even under modal / busy) ----------
      if (key.ctrl && char === "t") {
        setAltScreen((prev) => !prev);
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
      if (busyRef.current) {
        // While busy, still accept keystrokes into the buffer so the
        // user can type ahead. Enter enqueues instead of spawning a
        // concurrent turn (see handleSubmit).
      }
      // Elicitation is open: only accept input that is part of a
      // slash command so the user can still /approve or /reject.
      if (elicitOpen && !slashMode && char !== "/") return;

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
          setInput((prev) => applyInput(prev, { type: "insert", text: ref }));
          setBanner(`pasted ${ref} — sent inline at submit`);
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
  for (const c of deferredToolCalls) {
    transcriptRows.push(<ToolCard key={`tc-${c.id}`} call={c} />);
    // Live tool-log lines for this call, if any.
    const logs = session.toolLogs.filter((l) => l.call_id === c.id);
    if (logs.length > 0) {
      transcriptRows.push(
        <Box key={`tl-${c.id}`} flexDirection="column" marginLeft={2}>
          {logs.map((log, idx) => (
            <Text key={`${c.id}-${idx}`} color="gray">
              · [{log.level}] {log.message}
            </Text>
          ))}
        </Box>,
      );
    }
  }

  const content = (
    <Box flexDirection="column">
      {showBanner ? (
        <WelcomeBanner
          persona={persona.label}
          tenant={persona.tenant}
          engineUrl={persona.engineUrl}
          profileName={persona.profileName}
          tip={tip.current}
        />
      ) : null}

      {/* Transient banner (help / errors / command feedback) */}
      {banner ? (
        <Box marginBottom={1}>
          <Text color="cyan">{banner}</Text>
        </Box>
      ) : null}

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

      {/* Validation errors */}
      {session.validationErrors.length > 0 ? (
        <Box flexDirection="column" marginBottom={1}>
          <Text color="red" bold>
            validation errors
          </Text>
          {session.validationErrors.map((e, idx) => (
            <Text key={`err-${idx}`} color="red">
              × {e.path}: {typeof e.message === "string" ? e.message : JSON.stringify(e.message)}
            </Text>
          ))}
        </Box>
      ) : null}

      {/* Thinking spinner */}
      <Spinner active={busy} turnTokens={session.usage?.turn_tokens ?? null} />

      {/* Subkit-specific telemetry line — tokens, connector count,
          optional shell-hook output. Sits above the footer so the
          footer's identity chrome stays on the last two rows. */}
      <StatusBar statusLine={statusLine} />

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
        <SuggestionList query={input.value} probe={persona.probe} />
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
