// Submit pipeline for the Ink REPL.
//
// The pure / near-pure phases of driving a turn, extracted from the
// app's `handleSubmit` orchestrator:
//
//   * runEventStream            — consume the engine TurnEvent stream,
//                                 reduce it into session state, fire
//                                 the post-turn push notification
//   * dispatchSlashSubmit       — the composer's slash-command router
//   * showPendingElicitationHint— structured-only elicitation gate
//   * warnIfUnresolvedConfirmIntent — phantom-confirmation forensics
//   * preparePromptForEngine    — paste-ref expansion + local-path
//                                 auto-upload + length ceiling
//   * drainQueueOrHold          — post-turn FIFO drain (never past an
//                                 open dialog)

import type { PendingElicitation, SkSessionState, TurnEvent } from "@cli-core/index.ts";
import { applyTurnEvent, lastAssistantText } from "@cli-core/index.ts";
import type React from "react";
import { debugLog, serializeDebugError } from "../debug.ts";
import { looksLikeAssistantConfirmRequest } from "../elicitation-intent.ts";
import type { EngineClient } from "../engine-client.ts";
import { autoUploadLocalPaths } from "../lib/path-preprocessor.ts";
import { apply as applyInput, type InputBuffer } from "../repl/input-buffer.ts";
import {
  inQuietHoursWindow,
  isOsDoNotDisturb,
  NOTIFY_DEFAULTS,
  notify,
} from "../repl/notifications/index.ts";
import {
  type ExpandedPrompt,
  expandRefs,
  MAX_USER_INPUT_TEXT_CHARS,
  type PasteStore,
} from "../repl/paste-store.ts";
import type { CommandQueue } from "../repl/queue.ts";
import type { PaneSpec } from "../repl/slash/handler.ts";
import { REVIEW_LEARNINGS_STARTER_PROMPT } from "../repl/task-actions.ts";
import { findSlashCommand, type PersonaProbe, renderHelp } from "../slash.ts";
import type { NotifyPrefs, PushNotifyOverride } from "./types.ts";

// -------- Event-stream consumption --------

export interface RunEventStreamOptions {
  base: SkSessionState;
  events: AsyncIterable<TurnEvent> | undefined;
  conversationId: string | null | undefined;
  setSession: (next: SkSessionState) => void;
  setInput: React.Dispatch<React.SetStateAction<InputBuffer>>;
  nextCommandPreviewEnabled: boolean;
  prefs: NotifyPrefs | undefined;
  pushNotifyOverride: PushNotifyOverride | undefined;
}

