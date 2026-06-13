// Headless runner for `sk -p "..."`.
//
// Takes a resolved profile, a prompt, and an output format, drives a
// single conversation turn end-to-end through the engine's
// /v1/conversations endpoints, and prints the result.
//
// Exit codes for `sk -p` and other headless `sk` entry points:
//   0 — completed cleanly
//   1 — engine returned an error (validation, bad request)
//   2 — auth / permission / network failure

import { isEngineError, isTransportError } from "@cli-core/errors.ts";
import {
  applyTurnEvent,
  initialSessionState,
  lastAssistantText,
  lastExecutionResult,
  readSse,
  renderExecutionOutput,
  type SkSessionState,
  type TurnEvent,
} from "@cli-core/index.ts";
import { uploadPath } from "./commands/files.ts";
import type { ResolvedProfile } from "./config.ts";
import {
  type DebugCorrelationFields,
  debugLog,
  isDebugVerbose,
  newDebugTurnId,
  serializeDebugError,
} from "./debug.ts";
import { EngineClient } from "./engine-client.ts";
import { loadMemory } from "./memory.ts";
import { resolveMentions } from "./mentions.ts";
import { saveSessionMetadata } from "./sessions.ts";
import { loadSettings } from "./settings.ts";

export type OutputFormat = "text" | "json" | "stream-json";

export interface HeadlessRunOptions {
  profile: ResolvedProfile;
  prompt: string;
  output: OutputFormat;
  /** Override for settings cwd (tests). */
  cwd?: string;
  /** Disable SK.md injection. */
  noMemory?: boolean;
  /** Resume an existing conversation id instead of creating one. */
  resume?: string;
  /** Optional initial connector / workflow binding for a new conversation. */
  connector_id?: string;
  workflow_id?: string;
  /** Optional per-turn engine step budget. */
  maxTurns?: number;
  /** Suppress non-critical human warnings on stderr. */
  quiet?: boolean;
  /**
   * Paths to upload + link as attachments BEFORE the prompt runs.
   * Each path is uploaded through `uploadPath`, linked to the
   * (possibly freshly minted) conversation with `role: "attachment"`,
   * and (under `--output stream-json`) a `{"file_attached": ...}`
   * line is emitted per file. A read / upload / link failure
   * short-circuits the whole turn — the prompt does not run with
   * partial attachments.
   */
  attach?: readonly string[];
  /** Optional writable sink — tests pass a memory buffer. */
  stdout?: { write: (s: string) => void };
  stderr?: { write: (s: string) => void };
}

export interface HeadlessRunResult {
  exitCode: 0 | 1 | 2;
  session: SkSessionState;
  conversation_id: string | null;
}

function writeLine(stream: { write: (s: string) => void } | undefined, line: string): void {
  (stream ?? process.stdout).write(`${line}\n`);
}

function sanitizeError(err: unknown): { status: number; message: string; exit: 1 | 2 } {
  if (isEngineError(err)) {
    // 400/422 → exit 1 (validation). 401/403/404 → exit 2 (auth/not-found).
    const exit: 1 | 2 =
      err.status >= 400 && err.status < 500 && err.status !== 401 && err.status !== 403 ? 1 : 2;
    return { status: err.status, message: err.message, exit };
  }
  if (isTransportError(err)) {
    return { status: 0, message: err.message, exit: 2 };
  }
  const msg = err instanceof Error ? err.message : String(err);
  return { status: 0, message: msg, exit: 2 };
}

/**
 * Run a single headless turn end-to-end. Returns the final session
 * state plus an exit code. Does NOT call process.exit so tests can
 * assert on the state.
 */
