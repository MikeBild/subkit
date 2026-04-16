// Shared slash-command handler reused by both the readline REPL
// and the Ink REPL. Pure function in, side-effecting calls through
// the provided EngineClient. Returns a string to display as a
// transient banner, or `null` when the command handled its own
// output (e.g. `/clear` which resets the session).
//
// Handlers that need cross-turn state mutation (`/clear`, `/resume`)
// call back through `setConversationId` — the caller owns the
// React / closure state shape.

import fs from "node:fs";
import { homedir } from "node:os";
import { join } from "node:path";
import type { SkSessionState } from "@cli-core/index.ts";
import { loadConfig, type ResolvedProfile, saveConfig } from "../config.ts";
import type { EngineClient } from "../engine-client.ts";

export interface SlashHandlerContext {
  client: EngineClient;
  profile: ResolvedProfile;
  session: SkSessionState;
  /** Replace the active conversation id (e.g. `/clear`, `/resume`). */
  setConversationId: (id: string | null) => void;
  /** Allowed permissions on the current principal, for `/permissions`. */
  allowedPermissions: readonly string[];
  /** Switch to a different profile by name. Provided by the REPL host. */
  switchProfile?: (name: string) => Promise<string>;
  /** Override config file path (for testing). */
  configPath?: string;
}

/**
 * Execute a slash command by name. Returns a one-line string that
 * the caller should display as a transient banner (or null to clear
 * any existing banner). Throws on network errors — the caller
 * wraps the call in try/catch and surfaces the error as a banner.
 */