export async function runEventStream(opts: RunEventStreamOptions): Promise<SkSessionState> {
  const {
    base,
    events,
    conversationId,
    setSession,
    setInput,
    nextCommandPreviewEnabled,
    prefs,
    pushNotifyOverride,
  } = opts;
  if (!events) return base;
  // Record the turn start so we can decide whether to ring an OS
  // notification when the stream completes. Opt-in via
  // SK_PUSH_NOTIFY=1; threshold via SK_PUSH_NOTIFY_THRESHOLD_MS
  // (defaults to NOTIFY_DEFAULTS.thresholdMs = 30s). The env vars
  // are read once at REPL boot and passed in via
  // `pushNotifyOverride` so a mid-REPL `export` cannot silently
  // change behavior.
  const turnStartedAt = Date.now();
  let notifyTitle = "subkit";
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
  // Stream completed — fire a push notification when the turn took
  // long enough and the operator opted in. notify() itself no-ops
  // when stdout isn't a TTY (e.g. piped output, CI), so this is
  // safe to call unconditionally.
  // Primary read is the engine-resolved prefs
  // (notifications.push.*); env vars survive as a per-process
  // override so tests / one-shot operator switches don't need a
  // setSetting round-trip.
  const elapsedMs = Date.now() - turnStartedAt;
  // Stream finished — if the engine emitted a non-null next-message
  // suggestion, paint it as ghost text in the composer. The reducer
  // refuses to attach a ghost when the buffer is non-empty (operator
  // is mid-edit), so this is safe to fire unconditionally; it just
  // no-ops when inappropriate. The settings gate trumps everything:
  // operators who disabled the feature in `~/.sk/settings.json`
  // (`nextCommandPreviewEnabled: false`) never see a ghost.
  if (nextCommandPreviewEnabled && next.nextSuggestion) {
    const { suggestion, kind } = next.nextSuggestion;
    setInput((prev) => applyInput(prev, { type: "ghostSet", text: suggestion, kind }));
  }
  // Resolution order: per-process override (boot-time env read) →
  // engine-resolved prefs → built-in defaults. The override is
  // populated once at REPL start, so a mid-REPL `export
  // SK_PUSH_NOTIFY=...` does not silently flip behavior.
  const enabled =
    pushNotifyOverride?.enabled !== undefined
      ? pushNotifyOverride.enabled
      : (prefs?.pushNotifyEnabled ?? false);
  const thresholdMs =
    pushNotifyOverride?.thresholdMs !== undefined && pushNotifyOverride.thresholdMs > 0
      ? pushNotifyOverride.thresholdMs
      : prefs?.pushNotifyThresholdSec && prefs.pushNotifyThresholdSec > 0
        ? prefs.pushNotifyThresholdSec * 1000
        : NOTIFY_DEFAULTS.thresholdMs;
  const lastAssistant = lastAssistantText(next);
  if (lastAssistant && lastAssistant.length > 0) {
    notifyTitle = lastAssistant.length > 80 ? `${lastAssistant.slice(0, 77)}…` : lastAssistant;
  }
  notify(`subkit · turn complete`, notifyTitle, elapsedMs, {
    enabled,
    thresholdMs,
    // OS DND wins over the configured quiet-hours window. When DND
    // can't be probed reliably (other OS, missing tooling), the
    // probe returns false and we fall back to the time-window
    // setting alone.
    quietHours: () =>
      isOsDoNotDisturb() ||
      inQuietHoursWindow(prefs?.quietHoursStart ?? "", prefs?.quietHoursEnd ?? "", new Date()),
  });
  // Return the final state so callers can make a decision on the
  // turn's *resolved* session (e.g. "did a dialog open?") without
  // waiting for the post-commit effect that syncs the mirror ref.
  return next;
}

// -------- Slash dispatch --------

export interface SlashDispatchContext {
  session: SkSessionState;
  busyRef: React.MutableRefObject<boolean>;
  personaProbe: PersonaProbe;
  personaLabel: string;
  exit: () => void;
  onExit: (() => void) | undefined;
  onSlash:
    | ((
        name: string,
        raw: string,
        openPane: (spec: PaneSpec) => void,
        liveSession: SkSessionState,
      ) => Promise<string | null>)
    | undefined;
  hasElicitHandler: boolean;
  setPane: (spec: PaneSpec) => void;
  showInfo: (message: string) => void;
  showError: (message: string) => void;
  showStructuredError: (err: unknown, slashName?: string) => void;
  respondElicitation: (elicitationId: string, output: unknown, reason?: string) => Promise<void>;
  runYoloSlash: (trimmed: string, hasPendingElicitation: boolean) => void;
  /** Built-in slash commands ink-app owns (paste, queue, history, …). */
  runBuiltin: (trimmed: string) => Promise<boolean>;
  /** Re-enters the submit path with a plain prompt — the same route a
   *  prompt-kind TaskAction takes. Used by thin prompt-dispatch slashes
   *  (/learnings) after the registry's RBAC gate has passed. */
  submitPrompt: (prompt: string) => void;
}

/**
 * Routes a slash-shaped submission. Returns true when the input was
 * consumed (dispatched, rejected, or errored) and must not reach the
 * engine as a plain prompt. Path-shaped unknown slashes (`/tmp/x.pdf`,
 * `./doc.md`) fall through so the plain-prompt path can treat them as
 * file mentions.
 */
