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

import {
  applyTurnEvent,
  initialSessionState,
  lastAssistantText,
  readSse,
  type SkSessionState,
  type TurnEvent,
} from "@cli-core/index.ts";
import type { ResolvedProfile } from "./config.ts";
import {
  type DebugCorrelationFields,
  debugLog,
  newDebugTurnId,
  serializeDebugError,
} from "./debug.ts";
import { EngineClient, SkEngineError, SkTransportError } from "./engine-client.ts";
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
  /** Disable SUBKIT.md injection. */
  noMemory?: boolean;
  /** Resume an existing conversation id instead of creating one. */
  resume?: string;
  /** Optional initial connector / workflow binding for a new conversation. */
  connector_id?: string;
  workflow_id?: string;
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
  if (err instanceof SkEngineError) {
    // 400/422 → exit 1 (validation). 401/403/404 → exit 2 (auth/not-found).
    const exit: 1 | 2 =
      err.status >= 400 && err.status < 500 && err.status !== 401 && err.status !== 403 ? 1 : 2;
    return { status: err.status, message: err.message, exit };
  }
  if (err instanceof SkTransportError) {
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

  // Handle --resume: append a user message to an existing conversation.
  // Otherwise create a new one with the prompt as `initial_message`.
  try {
    if (conversationId) {
      const appended = await client.appendConversationMessage(
        conversationId,
        {
          message: resolved.prompt,
          ...(memory.content ? { memory: memory.content } : {}),
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
    } else {
      const created = await client.createConversation(
        {
          initial_message: resolved.prompt,
          ...(memory.content ? { memory: memory.content } : {}),
          ...(opts.connector_id ? { connector_id: opts.connector_id } : {}),
          ...(opts.workflow_id ? { workflow_id: opts.workflow_id } : {}),
          ...(settings.merged.model ? { model: settings.merged.model } : {}),
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

  await readSse(streamResponse, (frame) => {
    debugLog("sse.frame", { event: frame.event, raw_data: frame.data }, traceContext());
    let ev: TurnEvent;
    try {
      ev = JSON.parse(frame.data) as TurnEvent;
    } catch (err) {
      debugLog(
        "dialog.error",
        {
          input_kind: "prompt",
          stage: "sse_frame_parse",
          raw_frame: frame.data,
          error: serializeDebugError(err),
        },
        traceContext(),
      );
      return;
    }
    if (typeof ev.type !== "string") return;
    debugLog("dialog.turn_event", { event: ev }, traceContext());
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
    if (text) writeLine(stdout, text);
    // Surface mention warnings for the operator.
    for (const w of resolved.warnings) stderr.write(`sk: ${w}\n`);
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
