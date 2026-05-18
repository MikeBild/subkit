// Minimal line-based REPL for `sk`.
//
// Ships v1 as a readline loop rather than an Ink rich UI because
// readline gives us a usable interactive surface without dragging
// in React + ink + ink-markdown for the compiled binary. Slash
// commands, persona-filtered /help, tool-call panels (as one-liners),
// and approval prompts all work here; streaming markdown rendering
// and collapsible tool panels ship with the Ink upgrade in the next
// pass.
//
// The REPL is a thin orchestrator over the existing `headless` path:
// every user turn is a fresh `runHeadless`-style call that appends a
// message onto the current conversation. Cross-turn state lives in
// the closure, not in persistent CLI state.

import { homedir } from "node:os";
import { join } from "node:path";
import readline from "node:readline";
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
  isDebugVerbose,
  newDebugTurnId,
  serializeDebugError,
} from "./debug.ts";
import {
  classifyElicitationIntent,
  looksLikeAssistantConfirmRequest,
} from "./elicitation-intent.ts";
import { EngineClient, SkEngineError, SkTransportError } from "./engine-client.ts";
import { loadMemory } from "./memory.ts";
import { resolveMentions } from "./mentions.ts";
import { handleSlash as handleSharedSlash } from "./repl/slash/handler.ts";
import { saveSessionMetadata } from "./sessions.ts";
import { loadSettings } from "./settings.ts";
import { findSlashCommand, type PersonaProbe, renderHelp, SLASH_COMMANDS } from "./slash.ts";

export interface ReplRunOptions {
  profile: ResolvedProfile;
  /** Optional initial prompt that runs as the first turn. */
  initialPrompt?: string;
  /** Attach to an existing conversation (from `-c`, `-r`, or `--session-id`). */
  resumeConversationId?: string;
  /** Force-disable SK.md injection for this session. */
  noMemory?: boolean;
  /** Optional sinks — tests pass buffers. */
  stdout?: NodeJS.WritableStream;
  stderr?: NodeJS.WritableStream;
  stdin?: NodeJS.ReadableStream;
}

/** Small persona snapshot cached per session so the status line + slash filter render instantly. */
interface PersonaSnapshot {
  label: string;
  allowed: Set<string>;
  probe: PersonaProbe;
  /** R7-S1: surface bootstrap freshness in /status. */
  fetchedAt: number;
  source: "network" | "cache" | "fallback";
}

import { loadBootstrap } from "./lib/bootstrap.ts";
// Persona resolution: route through `loadBootstrap` so the readline
// REPL gets the same one-call UX-gating snapshot the Ink REPL uses.
// Falls back to the tier-filtered legacy probe for older engines that
// don't expose `/v1/sk/bootstrap`.
import { ALL_PROBE_PERMISSIONS as PROBE_PERMISSIONS } from "./persona-probe.ts";

async function resolvePersona(
  client: EngineClient,
  profile: ResolvedProfile,
): Promise<PersonaSnapshot> {
  const snap = await loadBootstrap(client, profile);
  return {
    label: snap.label,
    allowed: snap.allowed,
    probe: snap.probe,
    fetchedAt: snap.fetchedAt,
    source: snap.source,
  };
}
// Suppress unused-import lint: `PROBE_PERMISSIONS` is exported for
// callers that introspect the full list (e.g. /whoami debug). It is
// not referenced inside this module.
void PROBE_PERMISSIONS;