export async function dispatchSlashSubmit(
  trimmed: string,
  ctx: SlashDispatchContext,
): Promise<boolean> {
  const {
    session,
    busyRef,
    personaProbe,
    personaLabel,
    exit,
    onExit,
    onSlash,
    hasElicitHandler,
    setPane,
    showInfo,
    showError,
    showStructuredError,
    respondElicitation,
    runYoloSlash,
    runBuiltin,
    submitPrompt,
  } = ctx;
  if (trimmed === "/exit" || trimmed === "/quit") {
    exit();
    onExit?.();
    return true;
  }
  const slashHead = trimmed.startsWith("/") ? (trimmed.split(/\s+/)[0] ?? "") : "";
  const pathShapedUnknownSlash =
    slashHead.length > 0 &&
    !findSlashCommand(slashHead) &&
    (slashHead.slice(1).includes("/") ||
      /^\/[^/]+\.[A-Za-z0-9][A-Za-z0-9_-]{0,15}$/.test(slashHead) ||
      slashHead.startsWith("~/") ||
      slashHead.startsWith("./"));
  if (!(trimmed.startsWith("/") && !pathShapedUnknownSlash)) return false;
  // Built-in slash commands that ink-app owns (paste, queue,
  // history). Short-circuit so the host's `onSlash`
  // doesn't see them.
  if (await runBuiltin(trimmed)) return true;
  const head = trimmed.split(/\s+/)[0] ?? "";
  const cmd = findSlashCommand(head);
  if (!cmd) {
    showError(`unknown slash: ${trimmed}`);
    return true;
  }
  if (cmd.requires && !personaProbe.allows(cmd.requires)) {
    showError(`sk: /${cmd.name} requires ${cmd.requires} (not granted)`);
    return true;
  }
  if (cmd.name === "help") {
    const helpLines = renderHelp(personaProbe).split("\n");
    const [title = "slash commands", ...body] = helpLines;
    setPane({
      kind: "text",
      title: title.trim(),
      subtitle: personaLabel,
      lines: body,
    });
    return true;
  }
  if (cmd.name === "approve" || cmd.name === "reject") {
    if (!hasElicitHandler) {
      showError("no pending elicitation");
      return true;
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
      return true;
    }
    if (!session.pendingElicitation) {
      showInfo(
        session.status === "running"
          ? `no pending ${cmd.name === "approve" ? "approval" : "rejection"} — engine is still running`
          : `no pending ${cmd.name === "approve" ? "approval" : "rejection"}`,
      );
      return true;
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
    // Operator-typed free text is user feedback — it travels in
    // the `output` payload. The wire `reason` only ever carries
    // the stable `user_declined` machine-code token.
    const feedback = !confirmed && reasonTokens.length > 0 ? reasonTokens.join(" ") : undefined;
    await respondElicitation(
      elicitationId,
      { confirmed, ...(feedback ? { feedback } : {}) },
      confirmed ? undefined : "user_declined",
    );
    return true;
  }
  if (cmd.name === "yolo") {
    runYoloSlash(trimmed, session.pendingElicitation !== null);
    return true;
  }
  if (cmd.name === "learnings") {
    // Thin prompt dispatch — same starter prompt the review-learnings
    // TaskAction submits, so slash and starter action can't diverge. The
    // registry's `requires: "skill:read"` gate above already ran.
    submitPrompt(REVIEW_LEARNINGS_STARTER_PROMPT);
    return true;
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
      showStructuredError(err, cmd.name);
    }
  }
  return true;
}

// -------- Pending-elicitation routing — structured-only confirmation --------
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
// confirm) was fragile and surfaced silent false-positives. We
// forward the user to the structured component instead. Slash
// commands (/approve,
// /reject, /respond, /cancel) remain available for explicit
// CLI-only flows.

export function showPendingElicitationHint(
  pendingElicitation: PendingElicitation,
  trimmed: string,
  busy: boolean,
  showInfo: (message: string) => void,
): void {
  debugLog(
    "dialog.elicitation_routing",
    {
      elicitation_id: pendingElicitation.id,
      ...(pendingElicitation.tool_call_id ? { tool_call_id: pendingElicitation.tool_call_id } : {}),
      pending_tool: pendingElicitation.tool_name,
      classified_intent: "structured_only",
      input_excerpt: trimmed.length > 80 ? `${trimmed.slice(0, 80)}…` : trimmed,
    },
    {},
  );
  if (busy) {
    showInfo("answer already sent — engine is executing, hang tight");
    return;
  }
  const tool = pendingElicitation.tool_name;
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
}

// -------- Phantom-confirmation forensics --------

// Forensic event: any prompt that reaches the plain-prompt branch with
// a recently-emitted "Reply 'yes'"-style assistant message but no
// pending elicitation is almost certainly hitting the silent
// failure mode where the engine asked for confirmation in prose
// without actually emitting an elicit_request. Surface a loud
// warning so the operator knows the next "yes" will become a
// phantom new prompt instead of an approval.
export function warnIfUnresolvedConfirmIntent(
  session: SkSessionState,
  trimmed: string,
  showError: (message: string) => void,
): void {
  const lastAssistantTextValue = lastAssistantText(session);
  const hadRecentUnresolvedIntent =
    session.pendingElicitation === null && looksLikeAssistantConfirmRequest(lastAssistantTextValue);
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
}

