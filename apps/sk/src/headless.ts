import { isEngineError, isTransportError } from "@cli-core/errors.ts";
import {
  applyTurnEvent,
  errorFrameToEvents,
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
import { formatCitationsFooter, terminalAssistantCitations } from "./lib/citations-footer.ts";
import { loadMemory } from "./memory.ts";
import { resolveMentions } from "./mentions.ts";
import { humanizeValidationError } from "./repl/error-humanize.ts";
import { saveSessionMetadata } from "./sessions.ts";
import { loadSettings } from "./settings.ts";

export type OutputFormat = "text" | "json" | "stream-json";

const UUID_RE = /^[0-9a-f]{8}-[0-9a-f]{4}-[1-5][0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/i;

interface HeadlessRunOptions {
  profile: ResolvedProfile;
  prompt: string;
  output: OutputFormat;
  cwd?: string;
  noMemory?: boolean;
  resume?: string;
  connector_id?: string;
  workflow_id?: string;
  maxTurns?: number;
  quiet?: boolean;
  attach?: readonly string[];
  stdout?: { write: (s: string) => void };
  stderr?: { write: (s: string) => void };
}

interface HeadlessRunResult {
  exitCode: 0 | 1 | 2;
  session: SkSessionState;
  conversation_id: string | null;
}

function writeLine(stream: { write: (s: string) => void } | undefined, line: string): void {
  (stream ?? process.stdout).write(`${line}\n`);
}

function formatTurnErrors(errors: SkSessionState["validationErrors"]): string {
  return errors
    .map((e) => {
      const h = humanizeValidationError(e);
      const detail = h.detail && h.detail !== h.label ? ` — ${h.detail}` : "";
      const hint = h.hint ? `\n  ↳ ${h.hint}` : "";
      return `sk: ${h.label}${detail}${hint}`;
    })
    .join("\n");
}

function attachmentSlug(filename: string): string | null {
  const slug = filename
    .toLowerCase()
    .replace(/[^a-z0-9_-]+/g, "-")
    .replace(/^[-_]+/, "")
    .slice(0, 63);
  return /^[a-z0-9]/.test(slug) ? slug : null;
}

function sanitizeError(err: unknown): { status: number; message: string; exit: 1 | 2 } {
  if (isEngineError(err)) {
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

function readStringField(row: Record<string, unknown>, key: string): string | null {
  const value = row[key];
  return typeof value === "string" && value.length > 0 ? value : null;
}

function matchesSelector(row: Record<string, unknown>, selector: string): boolean {
  return (
    readStringField(row, "id") === selector ||
    readStringField(row, "slug") === selector ||
    readStringField(row, "name") === selector ||
    readStringField(row, "display_name") === selector
  );
}

function hydratePersistedMessages(
  session: SkSessionState,
  messages: Array<{ id: string; role: string; parts: unknown[] }>,
): SkSessionState {
  let hydrated = session;
  for (const message of messages) {
    if (
      message.role !== "user" &&
      message.role !== "assistant" &&
      message.role !== "system" &&
      message.role !== "tool"
    ) {
      continue;
    }
    hydrated = applyTurnEvent(hydrated, {
      type: "message",
      role: message.role,
      content: message.parts,
      id: message.id,
    });
  }
  return hydrated;
}

async function resolveResourceSelector(
  client: EngineClient,
  kind: "connector" | "workflow",
  selector: string,
): Promise<string> {
  if (UUID_RE.test(selector)) return selector;

  const page =
    kind === "connector"
      ? await client.listConnectors({ limit: 100 })
      : await client.listWorkflows({ limit: 100 });
  const matches = page.items.filter((row) => matchesSelector(row, selector));
  if (matches.length === 1) {
    const id = readStringField(matches[0]!, "id");
    if (id && UUID_RE.test(id)) return id;
  }

  if (matches.length > 1) {
    throw new Error(`${kind} selector '${selector}' matched ${matches.length} resources`);
  }
  throw new Error(`${kind} '${selector}' was not found`);
}

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
  let connectorId = opts.connector_id;
  let workflowId = opts.workflow_id;
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
      connector_id: connectorId ?? null,
      workflow_id: workflowId ?? null,
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
        references: resolved.references,
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
  let session = initialSessionState(conversationId);
  const attachPaths = opts.attach ?? [];
  const hasAttach = attachPaths.length > 0;
  let streamResponse: Response | null = null;

  try {
    if (!conversationId && connectorId) {
      connectorId = await resolveResourceSelector(client, "connector", connectorId);
    }
    if (!conversationId && workflowId) {
      workflowId = await resolveResourceSelector(client, "workflow", workflowId);
    }
  } catch (err) {
    const e = sanitizeError(err);
    debugLog(
      "dialog.error",
      {
        input_kind: "prompt",
        stage: "binding_resolution",
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

  try {
    if (conversationId) {
      const detail = await client.getConversation(conversationId);
      session = hydratePersistedMessages(session, detail.messages);
      if (hasAttach) {
      } else {
        streamResponse = await client.appendConversationMessageStream(
          conversationId,
          {
            message: resolved.prompt,
            ...(resolved.references.length > 0 ? { references: resolved.references } : {}),
            ...(memory.content ? { memory: memory.content } : {}),
            ...(opts.maxTurns !== undefined ? { step_budget: opts.maxTurns } : {}),
          },
          traceContext(),
        );
        debugLog(
          "conversation.turn_events",
          {
            operation: "append_message",
            transport: "sse",
          },
          traceContext(),
        );
      }
    } else if (hasAttach) {
      const created = await client.createConversation(
        {
          ...(memory.content ? { memory: memory.content } : {}),
          ...(connectorId ? { connector_id: connectorId } : {}),
          ...(workflowId ? { workflow_id: workflowId } : {}),
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
      } catch {}
    } else {
      streamResponse = await client.createConversationStream(
        {
          initial_message: resolved.prompt,
          ...(resolved.references.length > 0 ? { references: resolved.references } : {}),
          ...(memory.content ? { memory: memory.content } : {}),
          ...(connectorId ? { connector_id: connectorId } : {}),
          ...(workflowId ? { workflow_id: workflowId } : {}),
          ...(settings.merged.model ? { model: settings.merged.model } : {}),
          ...(opts.maxTurns !== undefined ? { step_budget: opts.maxTurns } : {}),
        },
        traceContext(),
      );
      debugLog(
        "conversation.turn_events",
        { operation: "create_conversation", transport: "sse" },
        traceContext(),
      );
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
      } catch {}
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

  if (hasAttach && conversationId) {
    try {
      for (const p of attachPaths) {
        const row = await uploadPath(client, p, { quiet: true });
        const slug = attachmentSlug(row.filename);
        try {
          await client.linkFile(row.id, {
            resource_type: "conversation",
            resource_id: conversationId,
            role: "attachment",
            ...(slug ? { slug } : {}),
          });
        } catch {
          await client.linkFile(row.id, {
            resource_type: "conversation",
            resource_id: conversationId,
            role: "attachment",
          });
        }
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
          writeLine(
            stdout,
            JSON.stringify({
              file_attached: row.id,
              filename: row.filename,
              ...(slug ? { slug } : {}),
            }),
          );
        } else if (!opts.quiet) {
          const mention = slug ? ` — reference it as @attachment:${slug}` : "";
          stderr.write(`sk: attached ${row.id} (${row.filename})${mention}\n`);
        }
      }
      streamResponse = await client.appendConversationMessageStream(
        conversationId,
        {
          message: resolved.prompt,
          ...(resolved.references.length > 0 ? { references: resolved.references } : {}),
          ...(memory.content ? { memory: memory.content } : {}),
          ...(opts.maxTurns !== undefined ? { step_budget: opts.maxTurns } : {}),
        },
        traceContext(),
      );
      debugLog(
        "conversation.turn_events",
        {
          operation: "append_message_after_attach",
          transport: "sse",
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

  let streamState = session;
  let terminalEvent: TurnEvent | null = null;
  if (!streamResponse) {
    stderr.write("sk: turn stream was not opened\n");
    return { exitCode: 2, session, conversation_id: conversationId };
  }

  const verbose = isDebugVerbose();
  let ssseParseErrorReported = false;
  await readSse(streamResponse, (frame) => {
    debugLog(
      "sse.frame",
      { event: frame.event, ...(verbose ? { raw_data: frame.data } : {}) },
      traceContext(),
    );
    if (frame.event === "conversation_started") {
      try {
        const started = JSON.parse(frame.data) as {
          conversation: { id: string; title: string | null; model: string | null };
        };
        conversationId = started.conversation.id;
        session.conversationId = conversationId;
        streamState.conversationId = conversationId;
        const now = new Date().toISOString();
        saveSessionMetadata({
          conversation_id: conversationId,
          engine_url: opts.profile.engine_url,
          tenant_id: opts.profile.active_tenant_id,
          title: started.conversation.title ?? null,
          model: started.conversation.model ?? null,
          created_at: now,
          last_used_at: now,
        });
      } catch (err) {
        debugLog(
          "dialog.error",
          {
            input_kind: "prompt",
            stage: "conversation_started_parse",
            error: serializeDebugError(err),
          },
          traceContext(),
        );
      }
      return true;
    }
    if (frame.event === "outcome") return false;
    if (frame.event === "error") {
      let payload: { code: string; message: string; details?: unknown };
      try {
        payload = JSON.parse(frame.data) as { code: string; message: string; details?: unknown };
      } catch (err) {
        debugLog(
          "dialog.error",
          {
            input_kind: "prompt",
            stage: "sse_error_frame_parse",
            ...(verbose ? { raw_frame: frame.data } : {}),
            error: serializeDebugError(err),
          },
          traceContext(),
        );
        payload = { code: "error", message: frame.data };
      }
      for (const synthetic of errorFrameToEvents(payload)) {
        debugLog(
          "dialog.turn_event",
          verbose ? { event: synthetic } : { event_type: synthetic.type },
          traceContext(),
        );
        if (opts.output === "stream-json") {
          writeLine(stdout, JSON.stringify(synthetic));
        }
        streamState = applyTurnEvent(streamState, synthetic);
      }
      return false;
    }
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
      return true;
    }
    if (typeof ev.type !== "string") return true;
    debugLog(
      "dialog.turn_event",
      verbose ? { event: ev } : { event_type: ev.type },
      traceContext(),
    );
    if (opts.output === "stream-json" && ev.type !== "completed") {
      writeLine(stdout, JSON.stringify(ev));
    }
    streamState = applyTurnEvent(streamState, ev);
    if (ev.type === "completed") terminalEvent = ev;
    return true;
  });
  if (opts.output === "stream-json" && terminalEvent && streamState.status !== "error") {
    writeLine(stdout, JSON.stringify(terminalEvent));
  }
  debugLog("sse.close", { final_status: streamState.status }, traceContext());

  const assistantText = lastAssistantText(streamState);
  if (opts.output === "text") {
    const text = assistantText.trim();
    const turnErrors = streamState.status === "error" ? streamState.validationErrors : [];
    if (turnErrors.length > 0) {
      stderr.write(`${formatTurnErrors(turnErrors)}\n`);
    }
    if (text) {
      writeLine(stdout, text);
      const footer = formatCitationsFooter(terminalAssistantCitations(streamState.messages));
      if (footer) writeLine(stdout, footer);
    } else if (turnErrors.length === 0) {
      const exec = lastExecutionResult(streamState);
      if (exec) {
        writeLine(stdout, renderExecutionOutput(exec));
      } else {
        const calls = streamState.toolCalls;
        if (calls.length === 0) {
          writeLine(
            stdout,
            `sk: the turn produced no answer and made no tool call (status: ${streamState.status})`,
          );
        } else {
          const names = calls.map((c) => c.name).join(", ");
          const tail =
            streamState.status === "awaiting_input"
              ? "it is waiting for a confirmation that text mode cannot give — continue in the REPL (sk) or approve it in the Cockpit"
              : `status: ${streamState.status}`;
          writeLine(stdout, `sk: no answer text; ${calls.length} tool call(s): ${names} — ${tail}`);
        }
      }
    }
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
