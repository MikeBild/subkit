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
import { Box, Text, useApp, useInput } from "ink";
import type React from "react";
import { memo, useCallback, useDeferredValue, useEffect, useMemo, useRef, useState } from "react";
import type { StatusSummary } from "./engine-client.ts";
import { AlternateScreen } from "./repl/alt-screen.tsx";
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

const Composer: React.FC<{ input: string; busy: boolean }> = memo(({ input, busy }) => {
  const theme = useTheme();
  const [cursorOn, setCursorOn] = useState(true);
  useEffect(() => {
    const id = setInterval(() => setCursorOn((c) => !c), 500);
    return () => clearInterval(id);
  }, []);
  return (
    <Box>
      <Text color={busy ? theme.severity.warning : theme.role.assistant} bold>
        {busy ? "⣾ ⟫ " : "▎⟫ "}
      </Text>
      <Text>{input}</Text>
      <Text color={cursorOn ? theme.role.assistant : theme.severity.dim}>▊</Text>
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

  const [input, setInput] = useState("");
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
  // History-search pane is opened purely by Ctrl-R; it reads from the
  // prompt-ring ref that lives next to the composer, so it's simpler
  // to keep as a sibling boolean rather than widening PaneSpec.
  const [historyOpen, setHistoryOpen] = useState(false);
  // Permission mode — cycled by Shift-Tab. Seed from the prop so hosts
  // that persist a preference can drive it, but own the state locally
  // once the user interacts.
  const [activeMode, setActiveMode] = useState<PermissionMode>(permissionMode);
  const tip = useRef<string>(pickTip());
  // Prompt history ring — up/down cycles through prior submitted
  // prompts the same way a readline-style shell would. Cursor sits
  // at `length` when the user is composing a fresh line; pressing
  // Up moves it backward, Down moves forward again. The cursor
  // never goes below 0 or above `length`.
  const historyRef = useRef<string[]>([]);
  const historyCursorRef = useRef<number>(0);

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

  // -------- Input handling (printable chars, enter, backspace, Ctrl-C, Ctrl-T) --------
  const handleSubmit = useCallback(
    async (raw: string): Promise<void> => {
      const trimmed = raw.trim();
      setInput("");
      if (!trimmed) return;
      if (trimmed === "/exit" || trimmed === "/quit") {
        exit();
        onExit?.();
        return;
      }
      if (trimmed.startsWith("/")) {
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
          // Open the help catalog in the modal slot so it reads as a
          // proper reference card. `renderHelp` already emits multi-
          // line text — split into lines for the Pane.
          const helpLines = renderHelp(persona.probe).split("\n");
          // First line is the title (`sk — slash commands`); drop it
          // so Pane's own header doesn't duplicate it.
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

      // Plain prompt → drive a turn. We do NOT push the user message
      // locally — the engine loop emits `{type:"message", role:"user"}`
      // as the first event of the turn and the reducer picks it up.
      // Pushing locally would duplicate it when the turn events arrive.
      //
      // Synchronous guard: Enter auto-repeat can fire this callback
      // tens of times before `setBusy(true)` flushes through React.
      // The ref closes that window without waiting for the next
      // render.
      if (busyRef.current) return;
      busyRef.current = true;
      setBusy(true);
      // Record this prompt in the history ring so up/down can recall it.
      historyRef.current.push(trimmed);
      historyCursorRef.current = historyRef.current.length;
      try {
        const { events, conversationId } = await onPrompt(trimmed);
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
      }
    },
    [exit, onElicitResponse, onExit, onPrompt, onSlash, persona.probe, session],
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
  const composerActive = pane === null && !historyOpen;
  const slashMode = input.startsWith("/");
  useInput(
    (char, key) => {
      if (key.ctrl && char === "t") {
        setAltScreen((prev) => !prev);
        return;
      }
      // Shift-Tab cycles the permission mode: ask → auto → plan → ask.
      // Works at any time — even while elicitation is open or the
      // composer is gated — because the status badge needs to respond
      // regardless of what's on screen.
      if (key.shift && key.tab) {
        setActiveMode((m) => (m === "ask" ? "auto" : m === "auto" ? "plan" : "ask"));
        return;
      }
      // Ctrl-R opens the prompt-history search pane (mirrors the
      // readline/zsh shortcut users expect). The composer is gated
      // while the pane is open; picking a prompt restores input.
      if (key.ctrl && char === "r") {
        if (historyRef.current.length > 0) setHistoryOpen(true);
        return;
      }
      if (busyRef.current) return;
      // Elicitation is open: only let the composer consume input that
      // is part of a slash command (either starting one, or adding to
      // one already being typed).
      if (elicitOpen && !slashMode && char !== "/") return;
      if (key.upArrow) {
        if (historyRef.current.length === 0) return;
        const next = Math.max(0, historyCursorRef.current - 1);
        historyCursorRef.current = next;
        setInput(historyRef.current[next] ?? "");
        return;
      }
      if (key.downArrow) {
        if (historyRef.current.length === 0) return;
        const next = Math.min(historyRef.current.length, historyCursorRef.current + 1);
        historyCursorRef.current = next;
        setInput(historyRef.current[next] ?? "");
        return;
      }
      if (key.return) {
        void handleSubmit(input);
        return;
      }
      if (key.backspace || key.delete) {
        setInput((prev) => prev.slice(0, -1));
        return;
      }
      if (char && char.length > 0 && !key.ctrl && !key.meta) {
        setInput((prev) => prev + char);
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
  for (const c of deferredToolCalls) {
    transcriptRows.push(<ToolCard key={`tc-${c.id}`} call={c} />);
  }

  const content = (
    <Box flexDirection="column">
      {showBanner ? (
        <WelcomeBanner
          persona={persona.label}
          tenant={persona.tenant}
          engineUrl={persona.engineUrl}
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
            setInput(prompt);
            historyCursorRef.current = historyRef.current.length;
          }}
          onDismiss={() => setHistoryOpen(false)}
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

      {/* Status line — subkit-tailored: user · tenant · engine · model · conn · tokens · [mode] */}
      <StatusBar statusLine={statusLine} />

      {/* Composer — double-angle caret, busy mode swaps the prefix. */}
      <Composer input={input} busy={busy} />

      {/* Fuzzy slash-command suggestions (hidden while a pane is open) */}
      {pane === null ? <SuggestionList query={input} probe={persona.probe} /> : null}

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
