// Session-lifecycle slashes: `/clear`, `/new`, `/copy`, `/rename`,
// `/fork`, `/mention`, `/settings`, `/preferences`, `/session`,
// `/export`, `/resume`, `/compact`, `/model`. Everything that reads or
// mutates the current conversation/session (or deep-links into the
// settings modal) lives here; handler.ts keeps the grouped case labels
// and delegates with the canonical (post-alias) command name.
//
// Returns:
//   - `string | null` if the command was handled (string = banner,
//     null = pane was opened)
//   - `undefined` if the name doesn't belong to this group

import fs from "node:fs";
import { join } from "node:path";

import { type PaneSpec, panify, type SlashHandlerContext } from "../handler.ts";

export async function dispatchSessionSlash(
  name: string,
  rawArgs: string[],
  ctx: SlashHandlerContext,
): Promise<string | null | undefined> {
  switch (name) {
    case "clear":
    case "new": {
      ctx.setConversationId(null);
      return "session cleared";
    }
    case "copy": {
      // Find the most recent assistant message in the in-memory transcript
      // and write it to the operator's clipboard via OSC 52.
      const msgs = ctx.session.messages;
      let lastText = "";
      for (let i = msgs.length - 1; i >= 0; i--) {
        const m = msgs[i];
        if (m && m.role === "assistant") {
          lastText = typeof m.content === "string" ? m.content : "";
          break;
        }
      }
      // When the in-memory transcript does not contain an assistant
      // turn (resumed session, paged history scrolled past it, or
      // REPL booted into an existing conversation), fall back to the
      // engine's persisted messages. The happy path stays fully local
      // when the in-memory cache already has text.
      if (lastText === "" && ctx.session.conversationId) {
        try {
          const detail = await ctx.client.getConversation(ctx.session.conversationId);
          const persisted = detail.messages as Array<{ role?: string; content?: unknown }>;
          for (let i = persisted.length - 1; i >= 0; i--) {
            const m = persisted[i];
            if (m && m.role === "assistant") {
              lastText = typeof m.content === "string" ? m.content : "";
              break;
            }
          }
        } catch {
          // Engine fetch failures fall through to the empty-transcript
          // hint below; the slash never throws and never deadlocks.
        }
      }
      if (lastText === "") {
        // Distinguish "no assistant turn at all" from "assistant turn
        // is empty"; the in-memory transcript is the authoritative
        // signal for the latter.
        const haveAnyAssistant = msgs.some((m) => m?.role === "assistant");
        return haveAnyAssistant
          ? "/copy: last assistant message is empty"
          : "/copy: no assistant message yet";
      }
      const { osc52Copy } = await import("@cli-core/clipboard.ts");
      const ok = osc52Copy(lastText);
      return ok
        ? `copied last assistant message (${lastText.length} chars) to clipboard`
        : "/copy failed: clipboard not writable on this terminal";
    }
    case "rename": {
      if (!ctx.session.conversationId) return "/rename: no active conversation";
      const title = rawArgs.join(" ").trim();
      if (!title) return "/rename: usage `/rename <new-title>`";
      try {
        await ctx.client.patchConversation(ctx.session.conversationId, { title });
        return `session renamed to "${title}"`;
      } catch (err) {
        const msg = err instanceof Error ? err.message : String(err);
        return `/rename failed: ${msg}`;
      }
    }
    case "fork": {
      // Wired to the engine fork-from-message route. /fork creates a
      // real fork at the most recent persisted assistant message,
      // copying messages 0..N into a new conversation, and switches
      // the local sessionId to the new one. The original conversation
      // stays
      // resumable via /resume. For the in-conversation timeline
      // picker (`/resume → t`), see ConversationBrowser.
      const sourceId = ctx.session.conversationId;
      if (!sourceId) return "no session to fork from";
      // Find the most recent assistant message that has a persisted
      // engine id. Synthetic / streaming-in-progress messages have
      // no `id` and the fork route refuses unknown anchors.
      let anchorId: string | null = null;
      for (let i = ctx.session.messages.length - 1; i >= 0; i--) {
        const m = ctx.session.messages[i];
        if (m && m.role === "assistant" && typeof m.id === "string" && m.id.length > 0) {
          anchorId = m.id;
          break;
        }
      }
      if (!anchorId) {
        return "/fork: no persisted assistant turn to fork from yet (waiting for the engine to commit the latest message)";
      }
      try {
        const res = await ctx.client.forkConversationFromMessage(sourceId, anchorId);
        ctx.setConversationId(res.conversation.id);
        const short = res.conversation.id.slice(0, 8);
        // Annotate the truncation outcome inline so the operator
        // notices when older context was dropped at fork time. The
        // anchor is always preserved; only earlier messages get
        // clipped.
        const truncationNote = res.truncated
          ? " — earlier history was truncated at the per-fork copy cap"
          : "";
        return `forked from ${sourceId.slice(0, 8)} at message ${anchorId.slice(0, 8)} — new session ${short} (${res.copied_message_count} messages copied)${truncationNote}`;
      } catch (err) {
        const msg = err instanceof Error ? err.message : String(err);
        return `/fork failed: ${msg}`;
      }
    }
    case "mention": {
      return "tip: type `@` in the composer to open the inline mention picker (file / connector / workflow)";
    }
    case "settings":
    case "preferences": {
      if (!ctx.openPane) {
        return "/settings is only available in the Ink REPL — use `sk settings` for the standalone CLI";
      }
      const pane: Extract<PaneSpec, { kind: "settings" }> = { kind: "settings" };
      if (rawArgs[0]) pane.initialTab = rawArgs[0];
      pane.tenant = ctx.statusSnapshot?.tenant.id ?? ctx.profile.active_tenant_id ?? null;
      if (ctx.session.conversationId) pane.sessionId = ctx.session.conversationId;
      if (ctx.session.usage && typeof ctx.session.usage.turn_tokens === "number") {
        pane.sessionTokens = ctx.session.usage.turn_tokens;
      }
      ctx.openPane(pane);
      return null;
    }
    case "session": {
      // Mint a portal token scoped to the workflow id provided in args
      // and render a terminal QR + URL. TTL is operator-tunable via
      // `repl.portalTokenTtlMin`; tenant-scoped via the engine's
      // existing /v1/identity/portal-tokens audit invariants.
      //
      // The plaintext URL is a bearer-equivalent secret. Returning the
      // URL as the slash result would persist it into the assistant
      // transcript, so the secret is routed into a dedicated pane
      // (`kind: "portal-token"`) — the host renders the QR + URL
      // inline, dismisses on Esc / 'y' (copy via OSC 52), and the
      // slash return only carries non-secret context (token id,
      // expiry, ttl). Mirrors the AdminTab API-key flow, which
      // surfaces the plaintext once and never re-shows it.
      const workflowId = rawArgs[0];
      if (!workflowId) {
        return "/session usage: `/session <workflow-id>` — engine requires at least one workflow scope per portal token";
      }
      try {
        const me = await ctx.client.whoami();
        const ttlMinutes =
          typeof ctx.prefs?.portalTokenTtlMin === "number" && ctx.prefs.portalTokenTtlMin > 0
            ? ctx.prefs.portalTokenTtlMin
            : 15;
        const issued = (await ctx.client.issuePortalToken({
          user_id: me.id,
          allowed_workflows: [workflowId],
          ttl_minutes: ttlMinutes,
        })) as {
          id: string;
          plaintext_token?: string;
          prefix?: string;
          expires_at: string;
        };
        const token = issued.plaintext_token ?? "";
        if (!token) return "/session: engine did not return a token";
        const url = `${ctx.profile.engine_url.replace(/\/$/, "")}/portal#token=${token}`;
        if (ctx.openPane) {
          ctx.openPane({
            kind: "portal-token",
            url,
            ttl_minutes: ttlMinutes,
            token_id: issued.id,
            expires_at: issued.expires_at,
            workflow_id: workflowId,
          });
          // Transcript message contains only the prefix + expiry — no
          // plaintext token bytes. Operator copies the URL from the
          // pane via OSC 52 / 'y'.
          const prefix = issued.prefix ?? issued.id.slice(0, 8);
          return `portal token issued (token id ${prefix}, ${ttlMinutes} min, single-use) — pane opened with QR + URL; copy the URL there and dismiss on Esc.`;
        }
        // Headless / non-Ink fallback: print a redacted summary; never
        // emit the plaintext URL into the transcript when no pane is
        // available. Operator-scripted environments should use the
        // engine route directly.
        return `/session: issued portal token (id ${issued.id}, expires ${issued.expires_at}) — open an interactive REPL to view the QR + URL.`;
      } catch (err) {
        const msg = err instanceof Error ? err.message : String(err);
        return `/session failed: ${msg}`;
      }
    }
    case "export": {
      // Render the current session transcript to a Markdown file in
      // the current working directory. Covers user/assistant messages,
      // call history (with truncated output), and the usage summary so
      // operators can share a conversation without screenshots.
      if (!ctx.session.conversationId) return "no active conversation to export";
      const parts: string[] = [];
      const convId = ctx.session.conversationId;
      parts.push(`# sk conversation ${convId}`);
      parts.push("");
      parts.push(`- exported: ${new Date().toISOString()}`);
      parts.push(`- profile: ${ctx.profile.name}`);
      parts.push(`- engine: ${ctx.profile.engine_url}`);
      parts.push("");
      const byId = new Map<string, (typeof ctx.session.toolCalls)[number][]>();
      const orphan: (typeof ctx.session.toolCalls)[number][] = [];
      for (const tc of ctx.session.toolCalls) {
        if (tc.parent_message_id) {
          const list = byId.get(tc.parent_message_id) ?? [];
          list.push(tc);
          byId.set(tc.parent_message_id, list);
        } else {
          orphan.push(tc);
        }
      }
      for (let i = 0; i < ctx.session.messages.length; i++) {
        const m = ctx.session.messages[i];
        if (!m) continue;
        const header =
          m.role === "user"
            ? "### User"
            : m.role === "assistant"
              ? "### Assistant"
              : m.role === "tool"
                ? "### Tool result"
                : "### System";
        parts.push(header);
        parts.push("");
        parts.push(m.content || "_(empty)_");
        parts.push("");
        const tcs = m.id ? byId.get(m.id) : undefined;
        if (tcs && tcs.length > 0) {
          for (const tc of tcs) {
            parts.push(`**call:** \`${tc.name}\` · ${tc.status}`);
            if (tc.args !== undefined) {
              parts.push("```json");
              parts.push(JSON.stringify(tc.args, null, 2).slice(0, 2000));
              parts.push("```");
            }
            if (tc.result !== undefined) {
              parts.push("```json");
              parts.push(JSON.stringify(tc.result, null, 2).slice(0, 2000));
              parts.push("```");
            }
            if (tc.error) parts.push(`> error: ${tc.error}`);
            parts.push("");
          }
        }
      }
      if (orphan.length > 0) {
        parts.push("### Orphan calls (no parent message)");
        for (const tc of orphan) {
          parts.push(`- \`${tc.name}\` · ${tc.status}`);
        }
        parts.push("");
      }
      if (ctx.session.usage) {
        parts.push("### Usage");
        parts.push("```json");
        parts.push(JSON.stringify(ctx.session.usage, null, 2));
        parts.push("```");
      }
      const ts = new Date().toISOString().replace(/[:.]/g, "-");
      const filename = `sk-transcript-${convId.slice(0, 8)}-${ts}.md`;
      const absPath = join(process.cwd(), filename);
      try {
        fs.writeFileSync(absPath, parts.join("\n"), "utf8");
      } catch (err) {
        return `export failed: ${(err as Error).message}`;
      }
      return `exported to ${filename}`;
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
            last_message_role: it.last_message_role ?? null,
            last_message_excerpt: it.last_message_excerpt ?? null,
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
    default:
      return undefined;
  }
}
