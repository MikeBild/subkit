import { homedir } from "node:os";
import { join } from "node:path";
import readline from "node:readline";
import { isEngineError, isTransportError } from "@cli-core/errors.ts";
import {
  applyTurnEvent,
  initialSessionState,
  lastAssistantText,
  readSse,
  type SkSessionState,
  type TurnEvent,
} from "@cli-core/index.ts";
import { AgentBriefingContext } from "./agent-context.ts";
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
import { EngineClient } from "./engine-client.ts";
import { loadMemory } from "./memory.ts";
import { resolveMentions } from "./mentions.ts";
import { finishTurnRender, renderFrame } from "./repl/frame-render.ts";
import { handleSlash as handleSharedSlash } from "./repl/slash/handler.ts";
import { saveSessionMetadata } from "./sessions.ts";
import { loadSettings } from "./settings.ts";
import { findSlashCommand, type PersonaProbe, renderHelp, SLASH_COMMANDS } from "./slash.ts";

interface ReplRunOptions {
  profile: ResolvedProfile;
  initialPrompt?: string;
  resumeConversationId?: string;
  noMemory?: boolean;
  stdout?: NodeJS.WritableStream;
  stderr?: NodeJS.WritableStream;
  stdin?: NodeJS.ReadableStream;
}

interface PersonaSnapshot {
  label: string;
  allowed: Set<string>;
  probe: PersonaProbe;
  fetchedAt: number;
  source: "network" | "cache" | "fallback";
}

import { loadBootstrap } from "./lib/bootstrap.ts";

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

  let session: SkSessionState = initialSessionState(opts.resumeConversationId ?? null);
  let briefingContext = new AgentBriefingContext({
    profile: opts.profile,
    cwd: process.cwd(),
    ...(opts.resumeConversationId ? { sessionId: opts.resumeConversationId } : {}),
  });
  const initialBriefing = await briefingContext.start();
  if (initialBriefing.status) line(initialBriefing.status);
  if (opts.resumeConversationId) {
    line(`   resumed conversation ${opts.resumeConversationId.slice(0, 8)}`);
  }

  let elicitInFlight = false;

  const rl = readline.createInterface({
    input: stdin,
    output: stdout,
    terminal: stdin === process.stdin && process.stdout.isTTY,
  });

  let running = true;
  rl.on("SIGINT", async () => {
    if (session.conversationId && session.status === "running") {
      try {
        await client.cancelConversation(session.conversationId);
        writeErr("\nsk: turn cancelled\n");
      } catch {}
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
      if (input.startsWith("/")) {
        const slashHead = input.split(/\s+/)[0] ?? "";
        const cmd = findSlashCommand(slashHead);
        if (!cmd) {
          const looksLikePath =
            slashHead.slice(1).includes("/") ||
            slashHead.startsWith("~/") ||
            slashHead.startsWith("./");
          debugLog(
            "dialog.error",
            { input_kind, error: { message: "unknown slash command" } },
            traceContext(),
          );
          if (looksLikePath) {
            writeErr(
              `sk: '${slashHead}' looks like a file path, not a slash command. ` +
                "Paste or drop an existing file path into the Ink REPL, or mention the path in a prompt.\n",
            );
          } else {
            writeErr(`sk: unknown slash command '${input}'. Try /help.\n`);
          }
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

      if (session.pendingElicitation && session.conversationId && !elicitInFlight) {
        const intent = classifyElicitationIntent(input);
        const tool = session.pendingElicitation.tool_name;
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
              intent.kind === "reject" ? "user_declined" : undefined,
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
      const briefingUpdate = await briefingContext.beforePrompt(input);
      if (briefingUpdate.status) line(briefingUpdate.status);
      const turnMemory = briefingContext.memory(memory.content);
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
          references: resolved.references,
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
            ...(resolved.references.length > 0 ? { references: resolved.references } : {}),
            ...(turnMemory ? { memory: turnMemory } : {}),
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
        } catch {}
      } else {
        const appended = await client.appendConversationMessage(
          session.conversationId,
          {
            message: resolved.prompt,
            ...(resolved.references.length > 0 ? { references: resolved.references } : {}),
            ...(turnMemory ? { memory: turnMemory } : {}),
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
      if (isEngineError(err)) {
        writeErr(`sk: engine error ${err.status}: ${err.message}\n`);
      } else if (isTransportError(err)) {
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
        renderFrame(ev, line);
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
    finishTurnRender(session, line);
  };

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
        renderFrame(ev, line);
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
    finishTurnRender(session, line);
  };

  const handleSlash = async (name: string, raw: string): Promise<void> => {
    const args = raw.split(/\s+/).slice(1);
    if (!new Set(["help", "exit", "quit", "approve", "reject", "respond"]).has(name)) {
      const result = await handleSharedSlash(name, args, {
        client,
        profile: opts.profile,
        session,
        setConversationId: (next) => {
          session = initialSessionState(next);
          briefingContext = new AgentBriefingContext({
            profile: opts.profile,
            cwd: process.cwd(),
            ...(next ? { sessionId: next } : {}),
          });
          void briefingContext.start().then((update) => {
            if (update.status) line(update.status);
          });
        },
        allowedPermissions: Array.from(persona.allowed),
        statusSnapshot: await client.statusSummary().catch(() => null),
        setupSnapshot: canReadSetup ? await client.setupValidation().catch(() => null) : null,
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
          line(`turn_tokens=${session.usage.turn_tokens}`);
        } else {
          line("no usage recorded yet this session");
        }
        return;
      case "clear":
      case "new":
        session = initialSessionState(null);
        briefingContext = new AgentBriefingContext({ profile: opts.profile, cwd: process.cwd() });
        {
          const update = await briefingContext.start();
          if (update.status) line(update.status);
        }
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
          briefingContext = new AgentBriefingContext({
            profile: opts.profile,
            cwd: process.cwd(),
            sessionId: first.id,
          });
          {
            const update = await briefingContext.start();
            if (update.status) line(update.status);
          }
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
        const feedback = args.slice(1).join(" ") || undefined;
        elicitInFlight = true;
        try {
          const outcome = await client.respondElicitation(
            session.conversationId,
            elicitationId,
            { confirmed: false, ...(feedback ? { feedback } : {}) },
            "user_declined",
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
        line(`/${name} is not wired in this build — run /help for the commands it has`);
    }
  };

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

export { SLASH_COMMANDS };