function conversationPromptForSlash(raw: string): string | null {
  const [head, ...rest] = raw.trim().split(/\s+/);
  const name = (head ?? "").replace(/^\//, "");
  const sub = (rest[0] ?? "").toLowerCase();
  if (name === "probe" && sub !== "show" && sub !== "last") {
    return [
      "Run probe_connector_draft against the current connector draft now.",
      "Use the default GET / path unless the draft implies otherwise.",
      "Stream tool progress normally and summarise the result in one sentence.",
    ].join(" ");
  }
  if (name === "preview" && sub !== "show" && sub !== "last") {
    const stepArg = sub === "run" ? rest[1] : rest[0];
    return stepArg
      ? `Run dry_run_step against step \`${stepArg}\`. Stream tool progress normally and report the classification and one-line summary.`
      : "Run dry_run_workflow against the current draft. Stream tool progress normally and report the classification of every step that executed.";
  }
  return null;
}

export async function runRepl(opts: ReplRunOptions): Promise<number> {
  const stdout = opts.stdout ?? process.stdout;
  const stderr = opts.stderr ?? process.stderr;
  const stdin = opts.stdin ?? process.stdin;

  const settings = loadSettings(process.cwd());
  const includeMemory = !opts.noMemory && settings.merged.includeMemoryFile !== false;
  const memory = loadMemory({
    cwd: process.cwd(),
    include: includeMemory,
    ...(settings.merged.maxInlineMentionBytes !== undefined
      ? { max_bytes: settings.merged.maxInlineMentionBytes }
      : {}),
  });

  const client = new EngineClient({
    engine_url: opts.profile.engine_url,
    api_key: opts.profile.api_key,
    tenant: opts.profile.active_tenant_id,
    user_agent: "sk-cli/0.0.1",
    debug_mode: "repl",
  });

  const persona = await resolvePersona(client, opts.profile);
  const canReadSetup = persona.probe.allows("audit:read") || persona.probe.allows("identity:read");

  // Banner + status line.
  let activeDebugContext: DebugCorrelationFields | null = null;
  const currentDebugContext = (): DebugCorrelationFields | null =>
    activeDebugContext
      ? {
          ...activeDebugContext,
          conversation_id: session.conversationId ?? activeDebugContext.conversation_id ?? null,
        }
      : null;
  const line = (s: string): void => {
    stdout.write(`${s}\n`);
    const debugCtx = currentDebugContext();
    if (debugCtx) {
      debugLog("dialog.render_output", { stream: "stdout", output_text: s }, debugCtx);
    }
  };
  const writeErr = (s: string): void => {
    stderr.write(s);
    const debugCtx = currentDebugContext();
    if (debugCtx) {
      debugLog(
        "dialog.render_output",
        { stream: "stderr", output_text: s.replace(/\n$/, "") },
        debugCtx,
      );
    }
  };
  line(`sk — signed in as ${persona.label}@${opts.profile.active_tenant_id ?? "(no-tenant)"}`);
  line(`   engine: ${opts.profile.engine_url}`);
  if (memory.content) {
    line(`   memory: ${memory.sources.length} file(s), ${memory.content.length} bytes`);
  } else {
    line(`   memory: (none)`);
  }
  line(`   type a prompt, /help for commands, /exit to leave.`);

  // Session state lives in the closure across turns.
  let session: SkSessionState = initialSessionState(opts.resumeConversationId ?? null);
  if (opts.resumeConversationId) {
    line(`   resumed conversation ${opts.resumeConversationId.slice(0, 8)}`);
  }

  // Idempotency guard: while the engine is processing a turn (initial
  // prompt OR an elicitation response), a second `/approve`, `/reject`,
  // or `/respond` is a no-op. Without this, two quick approves race to
  // POST /respond — the second one re-resolves an already-resolved
  // elicitation and triggers a duplicate runLoop turn (wasted tokens
  // and a confusing UI).
  let elicitInFlight = false;

  const rl = readline.createInterface({
    input: stdin,
    output: stdout,
    terminal: stdin === process.stdin && process.stdout.isTTY,
  });

  let running = true;
  // Handle Ctrl-C: cancel any in-flight turn and reset the prompt.
  rl.on("SIGINT", async () => {
    if (session.conversationId && session.status === "running") {
      try {
        await client.cancelConversation(session.conversationId);
        writeErr("\nsk: turn cancelled\n");
      } catch {
        /* ignore */
      }
    }
    rl.prompt();
  });

  rl.setPrompt("sk> ");
  rl.prompt();

  const bufferedPrompts: string[] = [];
  if (opts.initialPrompt) bufferedPrompts.push(opts.initialPrompt);

  const runTurn = async (rawInput: string): Promise<void> => {
    const input = rawInput.trim();
    if (!input) return;
    const input_kind = input.startsWith("/") ? "slash" : "prompt";
    const turn_id = newDebugTurnId("repl");
    const traceContext = (): DebugCorrelationFields => ({
      mode: "repl",
      conversation_id: session.conversationId,
      turn_id,
    });
    activeDebugContext = traceContext();
    let turnStatus: "completed" | "error" = "completed";
    debugLog(
      "dialog.turn_start",
      {
        input_kind,
        raw_input: input,
        ...(input_kind === "prompt" ? { memory_sources: memory.sources } : {}),
      },
      traceContext(),
    );
    try {
      // Slash dispatch.
      if (input.startsWith("/")) {
        const cmd = findSlashCommand(input.split(/\s+/)[0] ?? "");
        if (!cmd) {
          debugLog(
            "dialog.error",
            { input_kind, error: { message: "unknown slash command" } },
            traceContext(),
          );
          writeErr(`sk: unknown slash command '${input}'. Try /help.\n`);
          return;
        }
        if (cmd.requires && !persona.probe.allows(cmd.requires)) {
          debugLog(
            "dialog.error",
            {
              input_kind,
              error: { message: `missing permission ${cmd.requires}` },
            },
            traceContext(),
          );
          writeErr(`sk: /${cmd.name} requires ${cmd.requires} (not granted)\n`);
          return;
        }
        await handleSlash(cmd.name, input);
        return;
      }

      // Pending-elicitation routing — same contract as ink-app:
      // while an `askUser.*` is open, plain text either resolves the
      // elicitation or surfaces a hint. NEVER forward as a new prompt
      // (would race the awaiting-input state and produce a phantom turn).
      if (session.pendingElicitation && session.conversationId && !elicitInFlight) {
        const intent = classifyElicitationIntent(input);
        const tool = session.pendingElicitation.tool_name;
        // Forensic event: every keystroke that reaches the
        // pending-elicitation branch is recorded with how it was
        // classified. Lets a "the user typed yes but nothing happened"
        // investigation answer "did the CLI route it as confirm? as
        // ambiguous? as something else?" from a single log file.
        debugLog(
          "dialog.elicitation_routing",
          {
            elicitation_id: session.pendingElicitation.id,
            ...(session.pendingElicitation.tool_call_id
              ? { tool_call_id: session.pendingElicitation.tool_call_id }
              : {}),
            pending_tool: tool,
            classified_intent: intent.kind,
            ...(intent.kind === "pick" ? { option_index: intent.optionIndex } : {}),
            input_excerpt: input.length > 80 ? `${input.slice(0, 80)}…` : input,
          },
          traceContext(),
        );
        if (intent.kind === "confirm" || intent.kind === "reject") {
          elicitInFlight = true;
          try {
            const outcome = await client.respondElicitation(
              session.conversationId,
              session.pendingElicitation.id,
              { confirmed: intent.kind === "confirm" },
              intent.kind === "reject" ? "user replied with a short negative" : undefined,
              traceContext(),
            );
            session = { ...session, pendingElicitation: null, status: "running" };
            line(intent.kind === "confirm" ? "approval sent" : "rejection sent");
            applyTurnEvents(outcome.events, () => activeDebugContext ?? { mode: "repl" });
          } finally {
            elicitInFlight = false;
          }
          return;
        }
        if (intent.kind === "pick") {
          elicitInFlight = true;
          try {
            const outcome = await client.respondElicitation(
              session.conversationId,
              session.pendingElicitation.id,
              { option_index: intent.optionIndex },
              undefined,
              traceContext(),
            );
            session = { ...session, pendingElicitation: null, status: "running" };
            line(`option ${intent.optionIndex} sent`);
            applyTurnEvents(outcome.events, () => activeDebugContext ?? { mode: "repl" });
          } finally {
            elicitInFlight = false;
          }
          return;
        }
        // Ambiguous — show a hint instead of forwarding as new prompt.
        const truncated = input.length > 80 ? `${input.slice(0, 80)}…` : input;
        const hint =
          tool === "ask_user_confirm"
            ? `there is a pending confirmation — type 'yes' to approve, 'no' to reject, or '/cancel' to abandon. (your message: "${truncated}")`
            : tool === "ask_user_pick"
              ? `there is a pending option list — type a number (e.g. '1') or 'option N' to choose. (your message: "${truncated}")`
              : `there is a pending form — use '/respond <json>' to answer. (your message: "${truncated}")`;
        line(hint);
        return;
      }

      // Plain prompt → append to current conversation or create a new one.
      // Forensic event: any prompt that reaches this branch with a
      // recently-emitted "Reply 'yes'"-style assistant message but no
      // pending elicitation is almost certainly hitting the silent
      // failure mode where the engine asked for confirmation in prose
      // without actually emitting an elicit_request. Surface a loud
      // warning so the operator knows the next "yes" will become a
      // phantom new prompt instead of an approval.
      const lastAssistant = lastAssistantText(session);
      const hadRecentUnresolvedIntent =
        session.pendingElicitation === null && looksLikeAssistantConfirmRequest(lastAssistant);
      debugLog(
        "dialog.plain_prompt_sent",
        {
          session_status: session.status,
          had_recent_unresolved_intent: hadRecentUnresolvedIntent,
          input_excerpt: input.length > 80 ? `${input.slice(0, 80)}…` : input,
        },
        traceContext(),
      );
      if (hadRecentUnresolvedIntent) {
        writeErr(
          "sk: warning — the assistant asked for explicit confirmation but did not emit an elicit_request. Your reply will be sent as a NEW prompt, not as an approval. This usually means an engine policy-gate bug; see logs for `policy.gate_skipped` or `commit_gate.denied`.\n",
        );
      }
      const resolved = await resolveMentions(input, {
        cwd: process.cwd(),
        additionalDirectories: settings.merged.additionalDirectories ?? [],
        ...(settings.merged.maxInlineMentionBytes !== undefined
          ? { maxBytes: settings.merged.maxInlineMentionBytes }
          : {}),
        client,
      });
      debugLog(
        "dialog.prompt_resolved",
        {
          raw_input: input,
          resolved_prompt: resolved.prompt,
          artifacts: resolved.artifacts,
          warnings: resolved.warnings,
        },
        traceContext(),
      );
      for (const w of resolved.warnings) {
        debugLog("dialog.warning", { warning: w }, traceContext());
        writeErr(`sk: ${w}\n`);
      }

      if (!session.conversationId) {
        const created = await client.createConversation(
          {
            initial_message: resolved.prompt,
            ...(memory.content ? { memory: memory.content } : {}),
            ...(settings.merged.model ? { model: settings.merged.model } : {}),
          },
          traceContext(),
        );
        debugLog(
          "conversation.turn_events",
          {
            operation: "create_conversation",
            response_status: created.status,
            events: created.events,
          },
          traceContext(),
        );
        session = initialSessionState(created.conversation.id);
        try {
          const now = new Date().toISOString();
          saveSessionMetadata({
            conversation_id: created.conversation.id,
            engine_url: opts.profile.engine_url,
            tenant_id: opts.profile.active_tenant_id,
            title: created.conversation.title ?? null,
            model: created.conversation.model ?? null,
            created_at: now,
            last_used_at: now,
          });
        } catch {
          /* local cache write is best-effort */
        }
      } else {
        const appended = await client.appendConversationMessage(
          session.conversationId,
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
      }
      if (!session.conversationId) {
        debugLog(
          "dialog.error",
          { input_kind, error: { message: "no conversation id after create" } },
          traceContext(),
        );
        writeErr("sk: no conversation id after create\n");
        return;
      }
      await streamUntilDone(input_kind, traceContext);
    } catch (err) {
      turnStatus = "error";
      debugLog(
        "dialog.error",
        {
          input_kind,
          error: serializeDebugError(err),
        },
        traceContext(),
      );
      if (err instanceof SkEngineError) {
        writeErr(`sk: engine error ${err.status}: ${err.message}\n`);
      } else if (err instanceof SkTransportError) {
        writeErr(`sk: transport error: ${err.message}\n`);
      } else {
        writeErr(`sk: ${err instanceof Error ? err.message : String(err)}\n`);
      }
    } finally {
      debugLog(
        "dialog.turn_end",
        {
          input_kind,
          status: turnStatus === "error" ? "error" : session.status,
          assistant_text: input_kind === "prompt" ? lastAssistantText(session) : null,
          message_count: session.messages.length,
          tool_call_count: session.toolCalls.length,
          validation_error_count: session.validationErrors.length,
          pending_elicitation: session.pendingElicitation,
          usage: session.usage,
        },
        traceContext(),
      );
      activeDebugContext = null;
    }
  };

  const renderFrame = (ev: TurnEvent): void => {
    switch (ev.type) {
      case "tool_call_start":
        line(
          `  ∙ tool_call ${ev.tool}${ev.input_partial !== undefined ? ` ${JSON.stringify(ev.input_partial).slice(0, 120)}` : ""}`,
        );
        break;
      case "tool_result": {
        line(`  ∙ tool_result ${ev.tool} ok`);
        // Bubble structured warnings the engine attached to the tool
        // result so authors can see operational hints (e.g.
        // `schedule_not_bound` from the Root A safety net) without
        // having to read raw JSON. Both shapes are tolerated:
        //   - top-level `warnings: [{ code, message? }]`
        //   - nested `output.data.warnings: [...]`
        const output =
          ev.output && typeof ev.output === "object"
            ? (ev.output as Record<string, unknown>)
            : null;
        const collected: Array<{ code?: unknown; message?: unknown }> = [];
        if (output && Array.isArray(output.warnings)) {
          for (const w of output.warnings) {
            if (w && typeof w === "object") collected.push(w as { code?: unknown });
          }
        }
        const data =
          output && output.data && typeof output.data === "object"
            ? (output.data as Record<string, unknown>)
            : null;
        if (data && Array.isArray(data.warnings)) {
          for (const w of data.warnings) {
            if (w && typeof w === "object") collected.push(w as { code?: unknown });
          }
        }
        for (const w of collected) {
          const code = typeof w.code === "string" ? w.code : "warning";
          const msg = typeof w.message === "string" ? `: ${w.message}` : "";
          // Cap to ~80 chars so the warning stays on one terminal line.
          const text = `    ! ${code}${msg}`;
          line(text.length > 80 ? `${text.slice(0, 77)}...` : text);
        }
        break;
      }
      case "elicit_request":
        line(`  ! input needed: ${ev.tool_name} — ${ev.summary}`);
        line(`    run '/respond ${ev.elicitation_id} <value>'`);
        break;
      case "validation_error":
        for (const e of ev.errors) line(`  × validation: ${e.path}: ${e.message}`);
        break;
      case "committed":
        line(`  ✓ committed workflow ${ev.workflow_id}`);
        break;
      default:
        break;
    }
  };

  // Print the assistant's last message and the per-turn token usage. Used
  // at the tail of every consumption path (SSE stream and the synchronous
  // events array returned by /respond) so a turn always concludes with a
  // visible result line — which is what was missing from the slash-command
  // path that produced the silent-hang transcript.
  const finishTurnRender = (): void => {
    const text = lastAssistantText(session).trim();
    if (text) line(`\nassistant> ${text}`);
    if (session.usage) {
      line(
        `   (usage: ${session.usage.turn_tokens} tokens this turn; ` +
          `${session.usage.remaining_monthly_budget_tokens ?? "∞"} remaining)`,
      );
    }
  };

  // Consume the SSE stream the engine opens after a fresh prompt turn.
  // Applies each frame to `session` (closure-mutated) and emits the
  // per-event lines via `renderFrame`. Errors in frame parsing are
  // logged + reported once per turn so a malformed frame can't silently
  // freeze the UI.
  const streamUntilDone = async (
    input_kind: "slash" | "prompt",
    traceContext: () => DebugCorrelationFields,
  ): Promise<void> => {
    if (!session.conversationId) return;
    const stream = await client.streamConversation(session.conversationId, traceContext());
    const verbose = isDebugVerbose();
    let parseErrorReported = false;
    await readSse(stream, (frame) => {
      debugLog(
        "sse.frame",
        { event: frame.event, ...(verbose ? { raw_data: frame.data } : {}) },
        traceContext(),
      );
      try {
        const ev = JSON.parse(frame.data) as TurnEvent;
        debugLog(
          "dialog.turn_event",
          verbose ? { event: ev } : { event_type: ev.type },
          traceContext(),
        );
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
            traceContext(),
          );
        }
        session = applyTurnEvent(session, ev);
        renderFrame(ev);
      } catch (err) {
        debugLog(
          "dialog.error",
          {
            input_kind,
            stage: "sse_frame_parse",
            ...(verbose ? { raw_frame: frame.data } : {}),
            error: serializeDebugError(err),
          },
          traceContext(),
        );
        if (!parseErrorReported) {
          parseErrorReported = true;
          writeErr("sk: malformed SSE frame — see ~/.sk/debug.log for details\n");
        }
      }
    });
    debugLog("sse.close", { final_status: session.status }, traceContext());
    finishTurnRender();
  };

  // Apply the synchronous events array that POST /respond returns. The
  // /respond route runs the next runLoop turn inline and returns its
  // events in the response body — there is no SSE stream for this path.
  // Without applying these events the slash-command handlers fell silent
  // after sending the response (the readline-path silent-hang).
  const applyTurnEvents = (events: unknown[], traceContext: () => DebugCorrelationFields): void => {
    const verbose = isDebugVerbose();
    for (const raw of events) {
      try {
        const ev = raw as TurnEvent;
        debugLog(
          "dialog.turn_event",
          verbose ? { event: ev } : { event_type: ev.type },
          traceContext(),
        );
        session = applyTurnEvent(session, ev);
        renderFrame(ev);
      } catch (err) {
        debugLog(
          "dialog.error",
          {
            stage: "respond_event_apply",
            ...(verbose ? { raw_event: raw } : {}),
            error: serializeDebugError(err),
          },
          traceContext(),
        );
      }
    }
    finishTurnRender();
  };

  const handleSlash = async (name: string, raw: string): Promise<void> => {
    const args = raw.split(/\s+/).slice(1);
    const conversationPrompt = conversationPromptForSlash(raw);
    if (conversationPrompt) {
      await runTurn(conversationPrompt);
      return;
    }
    if (!new Set(["help", "exit", "quit", "approve", "reject", "respond"]).has(name)) {
      const result = await handleSharedSlash(name, args, {
        client,
        profile: opts.profile,
        session,
        setConversationId: (next) => {
          session = initialSessionState(next);
        },
        allowedPermissions: Array.from(persona.allowed),
        statusSnapshot: await client.statusSummary().catch(() => null),
        setupSnapshot: canReadSetup ? await client.setupValidation().catch(() => null) : null,
        // R7-S1: pass bootstrap freshness through so /status surfaces it.
        bootstrapSnapshot: {
          fetchedAt: persona.fetchedAt,
          source: persona.source,
          label: persona.label,
        },
      });
      if (result) line(result);
      return;
    }
    switch (name) {
      case "help":
        line(renderHelp(persona.probe));
        return;
      case "exit":
      case "quit":
        running = false;
        rl.close();
        return;
      case "status":
        if (canReadSetup) {
          const setup = await client.setupValidation().catch(() => null);
          line(
            `profile ${opts.profile.name}\n` +
              `persona ${persona.label}\n` +
              `engine  ${opts.profile.engine_url}\n` +
              `tenant  ${opts.profile.active_tenant_id ?? "(none)"}\n` +
              `session ${session.conversationId ?? "(none)"}\n` +
              `status  ${session.status}\n` +
              `setup   ${setup ? `${setup.overall_status} (${setup.summary_counts.blockers} blockers, ${setup.summary_counts.warnings} warnings)` : "(unavailable)"}`,
          );
          return;
        }
        line(
          `profile ${opts.profile.name}\n` +
            `persona ${persona.label}\n` +
            `engine  ${opts.profile.engine_url}\n` +
            `tenant  ${opts.profile.active_tenant_id ?? "(none)"}\n` +
            `session ${session.conversationId ?? "(none)"}\n` +
            `status  ${session.status}`,
        );
        return;
      case "setup": {
        if (!canReadSetup) {
          line("sk: /setup requires identity:read or audit:read (not granted)");
          return;
        }
        const setup = await client.setupValidation();
        line(
          `setup ${setup.overall_status}\n` +
            `blockers ${setup.summary_counts.blockers}\n` +
            `warnings ${setup.summary_counts.warnings}`,
        );
        for (const [sectionId, section] of Object.entries(setup.sections)) {
          line(`\n${section.title} (${sectionId}) · ${section.status}`);
          for (const issue of section.issues) {
            line(`  ${issue.severity}: ${issue.title} — ${issue.detail}`);
          }
          for (const value of section.values) {
            const rendered = value.value ?? "—";
            const hint = value.status_hint ? ` (${value.status_hint})` : "";
            line(`  ${value.key}: ${rendered}${hint}`);
          }
          for (const recommendation of section.recommendations) {
            line(`  fix: ${recommendation}`);
          }
        }
        return;
      }
      case "cost":
        if (session.usage) {
          line(
            `turn_tokens=${session.usage.turn_tokens} ` +
              `remaining=${session.usage.remaining_monthly_budget_tokens ?? "∞"}`,
          );
        } else {
          line("no usage recorded yet this session");
        }
        return;
      case "clear":
      case "new":
        session = initialSessionState(null);
        line("session cleared");
        return;
      case "resume": {
        const res = await client.listConversations({ owner: "me", limit: 10 });
        if (res.items.length === 0) {
          line("no prior conversations");
          return;
        }
        for (const [i, conv] of res.items.entries()) {
          line(`  ${i + 1}. ${conv.id.slice(0, 8)} ${conv.title ?? "(untitled)"} ${conv.status}`);
        }
        const first = res.items[0];
        if (first) {
          session = initialSessionState(first.id);
          line(`attached to ${first.id}`);
        }
        return;
      }
      case "compact": {
        if (!session.conversationId) {
          line("no session to compact");
          return;
        }
        const r = await client.compactConversation(session.conversationId, { keep_last: 4 });
        line(`compacted ${r.messages_collapsed} messages`);
        return;
      }
      case "model": {
        const model = args[0];
        if (!session.conversationId || !model) {
          line("usage: /model <model-id>");
          return;
        }
        await client.patchConversation(session.conversationId, { model });
        line(`model switched to ${model}`);
        return;
      }
      case "skills": {
        const r = await client.listSkills();
        for (const s of r.items) line(`  ${s.scope} ${s.title}`);
        if (r.items.length === 0) line("no skills in scope");
        return;
      }
      case "mcp": {
        const [prompts, resources, tools] = await Promise.all([
          client.listMcpPrompts().catch(() => ({ items: [] })),
          client.listMcpResources().catch(() => ({ items: [] })),
          client.listMcpTools().catch(() => ({ items: [] })),
        ]);
        line(`prompts (${prompts.items.length}):`);
        for (const p of prompts.items) line(`  /mcp__${p.name} — ${p.description ?? ""}`);
        line(`resources (${resources.items.length}):`);
        for (const r of resources.items) line(`  ${r.uri} ${r.name}`);
        line(`tools (${tools.items.length}):`);
        for (const t of tools.items) line(`  ${t.name} — ${t.description}`);
        return;
      }
      case "permissions": {
        line(`permissions granted to this principal:`);
        for (const p of persona.allowed) line(`  ${p}`);
        return;
      }
      case "approve": {
        const elicitationId = args[0] ?? session.pendingElicitation?.id;
        if (!session.conversationId) {
          line("sk: no active conversation");
          return;
        }
        if (elicitInFlight) {
          line("approval already sent — engine is executing, hang tight");
          return;
        }
        if (!elicitationId) {
          line(
            session.status === "running"
              ? "no pending approval — engine is still running"
              : "no pending approval",
          );
          return;
        }
        elicitInFlight = true;
        try {
          const outcome = await client.respondElicitation(
            session.conversationId,
            elicitationId,
            { confirmed: true },
            undefined,
            activeDebugContext ?? undefined,
          );
          session = { ...session, pendingElicitation: null, status: "running" };
          line("approval sent");
          applyTurnEvents(outcome.events, () => activeDebugContext ?? { mode: "repl" });
        } finally {
          elicitInFlight = false;
        }
        return;
      }
      case "reject": {
        const elicitationId = args[0] ?? session.pendingElicitation?.id;
        if (!session.conversationId) {
          line("sk: no active conversation");
          return;
        }
        if (elicitInFlight) {
          line("rejection already sent — engine is executing, hang tight");
          return;
        }
        if (!elicitationId) {
          line(
            session.status === "running"
              ? "no pending elicitation — engine is still running"
              : "no pending elicitation",
          );
          return;
        }
        const reason = args.slice(1).join(" ") || undefined;
        elicitInFlight = true;
        try {
          const outcome = await client.respondElicitation(
            session.conversationId,
            elicitationId,
            { confirmed: false },
            reason,
            activeDebugContext ?? undefined,
          );
          session = { ...session, pendingElicitation: null, status: "running" };
          line("rejection sent");
          applyTurnEvents(outcome.events, () => activeDebugContext ?? { mode: "repl" });
        } finally {
          elicitInFlight = false;
        }
        return;
      }
      case "respond": {
        const elicitationId = args[0] ?? session.pendingElicitation?.id;
        if (!session.conversationId) {
          line("sk: no active conversation");
          return;
        }
        if (elicitInFlight) {
          line("response already sent — engine is executing, hang tight");
          return;
        }
        if (!elicitationId) {
          line(
            session.status === "running"
              ? "no pending elicitation — engine is still running"
              : "no pending elicitation",
          );
          return;
        }
        const raw = args.slice(1).join(" ");
        let output: unknown;
        try {
          output = raw ? JSON.parse(raw) : null;
        } catch {
          output = { text: raw };
        }
        elicitInFlight = true;
        try {
          const outcome = await client.respondElicitation(
            session.conversationId,
            elicitationId,
            output,
            undefined,
            activeDebugContext ?? undefined,
          );
          session = { ...session, pendingElicitation: null, status: "running" };
          line("response sent");
          applyTurnEvents(outcome.events, () => activeDebugContext ?? { mode: "repl" });
        } finally {
          elicitInFlight = false;
        }
        return;
      }
      case "memory": {
        const path = join(homedir(), ".sk", "SK.md");
        line(`open ${path} in your editor to edit memory (reloads on next turn)`);
        return;
      }
      case "init": {
        // Write a starter SK.md in cwd if none exists.
        const path = join(process.cwd(), "SK.md");
        try {
          const fs = await import("node:fs");
          if (fs.existsSync(path)) {
            line(`${path} already exists — leaving it alone`);
            return;
          }
          const starter = [
            `# Memory — ${new Date().toISOString().slice(0, 10)}`,
            "",
            "Project context that should always be in sk's scope for this repo.",
            "",
            "## What I'm working on",
            "",
            "- ",
            "",
            "## Things sk should remember",
            "",
            "- ",
            "",
            "## Things sk should never do",
            "",
            "- ",
            "",
          ].join("\n");
          fs.writeFileSync(path, starter, "utf8");
          line(`wrote ${path} — edit it and restart sk to pick it up`);
        } catch (err) {
          line(`sk: init failed: ${err instanceof Error ? err.message : String(err)}`);
        }
        return;
      }
      case "config": {
        const path = join(homedir(), ".sk", "settings.json");
        line(`open ${path} in your editor to edit settings`);
        return;
      }
      case "bug": {
        line("report issues at https://github.com/subkit/subkit/issues");
        return;
      }
      case "login":
        line("run 'sk login' outside the REPL to re-authenticate");
        return;
      case "logout":
        line("run 'sk logout' outside the REPL to drop the active profile");
        return;
      case "tenant":
        line("run 'sk tenants [use <id>]' outside the REPL to switch tenants");
        return;
      default:
        line(`/${name} is not wired in this build — check docs/03-input-surfaces.md`);
    }
  };

  // Drain any initial prompt.
  if (bufferedPrompts.length > 0) {
    for (const p of bufferedPrompts) {
      await runTurn(p);
    }
    rl.prompt();
  }

  await new Promise<void>((resolve) => {
    rl.on("line", (raw) => {
      void (async () => {
        await runTurn(raw);
        if (running) rl.prompt();
      })();
    });
    rl.on("close", () => {
      resolve();
    });
  });

  return 0;
}

// Exported for the /help command so tests can verify the registry
// wiring without instantiating a full REPL.
export { SLASH_COMMANDS };