export async function handleSlash(
  name: string,
  rawArgs: string[],
  ctx: SlashHandlerContext,
): Promise<string | null> {
  switch (name) {
    case "status": {
      return (
        `profile ${ctx.profile.name} · persona ${ctx.profile.persona_hint ?? "user"} · ` +
        `engine ${ctx.profile.engine_url} · tenant ${ctx.profile.active_tenant_id ?? "(none)"} · ` +
        `session ${ctx.session.conversationId ?? "(none)"} · status ${ctx.session.status}`
      );
    }
    case "cost": {
      if (!ctx.session.usage) return "no usage recorded yet this session";
      const remaining =
        ctx.session.usage.remaining_monthly_budget_tokens == null
          ? "∞"
          : String(ctx.session.usage.remaining_monthly_budget_tokens);
      return `turn_tokens=${ctx.session.usage.turn_tokens} · remaining=${remaining}`;
    }
    case "clear":
    case "new": {
      ctx.setConversationId(null);
      return "session cleared";
    }
    case "resume": {
      const res = await ctx.client.listConversations({ owner: "me", limit: 10 });
      if (res.items.length === 0) return "no prior conversations to resume";
      const first = res.items[0];
      if (!first) return "no prior conversations to resume";
      ctx.setConversationId(first.id);
      const short = first.id.slice(0, 8);
      return `attached to ${short} (${first.title ?? "untitled"})`;
    }
    case "compact": {
      if (!ctx.session.conversationId) return "no session to compact";
      const r = await ctx.client.compactConversation(ctx.session.conversationId, { keep_last: 4 });
      return `compacted ${r.messages_collapsed} message(s)`;
    }
    case "model": {
      const model = rawArgs[0];
      if (!ctx.session.conversationId || !model) return "usage: /model <model-id>";
      await ctx.client.patchConversation(ctx.session.conversationId, { model });
      return `model switched to ${model}`;
    }
    case "skills": {
      const r = await ctx.client.listSkills();
      if (r.items.length === 0) return "no skills in scope";
      return r.items.map((s) => `${s.scope} · ${s.title}`).join("\n");
    }
    case "mcp": {
      const [prompts, resources, tools] = await Promise.all([
        ctx.client.listMcpPrompts().catch(() => ({ items: [] })),
        ctx.client.listMcpResources().catch(() => ({ items: [] })),
        ctx.client.listMcpTools().catch(() => ({ items: [] })),
      ]);
      const lines: string[] = [];
      lines.push(`prompts (${prompts.items.length}):`);
      for (const p of prompts.items) lines.push(`  /mcp__${p.name} — ${p.description ?? ""}`);
      lines.push(`resources (${resources.items.length}):`);
      for (const r of resources.items) lines.push(`  ${r.uri} · ${r.name}`);
      lines.push(`tools (${tools.items.length}):`);
      for (const t of tools.items) lines.push(`  ${t.name} — ${t.description}`);
      return lines.join("\n");
    }
    case "permissions": {
      if (ctx.allowedPermissions.length === 0) return "no permissions probe cached";
      return `granted permissions:\n${ctx.allowedPermissions.map((p) => `  ${p}`).join("\n")}`;
    }
    case "audit": {
      const res = await ctx.client.tailAuditLog({ limit: 20 });
      const rows = res.items.slice(0, 20);
      if (rows.length === 0) return "no audit rows visible to this principal";
      return rows
        .map((r) => {
          const action = typeof r.action === "string" ? r.action : "";
          const ts = typeof r.ts === "string" ? r.ts : "";
          const rid = typeof r.resource_id === "string" ? r.resource_id.slice(0, 8) : "";
          return `${ts} ${action} ${rid}`;
        })
        .join("\n");
    }
    case "memory": {
      const path = join(homedir(), ".sk", "SUBKIT.md");
      return `edit ${path} then restart sk to pick it up`;
    }
    case "init": {
      const path = join(process.cwd(), "SUBKIT.md");
      if (fs.existsSync(path)) return `${path} already exists`;
      const starter = [
        `# Memory — ${new Date().toISOString().slice(0, 10)}`,
        "",
        "Project context that sk should always see in this repo.",
        "",
        "## What I'm working on",
        "",
        "- ",
        "",
        "## Things sk should remember",
        "",
        "- ",
        "",
      ].join("\n");
      try {
        fs.writeFileSync(path, starter, "utf8");
        return `wrote ${path}`;
      } catch (err) {
        return `init failed: ${err instanceof Error ? err.message : String(err)}`;
      }
    }
    case "config": {
      return `edit ${join(homedir(), ".sk", "settings.json")}`;
    }
    case "bug": {
      return "report issues at https://github.com/subkit/subkit/issues";
    }
    case "profile":
    case "env": {
      const cfg = loadConfig(ctx.configPath);
      const profileNames = Object.keys(cfg.profiles);
      const subArg = rawArgs[0];

      // /profile add → redirect outside REPL
      if (subArg === "add") {
        return "run 'sk profile add' outside the REPL to create a new profile";
      }

      // /profile <name> → switch
      if (subArg && profileNames.includes(subArg)) {
        if (ctx.switchProfile) {
          return await ctx.switchProfile(subArg);
        }
        // Fallback: persist the switch but can't re-wire the client in-flight
        cfg.active_profile = subArg;
        saveConfig(cfg, ctx.configPath);
        return `switched to "${subArg}" — restart sk to use the new profile`;
      }

      // Unknown profile name
      if (subArg) {
        return `profile "${subArg}" not found. Available: ${profileNames.join(", ")}`;
      }

      // /profile (no args) → list
      const lines: string[] = ["profiles:"];
      for (const [pName, p] of Object.entries(cfg.profiles)) {
        const marker = pName === cfg.active_profile ? "*" : " ";
        const keyHint = p.api_key ? "(key set)" : "(no key)";
        lines.push(`  ${marker} ${pName.padEnd(12)} ${p.engine_url}  ${keyHint}`);
      }
      lines.push("");
      lines.push("/profile <name> to switch · /profile add to create");
      return lines.join("\n");
    }
    case "login":
      return "run 'sk login' outside the REPL to re-authenticate";
    case "logout":
      return "run 'sk logout' outside the REPL to drop the active profile";
    case "tenant":
      return "run 'sk tenants [use <id>]' outside the REPL to switch tenants";
    default:
      return `/${name} is not wired — try /help`;
  }
}