// -------- Prompt preparation --------

export interface PreparedPrompt {
  finalPrompt: string;
  consumedIds: ExpandedPrompt["consumedIds"];
}

/**
 * Expand paste-store refs back inline, fan out image / file refs as
 * `@path` mentions so the existing mention resolver can attach their
 * contents, auto-ingest local filesystem paths, and enforce the
 * length ceiling. Returns `null` when the prompt exceeds the ceiling
 * (the error notice has already fired).
 */
export async function preparePromptForEngine(opts: {
  trimmed: string;
  pasteStore: PasteStore;
  engineClient: EngineClient | undefined;
  cwd: string | undefined;
  conversationId: string | null;
  showInfo: (message: string) => void;
  showError: (message: string) => void;
}): Promise<PreparedPrompt | null> {
  const { trimmed, pasteStore, engineClient, cwd, conversationId, showInfo, showError } = opts;
  // Expand paste-store refs back inline, fan out image / file
  // refs as `@path` mentions so the existing mention resolver can
  // attach their contents. This runs before local path preprocessing
  // so a pasted path hidden behind a paste-ref is still detected.
  const {
    prompt: expandedRefsPrompt,
    attachmentPaths,
    consumedIds,
  } = expandRefs(trimmed, pasteStore);
  let finalPrompt =
    attachmentPaths.length > 0
      ? `${expandedRefsPrompt}${attachmentPaths.map((p) => ` @${p}`).join("")}`
      : expandedRefsPrompt;

  // Auto-ingest local filesystem paths from the expanded prompt.
  // The user-facing transcript keeps `trimmed`; this branch only
  // prepares the engine payload.
  if (engineClient) {
    try {
      const result = await autoUploadLocalPaths(
        finalPrompt,
        engineClient,
        cwd ?? process.cwd(),
        conversationId,
      );
      finalPrompt = result.rewritten;
      for (const f of result.inlined) {
        showInfo(`read ${f.filename} (${f.bytes} bytes)`);
      }
      for (const u of result.uploaded) {
        showInfo(`attached ${u.filename} (${u.bytes} bytes)`);
      }
      for (const s of result.skipped) {
        if (s.reason === "upload_failed") {
          showError(`file upload failed for ${s.raw}: ${s.detail ?? ""}`);
        } else if (s.reason === "read_failed") {
          showError(`file read failed for ${s.raw}: ${s.detail ?? ""}`);
        }
      }
    } catch (err) {
      showError(`local path preprocessor: ${err instanceof Error ? err.message : String(err)}`);
    }
  }
  finalPrompt = expandRefs(finalPrompt, pasteStore).prompt;

  const finalPromptChars = [...finalPrompt].length;
  if (finalPromptChars > MAX_USER_INPUT_TEXT_CHARS) {
    showError(
      `Message exceeds the maximum length of ${MAX_USER_INPUT_TEXT_CHARS} characters (${finalPromptChars} provided).`,
    );
    return null;
  }
  return { finalPrompt, consumedIds };
}

// -------- Post-turn queue drain --------

/**
 * Drain the queue — one prompt at a time. But NOT past an open
 * dialog: if this turn ended awaiting an elicitation, hold the
 * queue. Flushing a queued prompt here would race the engine's
 * pending elicitation and get rejected (`pending_elicitation_blocked`).
 * The elicit-response handler drains the queue once the dialog
 * is answered.
 */
export function drainQueueOrHold(opts: {
  openedElicitation: boolean;
  pendingElicitationRef: React.MutableRefObject<boolean>;
  queue: CommandQueue;
  setQueuedCount: (n: number) => void;
  showInfo: (message: string) => void;
  resubmit: (raw: string) => void;
}): void {
  const { openedElicitation, pendingElicitationRef, queue, setQueuedCount, showInfo, resubmit } =
    opts;
  if (openedElicitation || pendingElicitationRef.current) {
    if (queue.length > 0) {
      showInfo(`${queue.length} queued — answer the dialog above, then they run`);
    }
  } else {
    const nextQueued = queue.dequeue();
    setQueuedCount(queue.length);
    if (nextQueued) {
      // Defer to let React flush the `busy=false` frame before
      // we start the next turn.
      setTimeout(() => {
        resubmit(nextQueued);
      }, 0);
    }
  }
}
