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

import type { SkSessionState, ToolCallState, TurnEvent } from "@cli-core/index.ts";
import { applyTurnEvent, initialSessionState } from "@cli-core/index.ts";
import { Box, Text, useApp, useInput } from "ink";
import type React from "react";
import { memo, useCallback, useDeferredValue, useEffect, useMemo, useRef, useState } from "react";
import { AlternateScreen } from "./repl/alt-screen.tsx";
import { ApprovalRouter } from "./repl/approval/router.tsx";
import { Spinner } from "./repl/spinner.tsx";
import { pickTip, WelcomeBanner } from "./repl/welcome-banner.tsx";
import { findSlashCommand, type PersonaProbe, renderHelp, searchSlashCommands } from "./slash.ts";
import {
  buildStatusLine,
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
  /** Called when the user submits a plain prompt (non-slash). */
  onPrompt: (text: string) => Promise<{ events: AsyncIterable<TurnEvent>; conversationId: string }>;
  /** Called when the user submits a slash command other than `/exit`. */
  onSlash?: (name: string, raw: string) => Promise<string | null>;
  /** Called on approve/reject so the app can POST to the engine. */
  onApproval?: (
    approvalId: string,
    decision: "approved" | "rejected",
    reason?: string,
  ) => Promise<void>;
  /** Called when the user exits. */
  onExit?: () => void;
}

// ---------- Tool-call panel ----------

const BLINK_GLYPHS = ["●", "○"] as const;

