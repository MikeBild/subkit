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
import type { ConversationItem } from "@chat-ui/index.ts";
import type { SkSessionState } from "@cli-core/index.ts";
import { loadConfig, type ResolvedProfile, saveConfig } from "../config.ts";
import type { EngineClient, StatusSummary } from "../engine-client.ts";

/**
 * Rich pane descriptions returned by slash commands that open a modal
 * instead of (or in addition to) a one-line banner. The Ink host
 * renders the right component based on `kind`. Adding a new pane kind
 * means: extend this union, handle it in the host's modal slot, and
 * the readline fallback's text mirror.
 */
export type PaneSpec =
  | {
      kind: "status";
      title?: string;
      subtitle?: string;
      rows: ReadonlyArray<readonly [string, string | number | null | undefined]>;
    }
  | { kind: "conversations"; items: ReadonlyArray<ConversationItem> }
  | {
      kind: "text";
      title: string;
      subtitle?: string;
      /** Lines rendered verbatim inside the pane, one `<Text>` per line. */
      lines: ReadonlyArray<string>;
    };

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
  /**
   * Latest `/v1/status` snapshot — populated by the Ink host, refreshed
   * after every completed turn. Provides connector count + today's
   * tokens + tenant slug for `/status` and the status-line ticker.
   */
  statusSnapshot?: StatusSummary | null;
  /**
   * Open a modal pane in the Ink host. When omitted (e.g. the readline
   * fallback REPL), pane-returning commands fall back to a text banner.
   */
  openPane?: (spec: PaneSpec) => void;
  /** Override config file path (for testing). */
  configPath?: string;
}

/**
 * Helper: when an Ink host is available, open a "text" pane in the
 * modal slot and return null (no banner). Otherwise fall back to
 * joining the body lines into a single banner string so the readline
 * REPL stays functional.
 */
