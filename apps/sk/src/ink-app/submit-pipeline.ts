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
import { findSlashCommand, type PersonaProbe, renderHelp } from "../slash.ts";
import type { NotifyPrefs, PushNotifyOverride } from "./types.ts";

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
  const turnStartedAt = Date.now();
  let notifyTitle = "subkit";
  let next: SkSessionState = {
    ...base,
    ...(conversationId !== undefined ? { conversationId } : {}),
  };
  setSession(next);
  for await (const ev of events) {
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
  const elapsedMs = Date.now() - turnStartedAt;
  if (nextCommandPreviewEnabled && next.nextSuggestion) {
    const { suggestion, kind } = next.nextSuggestion;
    setInput((prev) => applyInput(prev, { type: "ghostSet", text: suggestion, kind }));
  }
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
    quietHours: () =>
      isOsDoNotDisturb() ||
      inQuietHoursWindow(prefs?.quietHoursStart ?? "", prefs?.quietHoursEnd ?? "", new Date()),
  });
  return next;
}

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
  runBuiltin: (trimmed: string) => Promise<boolean>;
}

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
  if (onSlash) {
    try {
      const response = await onSlash(cmd.name, trimmed, setPane, session);
      if (response) showInfo(response);
    } catch (err) {
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

export interface PreparedPrompt {
  finalPrompt: string;
  consumedIds: ExpandedPrompt["consumedIds"];
}

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
  const {
    prompt: expandedRefsPrompt,
    attachmentPaths,
    consumedIds,
  } = expandRefs(trimmed, pasteStore);
  let finalPrompt =
    attachmentPaths.length > 0
      ? `${expandedRefsPrompt}${attachmentPaths.map((p) => ` @${p}`).join("")}`
      : expandedRefsPrompt;

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
      setTimeout(() => {
        resubmit(nextQueued);
      }, 0);
    }
  }
}
