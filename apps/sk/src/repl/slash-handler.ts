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
import { debugLogPath, debugLogTail, isDebugMode, setDebugMode } from "../debug.ts";
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

function asRecord(value: unknown): Record<string, unknown> | null {
  return typeof value === "object" && value !== null && !Array.isArray(value)
    ? (value as Record<string, unknown>)
    : null;
}

function recordString(value: unknown, fallback = "—"): string {
  return typeof value === "string" && value.length > 0 ? value : fallback;
}

function scalarString(value: unknown, fallback = "—"): string {
  if (typeof value === "string" && value.length > 0) return value;
  if (typeof value === "number" || typeof value === "boolean") return String(value);
  return fallback;
}

function draftRecord(value: unknown): Record<string, unknown> | null {
  return asRecord(value);
}

function formatDraftSummaryLines(draft: Record<string, unknown> | null): string[] {
  if (!draft) return ["no authoring state available"];
  const summary = asRecord(draft.summary);
  const workflow = asRecord(draft.workflow);
  const connector = asRecord(draft.connector);
  const lines: string[] = [
    `mode: ${recordString(draft.mode, "onboarding")}`,
    `readiness: ${recordString(summary?.readiness)}`,
    `next action: ${recordString(summary?.next_action)}`,
  ];
  const progress = recordString(summary?.progress_label, "");
  if (progress !== "") lines.push(`progress: ${progress}`);
  const missingFields = Array.isArray(summary?.missing_fields)
    ? summary.missing_fields.filter((field): field is string => typeof field === "string")
    : [];
  if (missingFields.length > 0) {
    lines.push(`missing: ${missingFields.join(", ")}`);
  }
  lines.push("");
  lines.push("connector:");
  if (connector) {
    lines.push(`  name: ${recordString(connector.name)}`);
    lines.push(`  driver: ${recordString(connector.driver)}`);
    lines.push(`  environment: ${recordString(connector.environment)}`);
    lines.push(`  auth: ${recordString(connector.auth_type)}`);
    const latestProbe = asRecord(connector.latest_probe);
    if (latestProbe) lines.push(`  probe: ${scalarString(latestProbe.summary)}`);
    const savedId = scalarString(connector.saved_connector_id, "");
    if (savedId !== "") lines.push(`  saved id: ${savedId}`);
  } else {
    lines.push("  no connector draft");
  }
  lines.push("");
  lines.push("workflow:");
  if (workflow) {
    const steps = Array.isArray(workflow.steps) ? workflow.steps.length : 0;
    lines.push(`  name: ${recordString(workflow.name)}`);
    lines.push(`  slug: ${recordString(workflow.slug)}`);
    lines.push(`  steps: ${steps}`);
    const preview = asRecord(draft.latest_preview);
    if (preview) lines.push(`  latest preview: ${recordString(preview.summary)}`);
  } else {
    lines.push("  no workflow draft");
  }
  return lines;
}

function formatConnectorLines(draft: Record<string, unknown> | null): string[] {
  if (!draft) return ["no authoring state available"];
  const connector = asRecord(draft.connector);
  if (!connector) return ["no connector draft in this conversation"];
  const validation = asRecord(connector.validation);
  const latestProbe = asRecord(connector.latest_probe);
  const lines = [
    `name: ${recordString(connector.name)}`,
    `slug: ${recordString(connector.slug)}`,
    `driver: ${recordString(connector.driver)}`,
    `environment: ${recordString(connector.environment)}`,
    `auth: ${recordString(connector.auth_type)}`,
    `base_url: ${recordString(connector.base_url)}`,
    `dsn: ${recordString(connector.dsn)}`,
    `template: ${recordString(connector.template_name ?? connector.template_id, "scratch")}`,
    `saved id: ${recordString(connector.saved_connector_id)}`,
    "",
    `validation: ${scalarString(validation?.ok === true ? "ok" : "needs work")}`,
  ];
  const missingFields = Array.isArray(validation?.missing_fields)
    ? validation.missing_fields.filter((field): field is string => typeof field === "string")
    : [];
  if (missingFields.length > 0) lines.push(`missing: ${missingFields.join(", ")}`);
  if (latestProbe) {
    lines.push("");
    lines.push(`probe: ${scalarString(latestProbe.summary)}`);
    lines.push(`probe env: ${scalarString(latestProbe.environment)}`);
    lines.push(
      `probe method/path: ${scalarString(latestProbe.method)} ${scalarString(latestProbe.path)}`,
    );
    lines.push(`probe status: ${scalarString(latestProbe.status_code)}`);
  }
  return lines;
}

