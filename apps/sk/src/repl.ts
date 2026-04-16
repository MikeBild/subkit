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
import { EngineClient, SkEngineError, SkTransportError } from "./engine-client.ts";
import { loadMemory } from "./memory.ts";
import { resolveMentions } from "./mentions.ts";
import { saveSessionMetadata } from "./sessions.ts";
import { loadSettings } from "./settings.ts";
import { findSlashCommand, type PersonaProbe, renderHelp, SLASH_COMMANDS } from "./slash.ts";

export interface ReplRunOptions {
  profile: ResolvedProfile;
  /** Optional initial prompt that runs as the first turn. */
  initialPrompt?: string;
  /** Attach to an existing conversation (from `-c`, `-r`, or `--session-id`). */
  resumeConversationId?: string;
  /** Force-disable SUBKIT.md injection for this session. */
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
}

const PROBE_PERMISSIONS = [
  "conversation:read",
  "conversation:write",
  "conversation:approve",
  "conversation:cancel",
  "conversation:commit",
  "conversation:list",
  "memory:write",
  "mcp:read",
  "skill:read",
  "audit:read",
  "identity:read",
] as const;

async function resolvePersona(
  client: EngineClient,
  profile: ResolvedProfile,
): Promise<PersonaSnapshot> {
  const allowed = new Set<string>();
  let label = profile.persona_hint ?? "user";
  try {
    const who = await client.whoami().catch(() => null);
    const principalId = who?.id;
    if (principalId) {
      for (const p of PROBE_PERMISSIONS) {
        try {
          const d = await client.rbacCan({ principal_id: principalId, permission: p });
          if (d.allow) allowed.add(p);
        } catch {
          /* ignore probe failures */
        }
      }
      // Cheap persona label heuristic: admin if every perm allowed, portal
      // if read+write but not list, enduser if write without mcp/skill,
      // member otherwise.
      if (allowed.has("audit:read")) label = "admin";
      else if (allowed.has("mcp:read") && allowed.has("skill:read")) label = "member";
      else if (!allowed.has("conversation:list") && allowed.has("conversation:write"))
        label = "portal";
      else if (allowed.has("conversation:write")) label = "enduser";
    }
  } catch {
    /* leave label + allowed as-is */
  }
  return {
    label,
    allowed,
    probe: { allows: (p) => allowed.has(p) },
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
  });

  const persona = await resolvePersona(client, opts.profile);

  // Banner + status line.
  const line = (s: string): void => {
    stdout.write(`${s}\n`);
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
        stderr.write("\nsk: turn cancelled\n");
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

    // Slash dispatch.
    if (input.startsWith("/")) {
      const cmd = findSlashCommand(input.split(/\s+/)[0] ?? "");
      if (!cmd) {
        stderr.write(`sk: unknown slash command '${input}'. Try /help.\n`);
        return;
      }
      if (cmd.requires && !persona.probe.allows(cmd.requires)) {
        stderr.write(`sk: /${cmd.name} requires ${cmd.requires} (not granted)\n`);
        return;
      }
      await handleSlash(cmd.name, input);
      return;
    }

    // Plain prompt → append to current conversation or create a new one.
    const resolved = await resolveMentions(input, {
      cwd: process.cwd(),
      additionalDirectories: settings.merged.additionalDirectories ?? [],
      ...(settings.merged.maxInlineMentionBytes !== undefined
        ? { maxBytes: settings.merged.maxInlineMentionBytes }
        : {}),
      client,
    });
    for (const w of resolved.warnings) stderr.write(`sk: ${w}\n`);

    try {
      if (!session.conversationId) {
        const created = await client.createConversation({
          initial_message: resolved.prompt,
          ...(memory.content ? { memory: memory.content } : {}),
          ...(settings.merged.model ? { model: settings.merged.model } : {}),
        });
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
        await client.appendConversationMessage(session.conversationId, {
          message: resolved.prompt,
          ...(memory.content ? { memory: memory.content } : {}),
        });
      }
      if (!session.conversationId) {
        stderr.write("sk: no conversation id after create\n");
        return;
      }
      const stream = await client.streamConversation(session.conversationId);
      await readSse(stream, (frame) => {
        try {
          const ev = JSON.parse(frame.data) as TurnEvent;
          session = applyTurnEvent(session, ev);
          renderFrame(ev);
        } catch {
          /* skip malformed */
        }
      });
      // After the stream closes, print the final assistant text and any usage.
      const text = lastAssistantText(session).trim();
      if (text) line(`\nassistant> ${text}`);
      if (session.usage) {
        line(
          `   (usage: ${session.usage.turn_tokens} tokens this turn; ` +
            `${session.usage.remaining_monthly_budget_tokens ?? "∞"} remaining)`,
        );
      }
    } catch (err) {
      if (err instanceof SkEngineError) {
        stderr.write(`sk: engine error ${err.status}: ${err.message}\n`);
      } else if (err instanceof SkTransportError) {
        stderr.write(`sk: transport error: ${err.message}\n`);
      } else {
        stderr.write(`sk: ${err instanceof Error ? err.message : String(err)}\n`);
      }
    }
  };

  const renderFrame = (ev: TurnEvent): void => {
    switch (ev.type) {
      case "tool_call":
        line(`  ∙ tool_call ${ev.tool} ${JSON.stringify(ev.input).slice(0, 120)}`);
        break;
      case "tool_result":
        line(`  ∙ tool_result ${ev.tool} ok`);
        break;
      case "approval_request":
        line(`  ! approval requested: ${ev.kind} — ${ev.summary}`);
        line(`    run '/approve ${ev.approval_id}' or '/reject ${ev.approval_id} <reason>'`);
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

  const handleSlash = async (name: string, raw: string): Promise<void> => {
    const args = raw.split(/\s+/).slice(1);
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
        line(
          `profile ${opts.profile.name}\n` +
            `persona ${persona.label}\n` +
            `engine  ${opts.profile.engine_url}\n` +
            `tenant  ${opts.profile.active_tenant_id ?? "(none)"}\n` +
            `session ${session.conversationId ?? "(none)"}\n` +
            `status  ${session.status}`,
        );
        return;
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
        const approvalId = args[0];
        if (!session.conversationId || !approvalId) {
          line("usage: /approve <approval_id>");
          return;
        }
        await client.decideApproval(session.conversationId, approvalId, "approved");
        session = { ...session, pendingApproval: null, status: "running" };
        line("approval sent");
        return;
      }
      case "reject": {
        const approvalId = args[0];
        if (!session.conversationId || !approvalId) {
          line("usage: /reject <approval_id> [reason]");
          return;
        }
        const reason = args.slice(1).join(" ") || undefined;
        await client.decideApproval(session.conversationId, approvalId, "rejected", reason);
        session = { ...session, pendingApproval: null, status: "running" };
        line("rejection sent");
        return;
      }
      case "memory": {
        const path = join(homedir(), ".sk", "SUBKIT.md");
        line(`open ${path} in your editor to edit memory (reloads on next turn)`);
        return;
      }
      case "init": {
        // Write a starter SUBKIT.md in cwd if none exists.
        const path = join(process.cwd(), "SUBKIT.md");
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
        line(`/${name} is not wired in this build — check docs/27-sk-cli.md`);
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
