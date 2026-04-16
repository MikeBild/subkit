// Bridge between apps/sk's engine client + the Ink rich REPL.
//
// Exposes a single `runInkRepl(profile, opts)` that:
//
//   1. Probes the caller's permissions via /v1/rbac/can + /whoami.
//   2. Lazily imports ink + React so `sk -p "..."` never loads them.
//   3. Renders <InkApp> with onPrompt / onSlash / onApproval callbacks
//      wired to the EngineClient and the sessions cache.
//   4. Waits for the app to exit.
//
// When the caller requests the REPL but stdout is NOT a TTY (e.g.
// piped into a file), we fall back to the readline REPL so scripts
// still see line-based output.

import type { SkSessionState, TurnEvent } from "@cli-core/index.ts";
import { initialSessionState } from "@cli-core/index.ts";
import { loadConfig, type ResolvedProfile, resolveProfile, saveConfig } from "./config.ts";
import { EngineClient } from "./engine-client.ts";
import { loadMemory } from "./memory.ts";
import { resolveMentions } from "./mentions.ts";
import { handleSlash } from "./repl/slash-handler.ts";
import { runRepl } from "./repl.ts";
import { saveSessionMetadata } from "./sessions.ts";
import { loadSettings } from "./settings.ts";
import type { PersonaProbe } from "./slash.ts";

