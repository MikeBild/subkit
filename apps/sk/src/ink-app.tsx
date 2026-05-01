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
  ChoicePrompt,
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
  PendingElicitation,
  RenderableMessagePart,
  SkSessionState,
  ToolCallState,
  TurnEvent,
} from "@cli-core/index.ts";
import { applyTurnEvent, initialSessionState, lastAssistantText } from "@cli-core/index.ts";
import { VERSION as CLI_VERSION } from "@cli-core/version.ts";
import { Box, Static, Text, useApp, useInput, useStdout } from "ink";
import type React from "react";
import { memo, useCallback, useDeferredValue, useEffect, useMemo, useRef, useState } from "react";
import { debugLog, serializeDebugError } from "./debug.ts";
import { looksLikeAssistantConfirmRequest } from "./elicitation-intent.ts";
import type { SetupValidationResponse, StatusSummary } from "./engine-client.ts";
import {
  detectSecretShape,
  REQUEST_CREDENTIAL_FORM_FALLBACK,
  secretRedirectHint,
} from "./lib/secret-shape.ts";
import { ActivityLine } from "./repl/activity-line.tsx";
import { AlternateScreen } from "./repl/alt-screen.tsx";
import { describeConfirmationPayload } from "./repl/approval/describe-confirmation.ts";
import { ResumeSummaryCard, renderAuthoringCard } from "./repl/authoring-cards.tsx";
import { BackgroundToolGroup, isBackgroundTool } from "./repl/background-tools.tsx";
import { classifyAttachment, readClipboard } from "./repl/clipboard-read.ts";
import { DiffCard } from "./repl/diff-cell.tsx";
import {
  classifyEngineError,
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
import { OnboardingWizard } from "./repl/onboarding-wizard.tsx";
import {
  createPasteStore,
  expandRefs,
  looksLikePaste,
  type PasteStore,
  type StoredPaste,
} from "./repl/paste-store.ts";
import { PendingAttachments } from "./repl/pending-attachments.tsx";
import { detectProseOptions } from "./repl/prose-options-detector.ts";
import { createQueue } from "./repl/queue.ts";
import type { PaneSpec } from "./repl/slash-handler.ts";
import { Spinner } from "./repl/spinner.tsx";
import { StarterActions, starterActionsForPersona } from "./repl/starter-actions.tsx";
import { type PagerEntry, TranscriptPager } from "./repl/transcript-pager.tsx";
import { truncateEnd, truncateMiddle } from "./repl/truncate.ts";
import { classifyVersionSkew, VersionMismatchBanner } from "./repl/version-mismatch-banner.tsx";
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
    opts?: { permission_mode?: "auto" | "ask" | "plan" | "yolo" },
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
   * Called when the user presses Esc during a long-running turn
   * (codex parity). Routes to `engineClient.cancelConversation(id)`
   * which fires the engine's abort signal so the in-flight stream
   * ends with `cancelled` instead of `succeeded` / `failed`.
   */
  onCancelConversation?: (conversationId: string) => Promise<unknown>;
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
const PENDING_NOTICE_PREFIX = "Waiting for input:";

// Field names whose values must be redacted in the transcript even
// when the form schema does not mark them sensitive. Defense in depth
// for malformed `ask_user_form` calls — a renderer that lazily passes
// the secret through is the worst possible failure mode.
const SENSITIVE_FIELD_NAME_RE =
  /(?:^|_)(?:token|secret|password|passwd|api[-_]?key|access[-_]?key|client[-_]?secret|auth)(?:$|_)/i;

interface FormFieldMeta {
  name: string;
  type?: string;
  sensitive?: boolean;
  label?: string;
}

/** Pull the form's field schema out of `PendingElicitation.input`,
 *  if any. Returns a Map keyed by field name → metadata. */
function readFormFieldSchema(input: unknown): Map<string, FormFieldMeta> {
  const out = new Map<string, FormFieldMeta>();
  if (!input || typeof input !== "object") return out;
  const fields = (input as { fields?: unknown }).fields;
  if (!Array.isArray(fields)) return out;
  for (const f of fields) {
    if (!f || typeof f !== "object") continue;
    const obj = f as Record<string, unknown>;
    if (typeof obj.name !== "string") continue;
    out.set(obj.name, {
      name: obj.name,
      ...(typeof obj.type === "string" ? { type: obj.type } : {}),
      ...(typeof obj.sensitive === "boolean" ? { sensitive: obj.sensitive } : {}),
      ...(typeof obj.label === "string" ? { label: obj.label } : {}),
    });
  }
  return out;
}

function isSensitiveField(name: string, meta: FormFieldMeta | undefined): boolean {
  if (meta?.sensitive === true) return true;
  if (meta?.type === "password") return true;
  return SENSITIVE_FIELD_NAME_RE.test(name);
}

function truncateForTranscript(value: string): string {
  return value.length > 40 ? `${value.slice(0, 37)}…` : value;
}

// Render an elicitation's `output` payload as a short, human-readable
// string for the transcript. Keeps the assistant turn auditable —
// without this the scrollback silently mutates ("approve" disappears
// from the record after the next LLM response). Sensitive form fields
// (type=password, sensitive:true, or a name like `token`/`api_key`)
// render as `<name>=***` so the audit trail names what was provided
// without leaking the secret.
export function renderElicitAnswer(output: unknown, input?: unknown, reason?: string): string {
  const suffix = reason ? ` — ${reason}` : "";
  if (output === null || output === undefined) return `(no answer)${suffix}`;
  if (typeof output === "string") return `${output}${suffix}`;
  if (typeof output === "number" || typeof output === "boolean") {
    return `${String(output)}${suffix}`;
  }
  if (typeof output === "object") {
    const obj = output as Record<string, unknown>;
    // For confirmations, append a short payload preview so the
    // transcript captures WHAT was approved, not just the verb. Pulled
    // from `commit_intent.description` first (the LLM's own one-line
    // summary), then `target.tool` + workflow/connector identifier as
    // a fallback. Without this, scrolling back through 5 "approve"
    // lines is meaningless — exactly the audit gap the operator hit
    // in session a6440493.
    const payloadPreview = describeConfirmationPayload(input);
    const previewSuffix = payloadPreview ? ` · ${payloadPreview}` : "";
    if (obj.confirmed === true) return `approve${previewSuffix}${suffix}`;
    if (obj.confirmed === false || obj.declined === true) return `reject${previewSuffix}${suffix}`;
    if (obj.tested === true) return `test${previewSuffix}${suffix}`;
    if (obj.partial === true) return `partial${previewSuffix}${suffix}`;
    if (typeof obj.value === "string") return `${obj.value}${suffix}`;
    if (typeof obj.choice === "string") return `${obj.choice}${suffix}`;
    if (Array.isArray(obj.choices)) return `${(obj.choices as unknown[]).join(", ")}${suffix}`;

    // Form output — render each field, redacting sensitive ones based
    // on the input schema (and a defensive name heuristic). Form
    // submissions arrive shaped as either `{values: {...}}` or `{...}`
    // depending on the engine path; handle both.
    const values =
      typeof obj.values === "object" && obj.values !== null
        ? (obj.values as Record<string, unknown>)
        : obj;
    const schema = readFormFieldSchema(input);
    const parts: string[] = [];
    for (const [k, v] of Object.entries(values)) {
      const meta = schema.get(k);
      const sensitive = isSensitiveField(k, meta);
      if (sensitive) {
        // Render the field name (and "***") even when the value is
        // missing — this signals "credential collected" without
        // exposing the secret.
        parts.push(`${k}=***`);
      } else if (typeof v === "string") {
        parts.push(`${k}=${truncateForTranscript(v)}`);
      } else if (typeof v === "number" || typeof v === "boolean") {
        parts.push(`${k}=${v}`);
      }
      if (parts.length >= 3) break;
    }
    if (parts.length > 0) return `${parts.join(", ")}${suffix}`;

    // Output empty / opaque, but the schema names fields — say what
    // the user filled (by name) so the audit is not just "(answered)".
    if (schema.size > 0) {
      const names = [...schema.keys()].slice(0, 3).join(", ");
      return `(filled: ${names})${suffix}`;
    }
  }
  return `(answered)${suffix}`;
}

function pendingNoticeMessage(elicitation: PendingElicitation): string {
  const summary = elicitation.summary.trim();
  switch (elicitation.tool_name) {
    case "ask_user_form":
      return `${PENDING_NOTICE_PREFIX} secure form required: ${summary}. Fill the form below and press Enter to submit.`;
    case "ask_user_confirm":
      return `${PENDING_NOTICE_PREFIX} confirmation required: ${summary}. Use the prompt below or /approve and /reject.`;
    case "ask_user_choice":
    case "ask_user_multi":
      return `${PENDING_NOTICE_PREFIX} selection required: ${summary}. Choose from the prompt below to continue.`;
    case "ask_user_text":
      return `${PENDING_NOTICE_PREFIX} text input required: ${summary}. Answer in the prompt below and press Enter.`;
    default:
      return `${PENDING_NOTICE_PREFIX} ${summary}.`;
  }
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

const NextBestActionsChips: React.FC<NextBestActionsChipsProps> = memo(({ actions }) => {
  const theme = useTheme();
  if (actions.length === 0) return null;
  return (
    <Box>
      <Text color={theme.severity.dim}> suggested next: </Text>
      {actions.map((action, idx) => (
        <Box key={`chip-${idx}-${action}`}>
          <Text inverse>{` [${idx + 1}] ${action} `}</Text>
          <Text> </Text>
        </Box>
      ))}
    </Box>
  );
});
NextBestActionsChips.displayName = "NextBestActionsChips";

// ---------- Setup-validation banner ----------
//
// One-line orange/red banner rendered ABOVE the welcome panel when
// `GET /v1/diagnostics/setup` reports a non-`ok` overall status.
// Sticky for the session — the same node is emitted every render
// until the status flips back to `ok`. The host (`ink-repl.ts`)
// owns the polling cadence; this component is a pure renderer.
//
//   warn    →  ⚠ Setup: {N} warning(s) — run /setup for details
//   blocked →  ✗ Setup: {N} blocking issue(s) — run /setup to resolve
//
// Colors come from the active theme so light-on-light terminals don't
// produce an unreadable result. The banner must NOT redraw or flash
// on every render — wrapping in <memo> below pins the props at the
// snapshot identity, so as long as `setupSnapshot` doesn't change
// React reuses the existing node.

function renderSetupBanner(snapshot: SetupValidationResponse): React.ReactNode {
  return (
    <SetupBanner
      key={`setup-banner-${snapshot.overall_status}`}
      status={snapshot.overall_status}
      warnings={snapshot.summary_counts.warnings}
      blockers={snapshot.summary_counts.blockers}
    />
  );
}

interface SetupBannerProps {
  status: "warn" | "blocked" | "ok";
  warnings: number;
  blockers: number;
}

const SetupBanner: React.FC<SetupBannerProps> = memo(({ status, warnings, blockers }) => {
  const theme = useTheme();
  if (status === "ok") return null;
  if (status === "warn") {
    const label = `${warnings} warning${warnings === 1 ? "" : "s"}`;
    return (
      <Box>
        <Text color={theme.severity.warning} bold>
          {`⚠ Setup: ${label} — run /setup for details`}
        </Text>
      </Box>
    );
  }
  // blocked
  const label = `${blockers} blocking issue${blockers === 1 ? "" : "s"}`;
  return (
    <Box>
      <Text color={theme.severity.error} bold>
        {`✗ Setup: ${label} — run /setup to resolve`}
      </Text>
    </Box>
  );
});
SetupBanner.displayName = "SetupBanner";

// ---------- Message row (Claude Code style) ----------

const MESSAGE_ROW_INDENT = 8; // 2 glyph + 6 label
const MESSAGE_ROW_RIGHT_MARGIN = 2; // safety so a wide ¶ doesn't kiss the right edge

const MessageRow: React.FC<{
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
}> = memo(({ role, content, parts, columns }) => {
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
        <MessageContent
          content={content}
          parts={parts}
          {...(typeof columns === "number" && columns > 0
            ? {
                width: Math.max(16, columns - MESSAGE_ROW_INDENT - MESSAGE_ROW_RIGHT_MARGIN),
              }
            : {})}
        />
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
  "I want help using sk surfaces — the CLI, MCP, the HTTP API, schedules, or Google Chat.",
  "Answer from actual engine behavior and exposed routes only.",
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
  onCancelConversation,
  resumeSummary,
}) => {
  const { exit } = useApp();
  const { stdout } = useStdout();
  const columns = stdout?.columns ?? DEFAULT_RULE_WIDTH;
  const rows = stdout?.rows ?? 30;
  const [session, setSession] = useState<SkSessionState>(() =>
    initialSessionState(initialConversationId ?? null),
  );
  const deferredMessages = useDeferredValue(session.messages);
  const deferredToolCalls = useDeferredValue(session.toolCalls);

  const [input, setInput] = useState<InputBuffer>(EMPTY_BUFFER);
  const [busy, setBusy] = useState(false);
  // Input-side credential filter (PR5). When the user pastes a
  // token-shaped string, the composer suppresses the send, replaces
  // the input field with a redirect hint, and arms this state. The
  // next Enter sends a structured nudge (REQUEST_CREDENTIAL_FORM_FALLBACK)
  // to the engine instead of the raw paste so the agent re-collects
  // through `ask_user_form(type: password, sensitive: true)`. Esc
  // clears it without sending anything. Only the kind name + 6-char
  // prefix sample ever surface in the UI; the matched secret is
  // dropped on the floor and never leaves this process.
  const [pendingSecretRedirect, setPendingSecretRedirect] = useState<{
    kind: string;
    sample: string;
  } | null>(null);
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
  // Transcript pager — Ctrl-P toggles a modal overlay that renders
  // every cell with full output and unabridged diffs. Codex parity.
  const [pagerOpen, setPagerOpen] = useState(false);
  const [statusLine, setStatusLine] = useState<string>("");
  const [notices, setNotices] = useState<TranscriptNotice[]>([]);
  const [pane, setPane] = useState<PaneSpec | null>(null);
  const setupBannerShownRef = useRef(false);
  // Latest `next_best_actions` list rendered to the operator. The
  // digit-key handler reads this when the composer is empty so 1..9
  // dispatches `please run <action>` for the corresponding chip.
  // Updated post-render via a useEffect that mirrors the latest
  // chips computed while walking tool calls.
  const latestChipsRef = useRef<string[]>([]);
  // Inline Ctrl-R history search (above-composer widget). The old
  // modal `<HistorySearch>` pane is still available via `historyOpen`
  // as a fallback for constrained terminals.
  const [historyOpen, setHistoryOpen] = useState(false);
  const [inlineSearchOpen, setInlineSearchOpen] = useState(false);
  // Permission mode — cycled by Shift-Tab through ask/auto/plan. yolo
  // is intentionally NOT in the cycle: it must be armed explicitly via
  // the `/yolo` slash command (with a typed-yes confirmation) and
  // expires automatically after 10 turns / 10 minutes whichever comes
  // first. Seed from the prop so hosts that persist a preference can
  // drive it, but own the state locally once the user interacts.
  const [activeMode, setActiveMode] = useState<PermissionMode>(permissionMode);
  // Tracks the previous sticky mode so `/yolo off` (or auto-expiry)
  // can restore exactly what the operator had selected before arming.
  const preYoloModeRef = useRef<PermissionMode>(permissionMode);
  // Yolo arming guard — when set, the next composer submission must
  // be the literal `yes` to confirm arming. Anything else cancels.
  const [awaitingYoloArm, setAwaitingYoloArm] = useState<boolean>(false);
  // yolo expiry tracking. Both counters reset every time yolo arms.
  const yoloArmedAtRef = useRef<number | null>(null);
  const yoloTurnCountRef = useRef<number>(0);
  const YOLO_MAX_TURNS = 10;
  const YOLO_MAX_DURATION_MS = 10 * 60 * 1000;
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

  // Yolo time-based expiry. When yolo is armed, schedule a single
  // disarm at YOLO_MAX_DURATION_MS after the arming time. Reuse
  // `activeMode` as the dependency: arming sets it to "yolo" so this
  // effect fires; disarming sets it back, which invalidates the
  // pending timer via the cleanup. The turn-based path in
  // `handleSubmit` covers the case of an active operator hitting the
  // 10-turn ceiling first.
  useEffect(() => {
    if (activeMode !== "yolo") return;
    const armedAt = yoloArmedAtRef.current ?? Date.now();
    const remaining = YOLO_MAX_DURATION_MS - (Date.now() - armedAt);
    const timer = setTimeout(
      () => {
        if (activeMode === "yolo") {
          const restored = preYoloModeRef.current;
          yoloArmedAtRef.current = null;
          yoloTurnCountRef.current = 0;
          setActiveMode(restored);
          showInfo(
            `yolo expired after ${Math.round(YOLO_MAX_DURATION_MS / 60_000)} min — restored mode ${restored}.`,
          );
        }
      },
      Math.max(remaining, 0),
    );
    return () => clearTimeout(timer);
  }, [activeMode]);

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
  // Kept around for future warning notices (e.g. yolo expiry, queue
  // overflow). The setup-validation banner that previously used this
  // moved to a sticky row above the welcome panel — see SetupBanner.
  const _showWarning = useCallback(
    (message: string, persistent = true) => {
      pushNotice("warning", message, persistent);
    },
    [pushNotice],
  );
  void _showWarning;
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
    const message = session.pendingElicitation
      ? pendingNoticeMessage(session.pendingElicitation)
      : null;
    setNotices((current) => {
      const withoutPending = current.filter(
        (item) => !item.message.startsWith(PENDING_NOTICE_PREFIX),
      );
      if (!message) {
        return withoutPending.length === current.length ? current : withoutPending;
      }
      const existing = current.find((item) => item.persistent && item.message === message);
      if (existing && withoutPending.length === current.length - 1) {
        return current;
      }
      return [
        {
          id: `pending-${session.pendingElicitation?.id ?? "unknown"}`,
          tone: "warning" as const,
          message,
          persistent: true,
        },
        ...withoutPending,
      ].slice(0, 4);
    });
  }, [session.pendingElicitation]);

  // Sync the latest-chips ref whenever the tool-call list changes. The
  // ref drives the digit-key shortcut in `useInput` below — pressing
  // 1..9 with an empty composer dispatches `please run <action>` for
  // the matching chip. We walk the calls in chronological order and
  // pick the last one whose `next_best_actions` list is non-empty.
  // Watching `session.toolCalls` (not the deferred copy) keeps the
  // shortcut responsive on the very next render frame after a tool
  // result lands — useDeferredValue can lag a paint or two on slow
  // hosts and the operator should not have to wait for that.
  useEffect(() => {
    let next: string[] = [];
    for (const call of session.toolCalls) {
      const chips = extractNextBestActions(call.result);
      if (chips.length > 0) next = chips;
    }
    latestChipsRef.current = next;
  }, [session.toolCalls]);

  // Setup-validation banner gating. The actual one-line banner renders
  // inside `welcomeRow` (see below) so it sits above the welcome panel
  // as the very first scrollback row. This effect only owns the
  // "have we already announced this status" memo so a repeated
  // `setupSnapshot` push (e.g. after a manual `/setup` refresh) does
  // not flash the banner twice in the notice stack. The render path is
  // sticky on its own — it emits the same node every render until the
  // status flips back to `ok`.
  useEffect(() => {
    if (!setupSnapshot || setupSnapshot.overall_status === "ok") {
      setupBannerShownRef.current = false;
      return;
    }
    setupBannerShownRef.current = true;
  }, [setupSnapshot]);

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
        // Forensic event: every elicit_request that crosses the wire
        // is recorded with the originating tool_call_id and shape.
        // Bookends the engine-side `elicitation.created` log so a
        // "did the prompt actually reach the CLI?" question is one
        // grep away across both halves of the trace.
        if (ev.type === "elicit_request") {
          const inputKind =
            ev.input && typeof ev.input === "object" && ev.input !== null
              ? ((ev.input as { kind?: unknown }).kind ?? null)
              : null;
          debugLog(
            "dialog.elicit_request_received",
            {
              elicitation_id: ev.elicitation_id,
              ...(ev.tool_call_id ? { tool_call_id: ev.tool_call_id } : {}),
              tool_name: ev.tool_name,
              ...(typeof inputKind === "string" ? { input_kind: inputKind } : {}),
            },
            {},
          );
        }
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
    // Choke-point idempotency: every caller (slash command, bare-text
    // shortcut, ElicitRouter digit-shortcut) routes through this. If the
    // engine is already processing a previous response, drop the
    // duplicate. Without this, two fast keystrokes POST /respond twice,
    // the engine re-resolves an already-resolved elicitation, and a
    // second runLoop fires — the silent-hang transcript's failure mode.
    if (busyRef.current) return;
    busyRef.current = true;
    setBusy(true);
    try {
      // Synthesize a user-role message capturing what the operator
      // just chose so the transcript doesn't look like the LLM
      // produced the answer out of thin air. Without this, an
      // approve-then-next-turn flow shows the LLM saying "Approve"
      // with no visible source. See bug E in the fix plan.
      // Pass the elicitation's `input` so renderElicitAnswer can
      // redact sensitive form fields based on the schema instead of
      // collapsing every form to `(answered)`.
      const answerText = renderElicitAnswer(output, session.pendingElicitation?.input, reason);
      // De-dupe at the insert site — mirrors handleSubmit's
      // `alreadyEchoed` guard. Two consecutive elicit responses that
      // render to the same redacted text (e.g. two form prompts that
      // both ask for `token`, the assistant re-asks because the first
      // submission failed validation, or any path where the prior
      // optimistic echo is still the last message) would otherwise
      // produce two `› you token=***` lines in the transcript with
      // nothing between them. Engine never replays elicit answers as
      // role=user message events (service.ts:605 `user_message:null`
      // when resuming), so the turn-event dedupe at turn-event.ts:426
      // never gets a chance to collapse the duplicates.
      const lastMsg = session.messages[session.messages.length - 1];
      const alreadyEchoed =
        lastMsg?.role === "user" &&
        lastMsg.id === undefined &&
        lastMsg.content.trim() === answerText.trim();
      const withAnswer: SkSessionState = alreadyEchoed
        ? {
            ...session,
            pendingElicitation: null,
            status: "running",
          }
        : {
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
      // PR5 input-side credential filter, branch 1 — confirmation step.
      // The previous submit detected a secret-shape and armed
      // `pendingSecretRedirect`. The `raw` we got is the redirect hint
      // text we put back into the buffer; the user pressing Enter again
      // is consent to forward the masked nudge to the agent. We
      // override `raw` with the fallback message so the engine never
      // sees the original token. Esc-clear is handled in the useInput
      // hook below; that path nulls `pendingSecretRedirect` and never
      // calls handleSubmit.
      if (pendingSecretRedirect !== null) {
        setPendingSecretRedirect(null);
        // Fall through with the masked nudge instead of the literal
        // hint. The agent's connector-creation skill already routes
        // any credential request through `ask_user_form(type: password,
        // sensitive: true)`, so a plain re-prompt is enough — see
        // apps/engine/src/conversations/seed/skills/connector-creation-guidance.md.
        // Engine-route decision: we kept the fallback path instead of
        // adding a `request_credential_form` event type to the engine
        // HTTP route. The engine has no schema for that event yet, and
        // the agent's existing skill set already does the right thing
        // when re-asked in plain language. Future PR can promote this
        // to a typed event without changing the CLI.
        showInfo("forwarding masked credential request to the agent");
        raw = REQUEST_CREDENTIAL_FORM_FALLBACK;
      }
      const trimmed = raw.trim();
      setInput(EMPTY_BUFFER);
      historyDraftRef.current = null;
      if (!trimmed) return;
      // Yolo expiry — by-turn. Auto-disarms after YOLO_MAX_TURNS
      // turns so a tab left open mid-task doesn't keep destructive
      // confirmations bypassed indefinitely.
      if (activeMode === "yolo") {
        if (yoloTurnCountRef.current >= YOLO_MAX_TURNS) {
          const restored = preYoloModeRef.current;
          yoloArmedAtRef.current = null;
          yoloTurnCountRef.current = 0;
          setActiveMode(restored);
          showInfo(`yolo expired after ${YOLO_MAX_TURNS} turns — restored mode ${restored}.`);
        } else {
          yoloTurnCountRef.current += 1;
        }
      }
      // Yolo arming intercept. The `/yolo` slash set
      // `awaitingYoloArm = true`; the very next submit must be the
      // literal `yes`. Anything else cancels and goes back to the
      // previous mode without firing the prompt at the engine.
      if (awaitingYoloArm) {
        setAwaitingYoloArm(false);
        if (trimmed.toLowerCase() === "yes") {
          yoloArmedAtRef.current = Date.now();
          yoloTurnCountRef.current = 0;
          setActiveMode("yolo");
          showInfo(
            "yolo armed — destructive tools will not prompt. Auto-disarms after " +
              `${YOLO_MAX_TURNS} turns or ${Math.round(YOLO_MAX_DURATION_MS / 60_000)} min. Type \`/yolo off\` to disarm now.`,
          );
        } else {
          showInfo(`/yolo: cancelled — staying in ${preYoloModeRef.current}.`);
        }
        return;
      }
      // PR5 input-side credential filter, branch 2 — initial detection.
      // Run after we've cleared the field but before the slash /
      // network branches so a pasted secret never reaches the engine
      // even if the user prefixed it with whitespace or a stray slash.
      // Slash commands themselves are unlikely to contain a secret, so
      // we only scan plain-prompt submissions. Scan both the literal
      // buffer AND the paste-expanded form so a long paste that got
      // stashed under `[Pasted text #N]` is still caught — the paste
      // store is what actually goes on the wire.
      if (!trimmed.startsWith("/")) {
        let shape = detectSecretShape(trimmed);
        if (!shape.matched) {
          const { prompt: probeExpanded } = expandRefs(trimmed, pasteStoreRef.current);
          if (probeExpanded !== trimmed) {
            shape = detectSecretShape(probeExpanded);
          }
        }
        if (shape.matched) {
          // Stash kind + 6-char sample only — the matched secret is
          // dropped here and never logged. Replace the buffer with a
          // human-readable hint the user can confirm or cancel. The
          // hint contains the sample (6 chars) but not the full token.
          // We also drop any paste-store entries that contained the
          // secret so they can't leak via a later @-mention or queue.
          for (const item of pasteStoreRef.current.all()) {
            if (item.kind === "text" && detectSecretShape(item.text).matched) {
              pasteStoreRef.current.delete(item.id);
            }
          }
          syncPendingAttachments();
          setPendingSecretRedirect({ kind: shape.kind, sample: shape.sample });
          setInput(buffer(secretRedirectHint(shape)));
          return;
        }
      }
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
          if (!onElicitResponse) {
            showError("no pending elicitation");
            return;
          }
          // Idempotency guard: a second `/approve` while the engine is
          // still processing the first one re-resolves an already-resolved
          // elicitation and triggers a duplicate runLoop turn (wasted
          // tokens). Match the bare-text shortcut's behavior: hint and
          // bail.
          if (busyRef.current) {
            showInfo(
              cmd.name === "approve"
                ? "approval already sent — engine is executing, hang tight"
                : "rejection already sent — engine is executing, hang tight",
            );
            return;
          }
          if (!session.pendingElicitation) {
            showInfo(
              session.status === "running"
                ? `no pending ${cmd.name === "approve" ? "approval" : "rejection"} — engine is still running`
                : `no pending ${cmd.name === "approve" ? "approval" : "rejection"}`,
            );
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
        if (cmd.name === "yolo") {
          // Refuse arming while a confirmation is pending — the
          // operator might resolve a confirm-step under a mode they
          // didn't intend, which is exactly the foot-gun yolo opens
          // up.
          if (session.pendingElicitation) {
            showError("/yolo: cannot arm while an elicitation is pending — resolve it first.");
            return;
          }
          const arg = trimmed.split(/\s+/).slice(1)[0]?.toLowerCase();
          if (arg === "off" || arg === "disarm") {
            if (activeMode !== "yolo") {
              showInfo("/yolo: not currently armed.");
              return;
            }
            yoloArmedAtRef.current = null;
            yoloTurnCountRef.current = 0;
            setActiveMode(preYoloModeRef.current);
            setAwaitingYoloArm(false);
            showInfo(`/yolo: disarmed — restored mode ${preYoloModeRef.current}.`);
            return;
          }
          if (activeMode === "yolo") {
            showInfo("/yolo: already armed. Type `/yolo off` to disarm.");
            return;
          }
          if (awaitingYoloArm) {
            showInfo("/yolo: already awaiting confirmation — type `yes` to arm.");
            return;
          }
          preYoloModeRef.current = activeMode;
          setAwaitingYoloArm(true);
          showInfo(
            "/yolo: type `yes` (literally) and Enter to arm. " +
              "Yolo lifts the delete/revoke/approve confirmation gate for the " +
              "next 10 turns / 10 min. Anything else cancels.",
          );
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

      // Pending-elicitation routing — mirrors the reference impl's
      // structured-only confirmation pattern.
      //
      // The engine pauses the conversation on any `askUser.*` tool and
      // expects the next /respond call to carry a STRUCTURED answer
      // (confirmed boolean, option index, or form values). The chat-ui
      // ships a dedicated component for each tool — ConfirmPrompt,
      // ChoicePrompt, MultiChoicePrompt, TextPrompt, FormPrompt — all
      // with explicit keybinds (Y/N/Enter/Esc/Tab/arrows) that drive
      // submitElicitationResponse directly.
      //
      // Free text typed at the main prompt input while an elicitation
      // is open is NEVER classified as a confirmation answer. The
      // pre-c35ef1c regex classifier ("yes" / "save it" / "ship it" →
      // confirm) was fragile, surfaced silent false-positives, and is
      // not how the reference impl works. We forward the user to the
      // structured component instead. Slash commands (/approve,
      // /reject, /respond, /cancel) remain available for explicit
      // CLI-only flows.
      if (session.pendingElicitation) {
        debugLog(
          "dialog.elicitation_routing",
          {
            elicitation_id: session.pendingElicitation.id,
            ...(session.pendingElicitation.tool_call_id
              ? { tool_call_id: session.pendingElicitation.tool_call_id }
              : {}),
            pending_tool: session.pendingElicitation.tool_name,
            classified_intent: "structured_only",
            input_excerpt: trimmed.length > 80 ? `${trimmed.slice(0, 80)}…` : trimmed,
          },
          {},
        );
        if (busyRef.current) {
          showInfo("answer already sent — engine is executing, hang tight");
          return;
        }
        const tool = session.pendingElicitation.tool_name;
        const hint =
          tool === "ask_user_confirm"
            ? `pending confirmation above — press Y/Enter to approve, N/Esc to reject, Tab to add a reason. /approve and /reject also work. (typed text is not auto-classified)`
            : tool === "ask_user_choice" || tool === "ask_user_pick"
              ? `pending option list above — focus the choice with arrows and press Enter, or type the option number on the choice itself. /respond also works.`
              : tool === "ask_user_multi"
                ? `pending multi-select above — toggle items with Space, then press Enter to submit.`
                : tool === "ask_user_text"
                  ? `pending text prompt above — type into THAT field and press Enter to submit. /respond <text> also works.`
                  : `pending form above — fill the fields shown and press Enter to submit. /respond <json> also works.`;
        showInfo(hint);
        return;
      }

      // Plain prompt → drive a turn. Busy-guard first: if a turn is
      // already in flight, enqueue the prompt and let the draining
      // loop pick it up after the current turn completes.
      // Forensic event: any prompt that reaches this branch with a
      // recently-emitted "Reply 'yes'"-style assistant message but no
      // pending elicitation is almost certainly hitting the silent
      // failure mode where the engine asked for confirmation in prose
      // without actually emitting an elicit_request. Surface a loud
      // warning so the operator knows the next "yes" will become a
      // phantom new prompt instead of an approval.
      const lastAssistantTextValue = lastAssistantText(session);
      const hadRecentUnresolvedIntent =
        session.pendingElicitation === null &&
        looksLikeAssistantConfirmRequest(lastAssistantTextValue);
      debugLog(
        "dialog.plain_prompt_sent",
        {
          session_status: session.status,
          had_recent_unresolved_intent: hadRecentUnresolvedIntent,
          input_excerpt: trimmed.length > 80 ? `${trimmed.slice(0, 80)}…` : trimmed,
        },
        {},
      );
      if (hadRecentUnresolvedIntent) {
        showError(
          "the assistant asked for explicit confirmation but did not emit an elicit_request — your reply will be sent as a NEW prompt, not as an approval. This usually means an engine policy-gate bug; see logs for `policy.gate_skipped` or `commit_gate.denied`.",
        );
      }
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
        // Synthesize the user-role message BEFORE awaiting onPrompt
        // so the operator sees their input echoed in the transcript
        // immediately. Pre-fix the user typed "3" to pick option 3
        // from the LLM's prose options and waited 1m26s for the
        // assistant to respond before their own message appeared in
        // the scrollback (session 09219b6d). Mirrors how the
        // elicitation pathway already echoes via
        // submitElicitationResponse at line 1748.
        // De-dupe at the insert site: when the previous message is
        // already a no-id user message with the same content, skip
        // the second optimistic append. Pre-fix re-entrant
        // handleSubmit (e.g. fast double-Enter) produced "› you 1 /
        // › you 1" twice in the transcript before any sk reply
        // (session dcdcf246).
        const lastMsg = session.messages[session.messages.length - 1];
        const alreadyEchoed =
          lastMsg?.role === "user" &&
          lastMsg.id === undefined &&
          lastMsg.content.trim() === trimmed.trim();
        const optimisticSession: SkSessionState = alreadyEchoed
          ? session
          : {
              ...session,
              messages: [...session.messages, { role: "user", content: trimmed }],
            };
        if (!alreadyEchoed) setSession(optimisticSession);
        const { events, conversationId } = await onPrompt(finalPrompt, {
          permission_mode: activeMode,
        });
        await applyEventStream({ ...optimisticSession, conversationId }, events, conversationId);
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
      pendingSecretRedirect,
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
  // Input-focus contract: at most ONE useInput hook is active at any
  // time. When an elicitation is open, the matching prompt component
  // (ConfirmPrompt / ChoicePrompt / FormPrompt / TextPrompt /
  // MultiChoicePrompt) owns the keyboard via its own useInput, and
  // the composer goes inactive. Without this gate, both the composer
  // and the prompt's useInput fired on every keystroke — keys leaked
  // into the input buffer while the user was trying to drive the
  // approve/reject chooser, producing the "approve / approve / still-
  // waiting" UX bug from session 84d06d81. Slash commands keep working
  // because /approve and /reject are dispatched here directly.
  const composerActive = pane === null && !historyOpen && !inlineSearchOpen && !elicitOpen;
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
      // Ctrl-P toggles the transcript pager — codex-style modal showing
      // every cell with full output / full diff. Distinct from the
      // alt-screen inspect mode (Ctrl-T) which is a different rendering.
      if (key.ctrl && char === "p") {
        setPagerOpen((prev) => !prev);
        return;
      }
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
      // PR5 input-side credential filter: Esc clears an armed redirect
      // without sending anything. Highest-priority Esc handler so the
      // user can always bail out of a paste-was-detected prompt.
      if (key.escape && pendingSecretRedirect !== null) {
        setPendingSecretRedirect(null);
        setInput(EMPTY_BUFFER);
        showInfo("credential paste cancelled");
        return;
      }
      // Esc-to-interrupt for a long-running turn — codex parity.
      // Routes to the engine's cancel endpoint via the conversation
      // id; the running stream sees its abort signal fire and the
      // turn ends with a `cancelled` status. Only fires when the CLI
      // is actually busy (busyRef) AND no other Esc-consumer is
      // armed (no pending elicit, no notice, no pane).
      if (
        key.escape &&
        busyRef.current &&
        pendingElicit === null &&
        pane === null &&
        !inlineSearchOpen
      ) {
        const cid = session.conversationId;
        if (cid && onCancelConversation) {
          showInfo("interrupting current turn — esc pressed");
          void onCancelConversation(cid).catch(() => {
            /* engine logs the failure; CLI surfaces the abort UX regardless */
          });
        }
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
      // Belt + braces: composerActive already excludes elicitOpen so
      // this hook never fires while a prompt component owns input.
      // Keep the guard in case isActive lags one frame behind a
      // freshly-arrived elicit_request event.
      if (elicitOpen) return;

      // --- Next-best-actions chip shortcut (digits 1..9) -------------
      // Wins over the welcome-action shortcut below: a freshly-failed
      // tool with chips might land in a session that hasn't pushed an
      // assistant message yet (so showWelcomeActions is still true),
      // and the operator should still be able to press 1..9 to run the
      // suggested action. Empty-input gate is unchanged so the
      // shortcut never breaks numeric input the user is typing.
      if (
        char &&
        char.length === 1 &&
        char >= "1" &&
        char <= "9" &&
        !key.ctrl &&
        !key.meta &&
        input.value.length === 0 &&
        latestChipsRef.current.length > 0
      ) {
        const chipIdx = char.charCodeAt(0) - "1".charCodeAt(0);
        const action = latestChipsRef.current[chipIdx];
        if (action) {
          void handleSubmit(`please run ${action}`);
          return;
        }
      }

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
      // Three ways to insert a newline (multi-line drafting), one to
      // submit:
      //
      //   - Ctrl-J (line feed) — the tmux / emacs convention, works on
      //     every terminal because the byte is unambiguous.
      //   - Shift+Enter — codex-style; only delivered as a distinct
      //     event on terminals that speak the kitty keyboard protocol
      //     (kitty, ghostty, recent iTerm2, foot, alacritty with
      //     `keyboard_protocol = enabled`). On classic terminals
      //     shift+enter is indistinguishable from plain enter and this
      //     branch never fires; the user falls back to ctrl-j.
      //   - Backslash + Enter — universal escape that works on every
      //     terminal: typing `\` then Enter strips the trailing
      //     backslash and inserts a newline. Mirrors shell heredoc /
      //     readline line-continuation semantics so power users can
      //     type multi-line drafts without leaving the home row.
      //
      // Plain Enter (carriage return, no shift) submits the buffer.
      if (key.ctrl && char === "j") {
        setInput((prev) => applyInput(prev, { type: "newline" }));
        return;
      }
      if (key.shift && key.return) {
        setInput((prev) => applyInput(prev, { type: "newline" }));
        return;
      }
      if (key.return) {
        // Backslash + Enter line-continuation: strip the trailing `\`
        // and insert a newline. Only fires when the cursor is past a
        // single trailing backslash (avoids munging "C:\foo" pastes
        // mid-line).
        if (
          input.cursor === input.value.length &&
          input.value.endsWith("\\") &&
          !input.value.endsWith("\\\\")
        ) {
          setInput((prev) =>
            applyInput(prev, {
              type: "set",
              value: `${prev.value.slice(0, -1)}\n`,
              cursor: prev.value.length, // length of trimmed-then-newlined buffer
            }),
          );
          return;
        }
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
    // De-duplication of CONSECUTIVE identical card signatures —
    // session 86de186b stacked 4 identical "Execution needs
    // diagnosis · partial_success · v2 · 1 warning" cards in a row
    // when the LLM retried run_workflow without changing the
    // workflow. The signature compares tool name + status + the
    // structured outcome (success/error_code/partial_success
    // marker). When N consecutive calls collapse to the same
    // signature, we render the FIRST card and append a "(×N)"
    // multiplier instead of N stacked clones. Inspect view bypasses
    // the dedupe so an operator can still see every call individually.
    let lastCardSignature: string | null = null;
    let lastCardCount = 0;
    let lastCardIndex = -1;
    const cardSignatureFor = (c: ToolCallState): string | null => {
      if (inspectView) return null;
      const result = (c.result ?? {}) as Record<string, unknown>;
      const data = (result.data ?? {}) as Record<string, unknown>;
      const status = typeof data.status === "string" ? data.status : c.status;
      const errorCode = typeof data.error_code === "string" ? data.error_code : null;
      const requiresRepair = data.requires_repair === true ? "rr" : "";
      const warningsCount = Array.isArray(data.warnings) ? (data.warnings as unknown[]).length : 0;
      return [c.name, status, errorCode ?? "", requiresRepair, warningsCount].join("|");
    };
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
      const chips = extractNextBestActions(call.result);
      const authoringCard = inspectView ? null : renderAuthoringCard(call, transcriptMode);
      // Consecutive-dedupe check. When this card's signature matches
      // the previous one, replace the previous card with a "(×N)"-
      // suffixed version instead of pushing a clone.
      const signature = authoringCard ? cardSignatureFor(call) : null;
      if (
        authoringCard &&
        signature !== null &&
        signature === lastCardSignature &&
        lastCardIndex === transcriptRows.length - 1
      ) {
        lastCardCount += 1;
        transcriptRows[lastCardIndex] = (
          <Box key={`dup-${call.id}`} flexDirection="column" marginBottom={1}>
            {authoringCard}
            <Box marginLeft={2}>
              <Text dimColor>{`(repeated ${lastCardCount}× — same outcome)`}</Text>
            </Box>
          </Box>
        );
        continue;
      }
      lastCardSignature = signature;
      lastCardCount = 1;
      if (authoringCard) {
        transcriptRows.push(authoringCard);
        lastCardIndex = transcriptRows.length - 1;
        // Render `tool_log` entries inline under: (a) anything in
        // inspect view, (b) any failed tool so the diagnosis is
        // visible, (c) any RUNNING tool so the user sees per-step
        // progress as it streams (the run_workflow / dry_run_workflow
        // tools emit one tool_log per step → that lets the user watch
        // the loop iterate live), or (d) when SK_VERBOSE=1 forces
        // every successful tool to render its full log.
        const showLogs =
          inspectView ||
          call.status === "failed" ||
          call.status === "running" ||
          call.status === "pending" ||
          process.env.SK_VERBOSE === "1";
        if (showLogs) pushForegroundLogs(call.id);
        if (chips.length > 0) {
          transcriptRows.push(<NextBestActionsChips key={`chips-${call.id}`} actions={chips} />);
        }
        continue;
      }
      if (inspectView || call.status === "failed") {
        transcriptRows.push(
          <ToolCard key={`tc-${call.id}`} call={call} columns={columns} detailed={inspectView} />,
        );
        pushForegroundLogs(call.id);
        if (chips.length > 0) {
          transcriptRows.push(<NextBestActionsChips key={`chips-${call.id}`} actions={chips} />);
        }
      } else if (chips.length > 0) {
        // Tool succeeded but still suggested next actions (rare —
        // typically `ok: true` won't have a chip list, but the helper
        // already gates on `ok: false`). Surface the chips even when
        // we suppress the verbose ToolCard in chat mode.
        transcriptRows.push(<NextBestActionsChips key={`chips-${call.id}`} actions={chips} />);
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

  // Bucket diff cells by parent_message_id so they thread under the
  // assistant message that triggered them. Diffs without an anchor
  // render in a trailing block at the end (rare — only when the
  // diff TurnEvent arrived before any assistant message in the turn).
  const diffsByParent = new Map<string, typeof session.diffs>();
  const orphanDiffs: typeof session.diffs = [];
  for (const d of session.diffs) {
    if (d.parentMessageId) {
      const list = diffsByParent.get(d.parentMessageId) ?? [];
      list.push(d);
      diffsByParent.set(d.parentMessageId, list);
    } else {
      orphanDiffs.push(d);
    }
  }

  // Pager entries — flat list of every cell rendered in chronological
  // order with full payloads (no truncation). Built once per render so
  // toggling the pager doesn't recompute on each keystroke.
  const pagerEntries: PagerEntry[] = [];
  for (let i = 0; i < deferredMessages.length; i++) {
    const m = deferredMessages[i];
    if (!m) continue;
    pagerEntries.push({
      id: m.id ?? `pager-msg-${i}`,
      kind: m.role === "user" ? "user" : "assistant",
      text: m.content,
    });
    if (m.id) {
      const childCalls = callsByParent.get(m.id);
      if (childCalls) {
        for (const c of childCalls) {
          pagerEntries.push({ id: `pager-tc-${c.id}`, kind: "tool", toolCall: c });
        }
      }
      const childDiffs = diffsByParent.get(m.id);
      if (childDiffs) {
        for (const d of childDiffs) {
          pagerEntries.push({
            id: `pager-diff-${d.id}`,
            kind: "diff",
            diff: { title: d.title, language: d.language, hunks: d.hunks },
          });
        }
      }
    }
  }
  for (const c of orphanCalls) {
    pagerEntries.push({ id: `pager-tc-orphan-${c.id}`, kind: "tool", toolCall: c });
  }
  for (const d of orphanDiffs) {
    pagerEntries.push({
      id: `pager-diff-orphan-${d.id}`,
      kind: "diff",
      diff: { title: d.title, language: d.language, hunks: d.hunks },
    });
  }
  for (let i = 0; i < deferredMessages.length; i++) {
    const m = deferredMessages[i];
    if (!m) continue;
    // Skip empty assistant turns. The model occasionally emits a
    // pure tool-calling turn with no text (or a literal "{}" stub
    // when the structured output didn't include a text field). The
    // raw stringified `{}` rendered as a `• sk    {}` line in the
    // transcript — visual noise that confused operators in session
    // 1222158a. The child tool calls below still render under the
    // same parent_message_id, so dropping the empty header row only
    // removes the speaker line, never the work the turn produced.
    const trimmedContent = (m.content ?? "").trim();
    const isEmptyAssistantStub =
      m.role === "assistant" &&
      (trimmedContent === "" || trimmedContent === "{}") &&
      (!m.parts || m.parts.length === 0);
    if (!isEmptyAssistantStub) {
      transcriptRows.push(
        <MessageRow
          key={`msg-${i}`}
          role={m.role}
          content={m.content}
          parts={m.parts}
          columns={columns}
        />,
      );
    }
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
      // Render any threaded diff cells under this assistant message.
      // Codex parity: structural mutation visible inline at the moment
      // it lands, no scroll-back required.
      const childDiffs = diffsByParent.get(m.id);
      if (childDiffs && childDiffs.length > 0) {
        for (const d of childDiffs) {
          transcriptRows.push(
            <DiffCard key={`diff-${d.id}`} title={d.title} language={d.language} hunks={d.hunks} />,
          );
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
  // Trailing orphan diffs (no parent_message_id) — render dynamically
  // so they update if more land before the next assistant message.
  if (orphanDiffs.length > 0) {
    transcriptRows = dynamicRows;
    for (const d of orphanDiffs) {
      transcriptRows.push(
        <DiffCard
          key={`diff-orphan-${d.id}`}
          title={d.title}
          language={d.language}
          hunks={d.hunks}
        />,
      );
    }
    transcriptRows = staticRows;
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
        columns={columns}
      />,
    );
  }
  // Prose-options translator. The LLM occasionally still emits a
  // numbered list with a trailing question ("1. Run … 2. Show … Which
  // would you prefer?") despite the STRUCTURED USER INTERACTION skill
  // rule. When that shape lands and no real elicitation is pending,
  // synthesise a ChoicePrompt under the message so the user gets an
  // actual ink picker instead of having to type "1" or "yes" into a
  // free-text composer. Pre-fix sessions dcdcf246 / 86de186b kept
  // hitting this anti-pattern.
  if (
    !busy &&
    pendingElicit === null &&
    session.streamingAssistantText.length === 0 &&
    deferredToolCalls.every(isToolCallFinalized)
  ) {
    const lastAssistant = lastAssistantText(session);
    const detected = detectProseOptions(lastAssistant);
    if (detected) {
      // Anchor the synthesised pick to the message id of the
      // assistant turn whose text it came from. When that id
      // changes (engine emits a new assistant message), the
      // ChoicePrompt re-mounts — keys old focused state from
      // bleeding across forks.
      const lastAssistantMsg = (() => {
        for (let i = session.messages.length - 1; i >= 0; i--) {
          const m = session.messages[i];
          if (m?.role === "assistant") return m;
        }
        return null;
      })();
      const anchorKey = lastAssistantMsg?.id ?? lastAssistant.length.toString(36);
      dynamicRows.push(
        <Box key={`prose-choice-${anchorKey}`} marginLeft={MESSAGE_ROW_INDENT}>
          <ChoicePrompt
            question={detected.question}
            options={detected.options.map((o) => ({ value: o.value, label: o.label }))}
            inputDisabled={pane !== null || slashMode}
            onResponse={(out) => {
              // Belt-and-braces double-fire guard. ChoicePrompt's
              // useInput hook can fire twice in rapid succession
              // when the user mashes Enter / a digit, and the
              // synchronous `setBusy(true)` race in handleSubmit
              // would otherwise queue the duplicate via the prompt
              // queue. We never want a queued duplicate from a
              // single pick — read busyRef directly so the
              // second fire bails before any side effect.
              if (busyRef.current) return;
              void handleSubmit(out.value);
            }}
          />
        </Box>,
      );
    }
  }
  // Orphaned tool calls (no parent_message_id, or anchor not in
  // current messages array). Rendered as a trailing block so nothing
  // is silently dropped — happens for legacy conversations from before
  // engine migration 0032 AND for live SSE streams where a tool_result
  // arrives before its parent message frame.
  //
  // Render-bucket choice is critical: orphan cards MUST go into
  // dynamicRows, not staticRows. Session 1222158a reproduced the
  // "✓ Endpoint check complete" appearing twice — once when the call
  // was orphan (parent message hadn't streamed yet) and again after
  // the message arrived and the call moved into callsByParent. Ink's
  // <Static> never un-flushes a row, so the first orphan render stays
  // on stdout while the new parented render is appended below it,
  // visually duplicating the card. Keeping orphan cards dynamic lets
  // them migrate into static cleanly under the parent on the next
  // re-render.
  if (orphanCalls.length > 0) {
    transcriptRows = dynamicRows;
    renderToolCallList(orphanCalls, "orphan");
    transcriptRows = staticRows;
  }

  // Welcome banner + starter actions + resume card are pushed ONCE into
  // the Static stream as the first scrollback rows. Ink's <Static> flushes
  // them to stdout and never re-invokes them; as the transcript grows they
  // scroll up out of the terminal naturally. Rendering them in the live
  // region (the previous behaviour) made the compact-mode chip float
  // between the scrolled-out transcript and the composer once the
  // committed history exceeded one screenful — the cause of the "banner
  // sitzt falsch" reflow visible in long sessions.
  // Setup-validation banner. Rendered as a one-line orange/red row
  // ABOVE the welcome panel so the operator sees a degraded engine
  // before they read the first tip. Visibility gated on:
  //   * setupSnapshot present and overall_status !== "ok"
  //   * persona can read /v1/diagnostics (admin or member)
  // Operators without `audit:read` / `identity:read` cannot meaningfully
  // act on the diagnostics endpoint, so we suppress the banner for
  // them — matches the existing `/setup` slash gating.
  const canShowSetupBanner =
    persona.probe.allows("audit:read") || persona.probe.allows("identity:read");
  const setupBannerNode =
    canShowSetupBanner && setupSnapshot && setupSnapshot.overall_status !== "ok"
      ? renderSetupBanner(setupSnapshot)
      : null;

  // Sticky version-skew banner: compares CLI VERSION to engine
  // /v1/status.version. Mismatch → operator sees a one-line hint
  // pointing at the rebuild command. Pre-fix this triage cost a
  // 2-cycle "why isn't my fix landing" debug session.
  const versionSkewNode = statusSnapshot
    ? (() => {
        const skew = classifyVersionSkew(CLI_VERSION, statusSnapshot.version);
        if (skew.severity === "match" || skew.severity === "dev_build") return null;
        return <VersionMismatchBanner snapshot={skew} />;
      })()
    : null;

  const welcomeRow = (
    <Box key="welcome" flexDirection="column">
      {versionSkewNode}
      {setupBannerNode}
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
      {pane?.kind === "onboarding-wizard" ? (
        <OnboardingWizard
          templates={pane.templates}
          onProbe={pane.onProbe}
          onSave={pane.onSave}
          onDone={(result) => {
            // Hand the terminal status back to the slash-handler hook
            // so it can log a notice if it wants, then dismiss the
            // pane. The wizard component itself does not own pane
            // lifecycle — that's the host's job.
            const { onComplete } = pane;
            onComplete(result);
            setPane(null);
            if (result.status === "saved") {
              showInfo("✓ Connector created — run /connectors list to see it");
            } else if (result.status === "skipped") {
              showInfo("onboarding skipped");
            } else {
              showInfo("onboarding cancelled");
            }
          }}
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

      {/* Validation errors — surfaced only when the turn is actually
          in a terminal failure state. Mid-turn iterations clear via
          the `tool_call_start` reducer reset; the block here stays
          for awaiting_input / completed / error so the user has the
          last word on what failed. Tone follows status: error → red
          (real failure), other → yellow (the LLM may still recover). */}
      {session.validationErrors.length > 0 &&
      (session.status === "error" ||
        session.status === "awaiting_input" ||
        session.status === "completed")
        ? (() => {
            // Pick a header that matches the *kind* of error. Pre-fix
            // every error landed under "validation errors" — so an
            // upstream-Anthropic quota reset to "validation errors ·
            // internal" left the operator hunting for a workflow bug
            // that didn't exist.
            const kinds = session.validationErrors.map((e) =>
              classifyEngineError({
                path: e.path,
                message: typeof e.message === "string" ? e.message : JSON.stringify(e.message),
              }),
            );
            const headerLabel = kinds.includes("provider_limit")
              ? "LLM provider limit"
              : kinds.includes("provider_unavailable")
                ? "LLM provider unavailable"
                : session.status === "error"
                  ? "validation errors"
                  : "draft validation";
            const tone = session.status === "error" ? "red" : "yellow";
            return (
              <Box flexDirection="column" marginBottom={1}>
                <Text color={tone} bold>
                  {headerLabel}
                </Text>
                {session.validationErrors.map((e, idx) => {
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
          })()
        : null}

      {/* Thinking spinner — surfaces the in-flight tool name so the
          user sees concrete progress instead of just "thinking…" for
          long turns. Pre-fix session 86de186b sat on "thinking…
          1m16s" while the engine ran build_workflow → validate_draft
          → dry_run_workflow with no visibility. */}
      {(() => {
        const running = session.toolCalls.find(
          (c) => c.status === "running" || c.status === "pending",
        );
        // Count tools that COMPLETED this turn (status done/failed)
        // so we can show "summarising N tool result(s)…" instead of
        // the rotating verb when the LLM is composing without an
        // active tool call.
        const completedThisTurn = session.toolCalls.filter(
          (c) => c.status === "done" || c.status === "failed",
        ).length;
        const failed = session.toolCalls.filter((c) => c.status === "failed");
        const lastFailure = failed[failed.length - 1];
        // Best-effort: pull `error_code` from the last failed tool's
        // result envelope. Surface it in the spinner so a long
        // recovery flow reads "5 tools failed (slug_already_in_use)"
        // instead of an opaque "summarising 5 tool results" — the
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
            turnTokens={session.usage?.turn_tokens ?? null}
            currentTool={running?.name ?? null}
            completedToolsThisTurn={running ? 0 : completedThisTurn}
            failedToolsThisTurn={failed.length}
            lastFailureCode={lastFailureCode}
          />
        );
      })()}

      {/* Activity ticker — single line above the composer telling the
          operator what the engine is doing right now (current tool,
          composing reply, idle after last tool). Engine emits
          `activity` TurnEvents at meaningful boundaries; the cli-core
          reducer drops them into `session.activity`; the component
          throttles re-renders at 250ms to avoid Ink flicker. Hidden
          when `busy` is false. */}
      <ActivityLine activity={session.activity} active={busy} />

      {/* Modal transcript pager — codex parity (Ctrl-P toggles).
          Renders every cell with full output and unabridged diffs.
          Returns null when closed; ESC inside it routes to onClose. */}
      <TranscriptPager
        open={pagerOpen}
        entries={pagerEntries}
        onClose={() => setPagerOpen(false)}
        rows={rows}
      />

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
        sessionTokens={session.sessionTotalTokens}
        tokensToday={statusSnapshot?.tokens_today ?? null}
        tokensMonth={statusSnapshot?.tokens_month ?? null}
        monthlyBudget={statusSnapshot?.monthly_budget_tokens ?? null}
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