function panify(
  ctx: SlashHandlerContext,
  title: string,
  lines: readonly string[],
  subtitle?: string,
): string | null {
  if (ctx.openPane) {
    ctx.openPane(
      subtitle !== undefined
        ? { kind: "text", title, subtitle, lines }
        : { kind: "text", title, lines },
    );
    return null;
  }
  return [title, "", ...lines].join("\n");
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
      const snap = ctx.statusSnapshot ?? null;
      const tenant = snap?.tenant.slug ?? snap?.tenant.id ?? ctx.profile.active_tenant_id ?? null;
      const budget = snap?.monthly_budget_tokens;
      const remaining = snap?.remaining_monthly_budget_tokens;
      const rows: Array<readonly [string, string | number | null | undefined]> = [
        ["user", snap?.user.email ?? snap?.user.id ?? "(unknown)"],
        ["auth", snap ? "signed_in" : "signed_out"],
        ["profile", ctx.profile.name],
        ["persona", ctx.profile.persona_hint ?? "user"],
        ["tenant", tenant],
        ["engine", ctx.profile.engine_url],
        ["engine version", snap?.version],
        ["session", ctx.session.conversationId ?? "(none)"],
        ["session status", ctx.session.status],
        ["connectors", snap?.connectors_count],
        ["skills", snap?.skills_count],
        ["tokens · this turn", ctx.session.usage?.turn_tokens],
        ["tokens · today", snap?.tokens_today],
        ["tokens · month", snap?.tokens_month],
        ["budget · monthly", budget == null ? "∞" : `${budget.toLocaleString()} tok`],
        ["budget · remaining", remaining == null ? "∞" : `${remaining.toLocaleString()} tok`],
      ];
      if (ctx.openPane) {
        ctx.openPane({
          kind: "status",
          title: "status",
          subtitle: ctx.profile.name,
          rows,
        });
        return null;
      }
      // Readline fallback: render as a multi-line banner.
      return rows
        .map(
          ([label, value]) =>
            `${label.padEnd(20, " ")} ${value === undefined || value === null ? "—" : value}`,
        )
        .join("\n");
    }
    case "cost": {
      const snap = ctx.statusSnapshot ?? null;
      const usage = ctx.session.usage;
      const lines: string[] = [];
      if (usage) {
        const remaining =
          usage.remaining_monthly_budget_tokens == null
            ? "∞"
            : usage.remaining_monthly_budget_tokens.toLocaleString();
        lines.push(`tokens · this turn   ${usage.turn_tokens.toLocaleString()}`);
        lines.push(`remaining · monthly  ${remaining}`);
      } else {
        lines.push("no turn-level usage recorded yet this session");
      }
      if (snap) {
        lines.push(`tokens · today       ${snap.tokens_today.toLocaleString()}`);
        lines.push(`tokens · month       ${snap.tokens_month.toLocaleString()}`);
        if (snap.monthly_budget_tokens !== null) {
          lines.push(`budget · monthly     ${snap.monthly_budget_tokens.toLocaleString()} tok`);
        }
      }
      return panify(ctx, "cost", lines);
    }
    case "clear":
    case "new": {
      ctx.setConversationId(null);
      return "session cleared";
    }
    case "resume": {
      const res = await ctx.client.listConversations({ owner: "me", limit: 25 });
      if (res.items.length === 0) return "no prior conversations to resume";
      if (ctx.openPane) {
        ctx.openPane({
          kind: "conversations",
          items: res.items.map((it) => ({
            id: it.id,
            title: it.title ?? null,
            updated_at: it.updated_at,
            status: it.status ?? null,
          })),
        });
        return null;
      }
      // Readline fallback: silently attach to the most recent.
      const first = res.items[0];
      if (!first) return "no prior conversations to resume";
      ctx.setConversationId(first.id);
      const short = first.id.slice(0, 8);
      return `attached to ${short} (${first.title ?? "untitled"})`;
    }
    case "compact": {
      if (!ctx.session.conversationId) return "no session to compact";
      const r = await ctx.client.compactConversation(ctx.session.conversationId, { keep_last: 4 });
      const lines: string[] = [
        `collapsed ${r.messages_collapsed} message(s)`,
        `kept last 4 · retained conversation id ${ctx.session.conversationId.slice(0, 8)}`,
        "",
        "summary:",
        ...(r.summary ? r.summary.split(/\r?\n/) : ["(no summary returned)"]),
      ];
      return panify(ctx, "compact", lines);
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
      const lines = r.items.map((s) => `${s.scope.padEnd(8)} ${s.title}`);
      return panify(ctx, "skills", lines, `${r.items.length} in scope`);
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
      lines.push("");
      lines.push(`resources (${resources.items.length}):`);
      for (const r of resources.items) lines.push(`  ${r.uri} · ${r.name}`);
      lines.push("");
      lines.push(`tools (${tools.items.length}):`);
      for (const t of tools.items) lines.push(`  ${t.name} — ${t.description}`);
      return panify(ctx, "mcp catalog", lines);
    }
    case "permissions": {
      if (ctx.allowedPermissions.length === 0) return "no permissions probe cached";
      return panify(
        ctx,
        "permissions",
        ctx.allowedPermissions.map((p) => `  ${p}`),
        `${ctx.allowedPermissions.length} granted`,
      );
    }
    case "audit": {
      const res = await ctx.client.tailAuditLog({ limit: 20 });
      const rows = res.items.slice(0, 20);
      if (rows.length === 0) return "no audit rows visible to this principal";
      const lines = rows.map((r) => {
        const action = typeof r.action === "string" ? r.action : "";
        const ts = typeof r.ts === "string" ? r.ts : "";
        const rid = typeof r.resource_id === "string" ? r.resource_id.slice(0, 8) : "";
        return `${ts}  ${action.padEnd(28)} ${rid}`;
      });
      return panify(ctx, "audit log", lines, `latest ${rows.length}`);
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