export interface InkReplOptions {
  profile: ResolvedProfile;
  initialPrompt?: string;
  resumeConversationId?: string;
  noMemory?: boolean;
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

interface ResolvedPersona {
  label: string;
  probe: PersonaProbe;
  allowed: Set<string>;
  /** Tenant slug or uuid returned by whoami, preferred over the profile. */
  tenant: string | null;
  /** Email or sub returned by whoami — nice to show in the status line. */
  email: string | null;
}

async function resolvePersona(
  client: EngineClient,
  profile: ResolvedProfile,
): Promise<ResolvedPersona> {
  const allowed = new Set<string>();
  let label = profile.persona_hint ?? "user";
  let tenant: string | null = profile.active_tenant_id ?? null;
  let email: string | null = null;
  try {
    const who = await client.whoami().catch(() => null);
    if (who) {
      email = who.email ?? null;
      tenant = who.tenant_slug ?? who.tenant_id ?? tenant;
      // Seed label from the role_name the engine returned before any
      // probe runs, so status line renders the right persona even if
      // the RBAC check endpoint denies us later (e.g. on a fresh tenant
      // with a restricted key).
      if (who.role_name) label = who.role_name;
      for (const p of PROBE_PERMISSIONS) {
        try {
          const d = await client.rbacCan({ principal_id: who.id, permission: p });
          if (d.allow) allowed.add(p);
        } catch {
          /* ignore */
        }
      }
      // Refine label if we got enough signal back from the RBAC probes.
      if (allowed.has("audit:read")) label = "admin";
      else if (allowed.has("mcp:read") && allowed.has("skill:read")) label = "member";
      else if (!allowed.has("conversation:list") && allowed.has("conversation:write"))
        label = "portal";
      else if (allowed.has("conversation:write")) label = "enduser";
    }
  } catch {
    /* leave label as-is */
  }
  return {
    label,
    probe: { allows: (p: string) => allowed.has(p) },
    allowed,
    tenant,
    email,
  };
}

export async function runInkRepl(opts: InkReplOptions): Promise<number> {
  // Fall back to the readline REPL when stdout is not a TTY — Ink
  // cannot render sensibly into a pipe and `bun test` drives us
  // without a TTY for smoke tests.
  if (!process.stdout.isTTY) {
    return runRepl({
      profile: opts.profile,
      ...(opts.initialPrompt ? { initialPrompt: opts.initialPrompt } : {}),
      ...(opts.resumeConversationId ? { resumeConversationId: opts.resumeConversationId } : {}),
      noMemory: Boolean(opts.noMemory),
    });
  }

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
    user_agent: "sk-cli/0.0.1 (ink)",
  });

  const persona = await resolvePersona(client, opts.profile);

  const React = (await import("react")) as typeof import("react");
  const ink = await import("ink");
  const appModule = await import("./ink-app.tsx");
  const { InkApp } = appModule;

  let currentConversationId: string | null = opts.resumeConversationId ?? null;
  // We keep a cheap mirror of the session state here so the slash
  // handler can read `session.usage`, `session.status`, and the
  // current conversation id without forcing the Ink tree to round-
  // trip state up through props. React's state stays authoritative
  // for rendering; this mirror is strictly a feed for slash commands.
  let mirrorSession: SkSessionState = initialSessionState(currentConversationId);

  const onPrompt = async (
    text: string,
  ): Promise<{ events: AsyncIterable<TurnEvent>; conversationId: string }> => {
    const resolved = await resolveMentions(text, {
      cwd: process.cwd(),
      additionalDirectories: settings.merged.additionalDirectories ?? [],
      ...(settings.merged.maxInlineMentionBytes !== undefined
        ? { maxBytes: settings.merged.maxInlineMentionBytes }
        : {}),
      client: currentClient,
    });
    // The POST responses from `/v1/conversations` + `/messages` each
    // carry the complete `events[]` for THIS turn (user message +
    // tool calls + assistant text + completed). We drive the reducer
    // from those events directly — re-opening the SSE stream after
    // each turn would replay the full conversation history and
    // multiply messages, which was the v1 bug.
    let outcome: {
      conversation: { id: string; title: string | null; model: string | null };
      events: unknown[];
    };
    if (!currentConversationId) {
      const created = await currentClient.createConversation({
        initial_message: resolved.prompt,
        ...(memory.content ? { memory: memory.content } : {}),
        ...(settings.merged.model ? { model: settings.merged.model } : {}),
      });
      currentConversationId = created.conversation.id;
      outcome = created;
      try {
        const now = new Date().toISOString();
        saveSessionMetadata({
          conversation_id: currentConversationId,
          engine_url: opts.profile.engine_url,
          tenant_id: opts.profile.active_tenant_id,
          title: created.conversation.title ?? null,
          model: created.conversation.model ?? null,
          created_at: now,
          last_used_at: now,
        });
      } catch {
        /* ignore */
      }
    } else {
      outcome = await currentClient.appendConversationMessage(currentConversationId, {
        message: resolved.prompt,
        ...(memory.content ? { memory: memory.content } : {}),
      });
    }

    // Wrap the events array in an async iterable so the Ink app can
    // consume them the same way it consumed streamConversationFrames.
    async function* iterTurnEvents(): AsyncGenerator<TurnEvent, void, void> {
      for (const ev of outcome.events as TurnEvent[]) {
        yield ev;
      }
    }
    return {
      events: iterTurnEvents(),
      conversationId: currentConversationId,
    };
  };

  const onApproval = async (
    approvalId: string,
    decision: "approved" | "rejected",
    reason?: string,
  ): Promise<void> => {
    if (!currentConversationId) return;
    await currentClient.decideApproval(currentConversationId, approvalId, decision, reason);
  };

  let currentClient = client;
  let currentProfile = opts.profile;

  const switchProfileFn = async (name: string): Promise<string> => {
    const cfg = loadConfig();
    const target = cfg.profiles[name];
    if (!target) return `profile "${name}" not found`;

    cfg.active_profile = name;
    saveConfig(cfg);

    const newProfile = resolveProfile({ profile: name });
    const newClient = new EngineClient({
      engine_url: newProfile.engine_url,
      api_key: newProfile.api_key,
      tenant: newProfile.active_tenant_id,
      user_agent: "sk-cli/0.0.1 (ink)",
    });

    currentClient = newClient;
    currentProfile = newProfile;
    currentConversationId = null;
    mirrorSession = initialSessionState(null);

    // Verify connectivity
    try {
      await newClient.health();
      return `switched to "${name}" (${newProfile.engine_url})`;
    } catch {
      return `switched to "${name}" (${newProfile.engine_url}) — engine unreachable`;
    }
  };

  const onSlash = async (name: string, raw: string): Promise<string | null> => {
    const rawArgs = raw.split(/\s+/).slice(1);
    try {
      const line = await handleSlash(name, rawArgs, {
        client: currentClient,
        profile: currentProfile,
        session: mirrorSession,
        setConversationId: (next) => {
          currentConversationId = next;
          mirrorSession = initialSessionState(next);
        },
        allowedPermissions: Array.from(persona.allowed ?? []),
        switchProfile: switchProfileFn,
      });
      return line;
    } catch (err) {
      return `sk: ${err instanceof Error ? err.message : String(err)}`;
    }
  };

  const instance = ink.render(
    React.createElement(InkApp, {
      persona: {
        label: persona.label,
        // Prefer the whoami-resolved tenant (slug) over the profile's
        // stored uuid — it's what the user typed and recognizes.
        tenant: persona.tenant ?? opts.profile.active_tenant_id,
        engineUrl: opts.profile.engine_url,
        profileName: opts.profile.name,
        probe: persona.probe,
      },
      ...(settings.merged.statusLine ? { statusLineConfig: settings.merged.statusLine } : {}),
      initialConversationId: currentConversationId,
      model: settings.merged.model ?? null,
      cwd: process.cwd(),
      onPrompt,
      onApproval,
      onSlash,
    }),
  );
  await instance.waitUntilExit();
  return 0;
}