function formatWorkflowLines(draft: Record<string, unknown> | null): string[] {
  if (!draft) return ["no authoring state available"];
  const workflow = asRecord(draft.workflow);
  if (!workflow) return ["no workflow draft in this conversation"];
  const steps = Array.isArray(workflow.steps)
    ? workflow.steps.filter((step): step is Record<string, unknown> => asRecord(step) !== null)
    : [];
  const lines = [
    `name: ${recordString(workflow.name)}`,
    `slug: ${recordString(workflow.slug)}`,
    `description: ${recordString(workflow.description)}`,
    `steps: ${steps.length}`,
  ];
  if (steps.length > 0) {
    lines.push("");
    lines.push("step list:");
    for (const [index, step] of steps.entries()) {
      lines.push(
        `  ${index + 1}. ${recordString(step.id, `step-${index + 1}`)} · ${recordString(step.kind, "unknown")}`,
      );
    }
  }
  const preview = asRecord(draft.latest_preview);
  if (preview) {
    lines.push("");
    lines.push(`latest preview: ${scalarString(preview.summary)}`);
  }
  return lines;
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
    case "draft": {
      if (!ctx.session.conversationId) return "no active conversation";
      const detail = await ctx.client.getConversation(ctx.session.conversationId);
      return panify(ctx, "draft overview", formatDraftSummaryLines(draftRecord(detail.draft)));
    }
    case "connector": {
      if (!ctx.session.conversationId) return "no active conversation";
      const detail = await ctx.client.getConversation(ctx.session.conversationId);
      return panify(ctx, "connector draft", formatConnectorLines(draftRecord(detail.draft)));
    }
    case "workflow": {
      if (!ctx.session.conversationId) return "no active conversation";
      const detail = await ctx.client.getConversation(ctx.session.conversationId);
      return panify(ctx, "workflow draft", formatWorkflowLines(draftRecord(detail.draft)));
    }
    case "templates": {
      if (!ctx.session.conversationId) return "no active conversation";
      const detail = await ctx.client.getConversation(ctx.session.conversationId);
      const draft = draftRecord(detail.draft);
      const connector = draft ? asRecord(draft.connector) : null;
      const lines: string[] = [];
      if (connector?.template_name) {
        lines.push(`current template: ${scalarString(connector.template_name)}`);
        if (connector.template_id) {
          lines.push(`template id: ${scalarString(connector.template_id)}`);
        }
        lines.push("");
      }
      lines.push(
        "Ask the assistant to `suggest_connector_templates` for a ranked list,",
        "or use `start_connector_from_template` to seed a draft from one.",
        "",
        "Templates are optional — describe the system in your own words any time.",
      );
      return panify(ctx, "connector templates", lines);
    }
    case "probe": {
      if (!ctx.session.conversationId) return "no active conversation";
      const detail = await ctx.client.getConversation(ctx.session.conversationId);
      const draft = draftRecord(detail.draft);
      const connector = draft ? asRecord(draft.connector) : null;
      if (!connector) {
        return panify(ctx, "probe", [
          "no connector draft — start one with `start_connector_from_description` or `start_connector_from_template`.",
        ]);
      }
      const probe = asRecord(connector.latest_probe);
      if (!probe) {
        return panify(ctx, "probe", [
          "no probe run yet on this draft.",
          "Ask the assistant to run `probe_connector_draft` before saving.",
        ]);
      }
      const lines: string[] = [
        `status: ${probe.ok ? "ok" : "failed"}`,
        `method: ${recordString(probe.method, "GET")}`,
        `path: ${recordString(probe.path, "/")}`,
        `environment: ${recordString(probe.environment, "dev")}`,
      ];
      if (probe.status_code !== undefined) lines.push(`http: ${probe.status_code}`);
      if (probe.duration_ms !== undefined) lines.push(`duration: ${probe.duration_ms}ms`);
      if (probe.summary) lines.push("", scalarString(probe.summary));
      if (probe.failure_code) lines.push(`failure code: ${scalarString(probe.failure_code)}`);
      return panify(ctx, "latest probe", lines);
    }
    case "preview": {
      if (!ctx.session.conversationId) return "no active conversation";
      const detail = await ctx.client.getConversation(ctx.session.conversationId);
      const draft = draftRecord(detail.draft);
      const preview = draft ? asRecord(draft.latest_preview) : null;
      if (!preview) {
        return panify(ctx, "preview", [
          "no preview run yet on this draft.",
          "Ask the assistant to run `dry_run_step` or `dry_run_workflow` before committing.",
        ]);
      }
      const lines: string[] = [`status: ${preview.ok ? "ok" : "failed"}`];
      if (preview.step_id) lines.push(`step: ${scalarString(preview.step_id)}`);
      if (preview.summary) lines.push("", scalarString(preview.summary));
      return panify(ctx, "latest preview", lines);
    }
    case "versions": {
      if (!ctx.session.conversationId) return "no active conversation";
      const detail = await ctx.client.getConversation(ctx.session.conversationId);
      const conv = detail.conversation as { target_workflow_id?: string | null };
      if (!conv.target_workflow_id) {
        return panify(ctx, "versions", ["no committed workflow bound to this conversation yet."]);
      }
      const res = await ctx.client.listWorkflowVersions(conv.target_workflow_id);
      if (res.items.length === 0) {
        return panify(ctx, "versions", ["no versions recorded for this workflow"]);
      }
      const lines = [
        `workflow: ${conv.target_workflow_id}`,
        "",
        ...res.items.map((v) => {
          const when = new Date(v.created_at).toISOString().slice(0, 19).replace("T", " ");
          return `  v${v.version}  ${when}  ${v.note ?? ""}`.trimEnd();
        }),
        "",
        "Restore a version with `/restore <n>`.",
      ];
      return panify(ctx, "versions", lines);
    }
    case "restore": {
      if (!ctx.session.conversationId) return "no active conversation";
      const detail = await ctx.client.getConversation(ctx.session.conversationId);
      const conv = detail.conversation as { target_workflow_id?: string | null };
      if (!conv.target_workflow_id) {
        return "no committed workflow bound to this conversation — nothing to restore";
      }
      const arg = rawArgs[0];
      const version = arg ? Number.parseInt(arg, 10) : Number.NaN;
      if (!Number.isFinite(version) || version <= 0) {
        return "usage: /restore <version-number>";
      }
      const restored = await ctx.client.restoreWorkflowVersion(conv.target_workflow_id, version);
      return `restored workflow ${restored.id} to version ${version} (new current version ${restored.version})`;
    }
    case "context": {
      if (!ctx.session.conversationId) return "no active conversation";
      const snapshot = await ctx.client.getConversationContextSnapshot(ctx.session.conversationId);
      const lines = [
        `draft mode: ${snapshot.draft_mode}`,
        `readiness: ${snapshot.draft_summary?.readiness ?? "—"}`,
        `next action: ${snapshot.draft_summary?.next_action ?? "—"}`,
        `messages: ${snapshot.messages.total}`,
        `last role: ${snapshot.messages.last_role ?? "—"}`,
        `tool calls: ${snapshot.tool_calls_total}`,
        `pending elicitations: ${snapshot.pending_elicitations}`,
        "",
        `skills in scope: ${snapshot.skills.total}`,
        `global: ${snapshot.skills.global.map((skill) => skill.title).join(", ") || "—"}`,
        `connector: ${snapshot.skills.connector.map((skill) => skill.title).join(", ") || "—"}`,
        `workflow: ${snapshot.skills.workflow.map((skill) => skill.title).join(", ") || "—"}`,
      ];
      return panify(ctx, "conversation context", lines);
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
    case "logs": {
      // /logs [limit] [trace_id?]
      //
      // Pure HTTP — calls `GET /v1/diagnostics/errors` on the engine
      // with the operator's API key. NO ssh, NO doctl, NO process
      // spawn, NO out-of-band infra access. The engine maintains an
      // in-memory ring of the last N captured 5xx responses (set by
      // errorMiddleware) and filters to the caller's tenant.
      //
      // Args:
      //   /logs                   — last 20 errors for this tenant
      //   /logs 50                — last 50
      //   /logs 50 <trace_id>     — only entries matching the trace_id
      //                              from a banner you saw earlier
      const limitArg = rawArgs[0];
      const traceArg = rawArgs[1];
      const limit = limitArg ? Math.max(1, Math.min(200, Number.parseInt(limitArg, 10) || 20)) : 20;
      const query: { limit: number; trace_id?: string } = { limit };
      if (traceArg) query.trace_id = traceArg;
      const res = await ctx.client.tailEngineErrors(query);
      if (res.items.length === 0) {
        return panify(ctx, "engine errors", [
          traceArg
            ? `no errors matching trace_id ${traceArg} in the buffer`
            : "no captured errors yet — the ring is empty",
          `(buffer holds ${res.total_buffered}/${200} most recent 5xx)`,
        ]);
      }
      const lines: string[] = [];
      for (const e of res.items) {
        const time = e.ts.replace("T", " ").replace(/\.\d+Z$/, "Z");
        lines.push(
          `${time}  ${e.method} ${e.path}  →  ${e.status} ${e.code}  trace=${e.trace_id ?? "-"}`,
        );
        if (e.message) lines.push(`  ${e.message}`);
        if (e.stack) {
          // Show first 3 stack frames — full stack is in the engine's
          // structured logger; this surface is a quick triage tool.
          const frames = e.stack.split("\n").slice(1, 4);
          for (const f of frames) lines.push(`  ${f.trim()}`);
        }
        lines.push("");
      }
      return panify(
        ctx,
        "engine errors",
        lines,
        `${res.items.length} of ${res.total_buffered} buffered`,
      );
    }
    case "debug": {
      // /debug         → status (on/off + path + line count)
      // /debug on/off  → toggle the in-process flag (env stays the source of truth on next launch)
      // /debug tail    → render the last 40 lines of the debug log
      // /debug path    → just the file path (handy for `tail -f` outside the REPL)
      const sub = (rawArgs[0] ?? "").toLowerCase();
      if (sub === "on" || sub === "off") {
        setDebugMode(sub === "on");
        const path = debugLogPath();
        return panify(ctx, `debug ${sub}`, [
          sub === "on"
            ? `request logging enabled — appending to ${path}`
            : "request logging disabled (env SK_DEBUG / --debug still works on next launch)",
        ]);
      }
      if (sub === "path") {
        return debugLogPath();
      }
      if (sub === "tail") {
        const lines = debugLogTail(40);
        if (lines.length === 0) {
          return panify(ctx, "debug log empty", [
            `path: ${debugLogPath()}`,
            "no records yet — set SK_DEBUG=1 (or run `/debug on`) and reproduce the request",
          ]);
        }
        return panify(ctx, "debug log (tail)", lines, debugLogPath());
      }
      const active = isDebugMode();
      return panify(ctx, `debug ${active ? "on" : "off"}`, [
        `path: ${debugLogPath()}`,
        active
          ? "every HTTP request to the engine is logged as JSONL"
          : "logging is OFF — turn on with `/debug on`, env `SK_DEBUG=1`, or `--debug` flag",
        "subcommands: `/debug on` · `/debug off` · `/debug tail` · `/debug path`",
      ]);
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