export async function runHeadless(opts: HeadlessRunOptions): Promise<HeadlessRunResult> {
  const stdout = opts.stdout ?? process.stdout;
  const stderr = opts.stderr ?? process.stderr;

  const cwd = opts.cwd ?? process.cwd();
  const settings = loadSettings(cwd);
  const includeMemoryFile = !opts.noMemory && settings.merged.includeMemoryFile !== false;
  const memory = loadMemory({
    cwd,
    include: includeMemoryFile,
    ...(settings.merged.maxInlineMentionBytes !== undefined
      ? { max_bytes: settings.merged.maxInlineMentionBytes }
      : {}),
  });

  const client = new EngineClient({
    engine_url: opts.profile.engine_url,
    api_key: opts.profile.api_key,
    tenant: opts.profile.active_tenant_id,
    user_agent: "sk-cli/0.0.1",
    debug_mode: "headless",
  });
  const turn_id = newDebugTurnId("headless");
  let conversationId: string | null = opts.resume ?? null;
  const traceContext = (): DebugCorrelationFields => ({
    mode: "headless",
    conversation_id: conversationId,
    turn_id,
  });
  debugLog(
    "dialog.turn_start",
    {
      input_kind: "prompt",
      raw_input: opts.prompt,
      output_format: opts.output,
      resume: opts.resume ?? null,
      connector_id: opts.connector_id ?? null,
      workflow_id: opts.workflow_id ?? null,
      memory_sources: memory.sources,
    },
    traceContext(),
  );

  let resolved: Awaited<ReturnType<typeof resolveMentions>>;
  try {
    resolved = await resolveMentions(opts.prompt, {
      cwd,
      additionalDirectories: settings.merged.additionalDirectories ?? [],
      ...(settings.merged.maxInlineMentionBytes !== undefined
        ? { maxBytes: settings.merged.maxInlineMentionBytes }
        : {}),
      client,
    });
    debugLog(
      "dialog.prompt_resolved",
      {
        raw_input: opts.prompt,
        resolved_prompt: resolved.prompt,
        artifacts: resolved.artifacts,
        warnings: resolved.warnings,
      },
      traceContext(),
    );
    for (const warning of resolved.warnings) {
      debugLog("dialog.warning", { warning }, traceContext());
    }
  } catch (err) {
    const e = sanitizeError(err);
    debugLog(
      "dialog.error",
      {
        input_kind: "prompt",
        stage: "mention_resolution",
        raw_input: opts.prompt,
        error: serializeDebugError(err),
      },
      traceContext(),
    );
    debugLog(
      "dialog.turn_end",
      { input_kind: "prompt", status: "error", exit_code: e.exit },
      traceContext(),
    );
    stderr.write(`sk: mention resolution failed: ${e.message}\n`);
    return {
      exitCode: e.exit,
      session: initialSessionState(null),
      conversation_id: null,
    };
  }
  const session = initialSessionState(conversationId);
  const attachPaths = opts.attach ?? [];
  const hasAttach = attachPaths.length > 0;

  // Handle --resume: append a user message to an existing conversation.
  // Otherwise create a new one with the prompt as `initial_message`.
  // When `--attach` is set we always create-then-append so file
  // links can be inserted between the two calls.
  try {
    if (conversationId) {
      if (hasAttach) {
        // Defer the append until after attachments are uploaded + linked.
      } else {
        const appended = await client.appendConversationMessage(
          conversationId,
          {
            message: resolved.prompt,
            ...(memory.content ? { memory: memory.content } : {}),
            ...(opts.maxTurns !== undefined ? { step_budget: opts.maxTurns } : {}),
          },
          traceContext(),
        );
        debugLog(
          "conversation.turn_events",
          {
            operation: "append_message",
            response_status: appended.status,
            events: appended.events,
          },
          traceContext(),
        );
      }
    } else {
      const created = await client.createConversation(
        {
          // With `--attach`, we skip the initial_message so the engine
          // doesn't start a turn before file links exist. The prompt
          // is appended after `attachFiles()` succeeds.
          ...(hasAttach ? {} : { initial_message: resolved.prompt }),
          ...(memory.content ? { memory: memory.content } : {}),
          ...(opts.connector_id ? { connector_id: opts.connector_id } : {}),
          ...(opts.workflow_id ? { workflow_id: opts.workflow_id } : {}),
          ...(settings.merged.model ? { model: settings.merged.model } : {}),
          ...(opts.maxTurns !== undefined ? { step_budget: opts.maxTurns } : {}),
        },
        traceContext(),
      );
      conversationId = created.conversation.id;
      session.conversationId = conversationId;
      debugLog(
        "conversation.turn_events",
        {
          operation: "create_conversation",
          response_status: created.status,
          events: created.events,
        },
        traceContext(),
      );
      // Cache the session locally so `sk -c` can reattach without a
      // round-trip. Wrapped in a try so filesystem errors never fail
      // the user's prompt.
      try {
        const now = new Date().toISOString();
        saveSessionMetadata({
          conversation_id: conversationId,
          engine_url: opts.profile.engine_url,
          tenant_id: opts.profile.active_tenant_id,
          title: created.conversation.title ?? null,
          model: created.conversation.model ?? null,
          created_at: now,
          last_used_at: now,
        });
      } catch {
        /* cache write is best-effort */
      }
    }
    if (conversationId) {
      try {
        saveSessionMetadata({
          conversation_id: conversationId,
          engine_url: opts.profile.engine_url,
          tenant_id: opts.profile.active_tenant_id,
          title: null,
          model: null,
          created_at: new Date().toISOString(),
          last_used_at: new Date().toISOString(),
        });
      } catch {
        /* ignore */
      }
    }
  } catch (err) {
    const e = sanitizeError(err);
    debugLog(
      "dialog.error",
      {
        input_kind: "prompt",
        stage: "conversation_write",
        error: serializeDebugError(err),
      },
      traceContext(),
    );
    debugLog(
      "dialog.turn_end",
      { input_kind: "prompt", status: "error", exit_code: e.exit },
      traceContext(),
    );
    stderr.write(`sk: ${e.message}\n`);
    return { exitCode: e.exit, session, conversation_id: conversationId };
  }

  // Upload + link every `--attach` before the prompt runs.
  // Stream-json emits `{"file_attached": fid, "filename": ...}` per
  // file; text/json modes report on stderr. Any upload/link error
  // short-circuits with ATTACH_FAILED so the prompt never runs
  // against a partial attachment set.
  if (hasAttach && conversationId) {
    try {
      for (const p of attachPaths) {
        const row = await uploadPath(client, p, { quiet: true });
        await client.linkFile(row.id, {
          resource_type: "conversation",
          resource_id: conversationId,
          role: "attachment",
        });
        debugLog(
          "conversation.turn_events",
          {
            operation: "attachment_linked",
            file_id: row.id,
            filename: row.filename,
            size_bytes: row.size_bytes,
          },
          traceContext(),
        );
        if (opts.output === "stream-json") {
          writeLine(stdout, JSON.stringify({ file_attached: row.id, filename: row.filename }));
        } else if (!opts.quiet) {
          stderr.write(`sk: attached ${row.id} (${row.filename})\n`);
        }
      }
      // Now that every file is linked, send the user prompt as the
      // first message of the turn. The SSE stream below picks it up.
      const appended = await client.appendConversationMessage(
        conversationId,
        {
          message: resolved.prompt,
          ...(memory.content ? { memory: memory.content } : {}),
          ...(opts.maxTurns !== undefined ? { step_budget: opts.maxTurns } : {}),
        },
        traceContext(),
      );
      debugLog(
        "conversation.turn_events",
        {
          operation: "append_message_after_attach",
          response_status: appended.status,
          events: appended.events,
        },
        traceContext(),
      );
    } catch (err) {
      debugLog(
        "dialog.error",
        {
          input_kind: "prompt",
          stage: "attach",
          error: serializeDebugError(err),
        },
        traceContext(),
      );
      const msg = err instanceof Error ? err.message : String(err);
      if (opts.output === "stream-json") {
        writeLine(stdout, JSON.stringify({ error: "ATTACH_FAILED", message: msg }));
      } else {
        stderr.write(`sk: attach failed: ${msg}\n`);
      }
      debugLog(
        "dialog.turn_end",
        { input_kind: "prompt", status: "error", exit_code: 1 },
        traceContext(),
      );
      return { exitCode: 1, session, conversation_id: conversationId };
    }
  }

  // Now open the SSE stream and fold its frames into the session.
  let streamState = session;
  let streamResponse: Response;
  try {
    streamResponse = await client.streamConversation(conversationId, traceContext());
  } catch (err) {
    const e = sanitizeError(err);
    debugLog(
      "dialog.error",
      {
        input_kind: "prompt",
        stage: "stream_open",
        error: serializeDebugError(err),
      },
      traceContext(),
    );
    debugLog(
      "dialog.turn_end",
      { input_kind: "prompt", status: "error", exit_code: e.exit },
      traceContext(),
    );
    stderr.write(`sk: stream open failed: ${e.message}\n`);
    return { exitCode: e.exit, session, conversation_id: conversationId };
  }

  const verbose = isDebugVerbose();
  let ssseParseErrorReported = false;
  await readSse(streamResponse, (frame) => {
    debugLog(
      "sse.frame",
      { event: frame.event, ...(verbose ? { raw_data: frame.data } : {}) },
      traceContext(),
    );
    let ev: TurnEvent;
    try {
      ev = JSON.parse(frame.data) as TurnEvent;
    } catch (err) {
      debugLog(
        "dialog.error",
        {
          input_kind: "prompt",
          stage: "sse_frame_parse",
          ...(verbose ? { raw_frame: frame.data } : {}),
          error: serializeDebugError(err),
        },
        traceContext(),
      );
      if (!ssseParseErrorReported) {
        ssseParseErrorReported = true;
        stderr.write("sk: malformed SSE frame — see ~/.sk/debug.log for details\n");
      }
      return;
    }
    if (typeof ev.type !== "string") return;
    debugLog(
      "dialog.turn_event",
      verbose ? { event: ev } : { event_type: ev.type },
      traceContext(),
    );
    // stream-json: one JSON object per frame on stdout, unbuffered.
    if (opts.output === "stream-json") {
      writeLine(stdout, JSON.stringify(ev));
    }
    streamState = applyTurnEvent(streamState, ev);
  });
  debugLog("sse.close", { final_status: streamState.status }, traceContext());

  // After the stream closes, format the final result for text / json.
  const assistantText = lastAssistantText(streamState);
  if (opts.output === "text") {
    const text = assistantText.trim();
    if (text) {
      writeLine(stdout, text);
    } else {
      // Tool-only turn: the model ran the work but produced no prose
      // (production sessions saw `sk -p "run X and show results"` exit
      // SILENTLY while the data sat in toolCalls[].result). Render the
      // last succeeded execution payload so text mode always answers.
      const exec = lastExecutionResult(streamState);
      if (exec) writeLine(stdout, renderExecutionOutput(exec));
    }
    // Surface mention warnings for the operator.
    if (!opts.quiet) {
      for (const w of resolved.warnings) stderr.write(`sk: ${w}\n`);
    }
  } else if (opts.output === "json") {
    const payload = {
      session_id: conversationId,
      status: streamState.status,
      assistant_text: assistantText,
      messages: streamState.messages,
      tool_calls: streamState.toolCalls,
      // Surface the open askUser.* elicitation (if any) so scripted
      // consumers can POST to `/elicitations/:id/respond` without
      // having to re-parse the event stream themselves.
      pending_elicitation: streamState.pendingElicitation,
      committed_workflow_id: streamState.committedWorkflowId,
      validation_errors: streamState.validationErrors,
      usage: streamState.usage,
      warnings: resolved.warnings,
      memory_sources: memory.sources,
    };
    writeLine(stdout, JSON.stringify(payload, null, 2));
  }

  const exit: 0 | 1 | 2 = streamState.status === "error" ? 1 : 0;
  debugLog(
    "dialog.render_output",
    {
      output_format: opts.output,
      assistant_text: assistantText,
      messages: streamState.messages,
      tool_calls: streamState.toolCalls,
      pending_elicitation: streamState.pendingElicitation,
      validation_errors: streamState.validationErrors,
      usage: streamState.usage,
      warnings: resolved.warnings,
    },
    traceContext(),
  );
  debugLog(
    "dialog.turn_end",
    {
      input_kind: "prompt",
      status: streamState.status,
      exit_code: exit,
      assistant_text: assistantText,
      message_count: streamState.messages.length,
      tool_call_count: streamState.toolCalls.length,
      validation_error_count: streamState.validationErrors.length,
      pending_elicitation: streamState.pendingElicitation,
      usage: streamState.usage,
    },
    traceContext(),
  );
  return { exitCode: exit, session: streamState, conversation_id: conversationId };
}