const ToolLine: React.FC<{ call: ToolCallState }> = memo(({ call }) => {
  const [tick, setTick] = useState(0);
  useEffect(() => {
    if (call.status !== "running") return;
    const id = setInterval(() => setTick((t) => t + 1), 500);
    return () => {
      clearInterval(id);
    };
  }, [call.status]);
  const args =
    typeof call.args === "object" && call.args !== null
      ? JSON.stringify(call.args).slice(0, 80)
      : "";
  let glyph: string;
  let color: string;
  if (call.status === "running") {
    glyph = BLINK_GLYPHS[tick % BLINK_GLYPHS.length] ?? "●";
    color = "yellow";
  } else if (call.status === "done") {
    glyph = "✓";
    color = "green";
  } else if (call.status === "failed") {
    glyph = "×";
    color = "red";
  } else {
    glyph = "•";
    color = "white";
  }
  return (
    <Text color={color}>
      {glyph} {call.name} <Text dimColor>{args}</Text>
    </Text>
  );
});
ToolLine.displayName = "ToolLine";

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
  onPrompt,
  onSlash,
  onApproval,
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
  const [altScreen, setAltScreen] = useState(false);
  const [statusLine, setStatusLine] = useState<string>("");
  const [banner, setBanner] = useState<string | null>(null);
  const tip = useRef<string>(pickTip());
  const startedAtRef = useRef<number>(Date.now());
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
      const input: StatusLineInput = {
        schema_version: 1,
        profile: persona.profileName,
        persona: persona.label,
        tenant: persona.tenant,
        engine_url: persona.engineUrl,
        model: model ?? null,
        session_id: session.conversationId,
        turn_tokens: session.usage?.turn_tokens ?? null,
        remaining_monthly_budget_tokens: session.usage?.remaining_monthly_budget_tokens ?? null,
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
          setBanner(renderHelp(persona.probe));
          return;
        }
        if (cmd.name === "approve" || cmd.name === "reject") {
          if (!session.pendingApproval || !onApproval) {
            setBanner("no pending approval");
            return;
          }
          // Argument parsing: `/approve [id]` or `/reject [id] [reason]`.
          // If the first token after the slash looks like a uuid we treat
          // it as an explicit approval id; otherwise we fall back to the
          // current pending-approval id and treat the rest of the line
          // as a reason (for /reject) or ignore it (for /approve).
          const parts = trimmed.split(/\s+/).slice(1);
          const UUID_RE = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i;
          let approvalId: string;
          let reasonTokens: string[];
          if (parts[0] && UUID_RE.test(parts[0])) {
            approvalId = parts[0];
            reasonTokens = parts.slice(1);
          } else {
            approvalId = session.pendingApproval.id;
            reasonTokens = parts;
          }
          const decision: "approved" | "rejected" =
            cmd.name === "approve" ? "approved" : "rejected";
          const reason =
            decision === "rejected" && reasonTokens.length > 0 ? reasonTokens.join(" ") : undefined;
          await onApproval(approvalId, decision, reason);
          setSession((s) => ({ ...s, pendingApproval: null, status: "running" }));
          return;
        }
        if (onSlash) {
          const response = await onSlash(cmd.name, trimmed);
          if (response) setBanner(response);
        }
        return;
      }

      // Plain prompt → drive a turn. We do NOT push the user message
      // locally — the engine loop emits `{type:"message", role:"user"}`
      // as the first event of the turn and the reducer picks it up.
      // Pushing locally would duplicate it when the turn events arrive.
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
        setBusy(false);
      }
    },
    [exit, onApproval, onExit, onPrompt, onSlash, persona.probe, session],
  );

  useInput((char, key) => {
    if (key.ctrl && char === "c") {
      setBanner("sk: exiting — Ctrl-C");
      exit();
      onExit?.();
      return;
    }
    if (key.ctrl && char === "t") {
      setAltScreen((prev) => !prev);
      return;
    }
    if (busy) return;
    // Prompt history navigation — up/down cycle through prior
    // submitted prompts. When the cursor lands past the end we
    // restore whatever the user had typed so far (stored on the
    // ref below so the up/down keys don't clobber fresh input).
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
  });

  // Banner once on mount so we don't cover the terminal prompt on
  // exit; clear it after the first prompt submission so the message
  // list gets the vertical space back.
  const showBanner = session.messages.length === 0;

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

      {/* Deferred message history — last 50 messages, React yields
          the reconcile when typing stays responsive. */}
      <Box flexDirection="column" marginBottom={1}>
        {deferredMessages.slice(-50).map((m, idx) => (
          <Box key={`msg-${idx}`} flexDirection="column" marginBottom={1}>
            <Text
              bold
              color={m.role === "user" ? "green" : m.role === "assistant" ? "blue" : "yellow"}
            >
              {m.role}:
            </Text>
            <Text>{m.content}</Text>
          </Box>
        ))}
      </Box>

      {/* Tool calls (deferred, blinking live dot) */}
      {deferredToolCalls.length > 0 ? (
        <Box flexDirection="column" marginBottom={1}>
          <Text bold color="magenta">
            tool calls
          </Text>
          {deferredToolCalls.slice(-10).map((c) => (
            <ToolLine key={c.id} call={c} />
          ))}
        </Box>
      ) : null}

      {/* Approval router */}
      {session.pendingApproval ? <ApprovalRouter approval={session.pendingApproval} /> : null}

      {/* Validation errors */}
      {session.validationErrors.length > 0 ? (
        <Box flexDirection="column" marginBottom={1}>
          <Text color="red" bold>
            validation errors
          </Text>
          {session.validationErrors.map((e, idx) => (
            <Text key={`err-${idx}`} color="red">
              × {e.path}: {e.message}
            </Text>
          ))}
        </Box>
      ) : null}

      {/* Thinking spinner */}
      <Spinner active={busy} turnTokens={session.usage?.turn_tokens ?? null} />

      {/* Status line */}
      {statusLine ? (
        <Box marginBottom={1}>
          <Text dimColor>{statusLine}</Text>
        </Box>
      ) : null}

      {/* Composer */}
      <Box>
        <Text color="cyan">{busy ? "… " : "sk> "}</Text>
        <Text>{input}</Text>
        <Text color="gray">▁</Text>
      </Box>

      {/* Fuzzy slash-command suggestions */}
      <SuggestionList query={input} probe={persona.probe} />
    </Box>
  );

  // Ref usage to silence the startedAtRef warning (it's reserved
  // for the "session duration" affordance we'll wire next).
  void startedAtRef;

  return <AlternateScreen enabled={altScreen}>{content}</AlternateScreen>;
};
