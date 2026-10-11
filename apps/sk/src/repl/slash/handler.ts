import fs from "node:fs";
import { homedir } from "node:os";
import { join } from "node:path";
import type { ConversationItem } from "@chat-ui/index.ts";
import type { SkSessionState } from "@cli-core/index.ts";
import { loadConfig, type ResolvedProfile, saveConfig } from "../../config.ts";
import {
  debugLog,
  debugLogPath,
  debugLogTail,
  isDebugVerbose,
  setDebugVerbose,
} from "../../debug.ts";
import type {
  ConversationContextSnapshot,
  EngineClient,
  SetupValidationResponse,
  StatusSummary,
} from "../../engine-client.ts";
import { loadSettings, saveUserSettingsPatch } from "../../settings.ts";
import { recordUsage } from "../../usage-stats.ts";
import type {
  OnboardingProbeResult,
  OnboardingSaveResult,
  OnboardingTemplate,
} from "../onboarding-wizard.tsx";
import { classifySlash, unsupportedSlashGuidance } from "./dispatcher.ts";
import { dispatchAdminListSlash } from "./handlers/admin-lists.ts";
import { dispatchAuthRedirectSlash } from "./handlers/auth-redirects.ts";
import { dispatchAuthoringDraftSlash } from "./handlers/authoring-drafts.ts";
import { dispatchChatSpaceSlash } from "./handlers/chat-spaces.ts";
import { dispatchInspectSlash } from "./handlers/inspect.ts";
import { dispatchKnowledgeSlash } from "./handlers/knowledge.ts";
import { dispatchOnboardingSlash } from "./handlers/onboarding.ts";
import { dispatchSessionSlash } from "./handlers/session-lifecycle.ts";

export type PaneSpec =
  | {
      kind: "config-form";
      title: string;
      fields: ReadonlyArray<{
        name: string;
        label: string;
        type: "text" | "number" | "boolean";
        default?: unknown;
        help?: string;
        group?: string;
        required?: boolean;
      }>;
      onSave: (values: Record<string, unknown>) => Promise<string>;
    }
  | {
      kind: "status";
      title?: string;
      subtitle?: string;
      rows: ReadonlyArray<readonly [string, string | number | null | undefined]>;
    }
  | { kind: "conversations"; items: ReadonlyArray<ConversationItem> }
  | {
      kind: "template-picker";
      title: string;
      current_template: string | null;
      connector_name: string | null;
      lines: ReadonlyArray<string>;
    }
  | {
      kind: "connector-draft";
      title: string;
      connector: {
        name: string;
        slug: string;
        driver: string;
        environment: string;
        auth_type: string;
        base_url: string;
        dsn: string;
        template: string;
        saved_id: string;
      };
      missing_fields: ReadonlyArray<string>;
      latest_probe: {
        ok: boolean;
        method: string;
        path: string;
        environment: string;
        status: string;
        duration: string;
        summary: string;
        failure_code: string;
      } | null;
    }
  | {
      kind: "workflow-draft";
      title: string;
      workflow: {
        name: string;
        slug: string;
        description: string;
        steps: ReadonlyArray<{ id: string; kind: string }>;
      };
      latest_preview: {
        ok: boolean;
        step: string;
        summary: string;
      } | null;
    }
  | {
      kind: "step-detail";
      title: string;
      step: {
        id: string;
        kind: string;
        ordinal: number;
        lines: ReadonlyArray<string>;
      };
    }
  | {
      kind: "context";
      title: string;
      snapshot: ConversationContextSnapshot;
    }
  | {
      kind: "probe-results";
      title: string;
      probe: {
        ok: boolean;
        method: string;
        path: string;
        environment: string;
        http: string;
        duration: string;
        summary: string;
        failure_code: string;
      };
    }
  | {
      kind: "preview-results";
      title: string;
      preview: {
        ok: boolean;
        step: string;
        summary: string;
        lines: ReadonlyArray<string>;
      };
    }
  | {
      kind: "version-browser";
      title: string;
      workflow_id: string;
      items: ReadonlyArray<{ version: number; created_at: string; note: string | null }>;
    }
  | {
      kind: "approval-history";
      title: string;
      items: ReadonlyArray<{
        tool: string;
        created_at: string;
        summary: string;
        status: string;
      }>;
    }
  | {
      kind: "setup-diagnostics";
      title: string;
      setup: SetupValidationResponse;
    }
  | {
      kind: "onboarding-wizard";
      title: string;
      templates: ReadonlyArray<OnboardingTemplate>;
      onProbe: (template: OnboardingTemplate, credential: string) => Promise<OnboardingProbeResult>;
      onSave: (template: OnboardingTemplate, credential: string) => Promise<OnboardingSaveResult>;
      onComplete: (result: { status: "saved" | "cancelled" | "skipped"; reason?: string }) => void;
    }
  | {
      kind: "text";
      title: string;
      subtitle?: string;
      lines: ReadonlyArray<string>;
    }
  | {
      kind: "structured";
      title: string;
      subtitle?: string;
      sections: ReadonlyArray<{
        heading: string;
        tone?: "ok" | "warn" | "fail" | "info";
        rows: ReadonlyArray<readonly [string, string | number | null | undefined]>;
      }>;
    }
  | {
      kind: "settings";
      initialTab?: string;
      sessionId?: string | null;
      sessionTitle?: string | null;
      permissionMode?: "ask" | "auto" | "plan" | "yolo";
      sessionTokens?: number | null;
      weekTokens?: number | null;
      tenant?: string | null;
    }
  | {
      kind: "portal-token";
      url: string;
      ttl_minutes: number;
      token_id: string;
      expires_at: string;
      workflow_id: string;
    }
  | {
      kind: "permissions";
      tenant?: string | null;
    }
  | { kind: "profile"; tenant?: string | null }
  | { kind: "admin"; tenant?: string | null };

export interface SlashHandlerContext {
  client: EngineClient;
  profile: ResolvedProfile;
  session: SkSessionState;
  setConversationId: (id: string | null) => void;
  allowedPermissions: readonly string[];
  switchProfile?: (name: string) => Promise<string | null>;
  statusSnapshot?: StatusSummary | null;
  setupSnapshot?: SetupValidationResponse | null;
  bootstrapSnapshot?: {
    fetchedAt: number;
    source: "network" | "cache" | "fallback";
    label: string;
  } | null;
  prefs?: {
    portalTokenTtlMin?: number;
    [k: string]: unknown;
  } | null;
  openPane?: (spec: PaneSpec) => void;
  configPath?: string;
}

export function panify(
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
  return [subtitle !== undefined ? `${title} — ${subtitle}` : title, "", ...lines].join("\n");
}

function pluralize(count: number, singular: string, plural = `${singular}s`): string {
  return `${count} ${count === 1 ? singular : plural}`;
}

function formatSetupSummary(setup: SetupValidationResponse): string {
  return `${setup.overall_status} · ${pluralize(setup.summary_counts.blockers, "blocker")} · ${pluralize(setup.summary_counts.warnings, "warning")}`;
}

function formatSetupLines(setup: SetupValidationResponse): string[] {
  const lines: string[] = [
    `overall: ${setup.overall_status}`,
    `blockers: ${setup.summary_counts.blockers}`,
    `warnings: ${setup.summary_counts.warnings}`,
    "",
  ];
  for (const [sectionId, section] of Object.entries(setup.sections)) {
    lines.push(`${section.title} (${sectionId}) · ${section.status}`);
    for (const issue of section.issues) {
      lines.push(`  ${issue.severity}: ${issue.title} — ${issue.detail}`);
    }
    for (const value of section.values) {
      const rendered = value.value ?? "—";
      const hint = value.status_hint ? ` (${value.status_hint})` : "";
      lines.push(`  ${value.key}: ${rendered}${hint}`);
    }
    for (const recommendation of section.recommendations) {
      lines.push(`  fix: ${recommendation}`);
    }
    lines.push("");
  }
  return lines;
}

export async function handleSlash(
  name: string,
  rawArgs: string[],
  ctx: SlashHandlerContext,
): Promise<string | null> {
  recordUsage(name);
  const plan = classifySlash(name);
  if (plan.routing === "unknown") {
    debugLog("dialog.warning", { reason: "unknown_slash", slash_name: name }, {});
    const hint = unsupportedSlashGuidance(name);
    if (hint) return `/${name} ${hint}`;
  } else {
    debugLog("dialog.elicitation_routing", { slash_name: name, routing: plan.routing }, {});
  }
  if (plan.command?.argsSchema) {
    const parsed = plan.command.argsSchema.safeParse(rawArgs);
    if (!parsed.success) {
      const issue = parsed.error.issues[0];
      const where = issue?.path?.length ? `[${issue.path.join(".")}] ` : "";
      return `/${name}: invalid args — ${where}${issue?.message ?? "schema validation failed"}`;
    }
  }
  const dispatchName = plan.command?.name ?? name;
  switch (dispatchName) {
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
      if (ctx.bootstrapSnapshot) {
        const ageMs = Date.now() - ctx.bootstrapSnapshot.fetchedAt;
        const ageMin = Math.max(0, Math.floor(ageMs / 60_000));
        const fmtAge = ageMin < 60 ? `${ageMin}m` : `${(ageMin / 60).toFixed(1)}h`;
        rows.push(["persona · source", ctx.bootstrapSnapshot.source]);
        rows.push(["persona · age", fmtAge]);
        rows.push(["persona · label", ctx.bootstrapSnapshot.label]);
      }
      if (ctx.setupSnapshot) {
        rows.push(["setup", formatSetupSummary(ctx.setupSnapshot)]);
        rows.push(["setup · hint", "use /setup for details"]);
      }
      if (ctx.openPane) {
        ctx.openPane({
          kind: "status",
          title: "status",
          subtitle: ctx.profile.name,
          rows,
        });
        return null;
      }
      return rows
        .map(
          ([label, value]) =>
            `${label.padEnd(20, " ")} ${value === undefined || value === null ? "—" : value}`,
        )
        .join("\n");
    }
    case "setup": {
      const setup = await ctx.client.setupValidation();
      if (ctx.openPane) {
        ctx.openPane({ kind: "setup-diagnostics", title: "setup", setup });
        return null;
      }
      return panify(ctx, "setup", formatSetupLines(setup), formatSetupSummary(setup));
    }
    case "install-space":
      return (await dispatchChatSpaceSlash(rawArgs, ctx)) ?? null;
    case "knowledge":
      return (await dispatchKnowledgeSlash(rawArgs, ctx)) ?? null;
    case "install":
    case "onboard":
      return (await dispatchOnboardingSlash(dispatchName, ctx)) ?? null;
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
        const b = usage.breakdown;
        if (b) {
          const fmt = (n: number) => (n >= 1000 ? `${(n / 1000).toFixed(1)}k` : n.toLocaleString());
          lines.push("");
          lines.push("prompt breakdown for this turn:");
          lines.push(`  system     ${fmt(b.system).padStart(8)}`);
          lines.push(`  skills     ${fmt(b.skills).padStart(8)}`);
          lines.push(`  knowledge  ${fmt(b.knowledge).padStart(8)}`);
          lines.push(`  docs       ${fmt(b.docs).padStart(8)}`);
          lines.push(`  failures   ${fmt(b.failures).padStart(8)}`);
          lines.push(`  messages   ${fmt(b.messages).padStart(8)}`);
          lines.push(`  total      ${fmt(b.total).padStart(8)}`);
        }
      } else {
        lines.push("no turn-level usage recorded yet this session");
      }
      if (snap) {
        lines.push("");
        lines.push(`tokens · today       ${snap.tokens_today.toLocaleString()}`);
        lines.push(`tokens · month       ${snap.tokens_month.toLocaleString()}`);
        if (snap.monthly_budget_tokens !== null) {
          lines.push(`budget · monthly     ${snap.monthly_budget_tokens.toLocaleString()} tok`);
        }
        if (snap.tokens_month_user !== null) {
          lines.push("");
          lines.push(`you · today          ${(snap.tokens_today_user ?? 0).toLocaleString()}`);
          lines.push(`you · month          ${snap.tokens_month_user.toLocaleString()}`);
          if (snap.user_monthly_budget_tokens !== null) {
            lines.push(
              `you · budget         ${snap.user_monthly_budget_tokens.toLocaleString()} tok`,
            );
            const userRemaining =
              snap.user_remaining_monthly_budget_tokens == null
                ? "∞"
                : snap.user_remaining_monthly_budget_tokens.toLocaleString();
            lines.push(`you · remaining      ${userRemaining}`);
          }
        }
      }
      return panify(ctx, "cost", lines);
    }
    case "exec": {
      const arg = (rawArgs[0] ?? "").trim();
      let executionId: string | null = arg.length > 0 ? arg : null;
      if (!executionId) {
        if (!ctx.session.conversationId) return "no active conversation";
        try {
          const detail = await ctx.client.getConversation(ctx.session.conversationId);
          const draft = detail.draft as {
            state?: { latest_execution?: { execution_id?: string } };
          } | null;
          executionId = draft?.state?.latest_execution?.execution_id ?? null;
        } catch {
          executionId = null;
        }
      }
      if (!executionId) {
        return panify(ctx, "logs", [
          "no execution available — pass /logs <execution_id> or run a workflow first",
        ]);
      }
      try {
        const stepsRes = await ctx.client.executionSteps(executionId);
        const items = Array.isArray(stepsRes.items) ? stepsRes.items : [];
        if (items.length === 0) {
          return panify(ctx, `logs · ${executionId.slice(0, 8)}`, [
            "no steps recorded for this execution",
          ]);
        }
        const lines = items.map((row) => {
          const r = row as Record<string, unknown>;
          const key = typeof r.step_key === "string" ? r.step_key : "?";
          const kind = typeof r.kind === "string" ? r.kind : "?";
          const status = typeof r.status === "string" ? r.status : "?";
          const dur = typeof r.duration_ms === "number" ? `${r.duration_ms}ms` : "—";
          const errVal = r.error;
          const errMsg =
            errVal && typeof errVal === "object" && errVal !== null
              ? (errVal as { message?: unknown }).message
              : null;
          const glyph = status === "succeeded" ? "✓" : status === "failed" ? "✗" : "·";
          return `${glyph} ${key} (${kind}) · ${status} · ${dur}${
            typeof errMsg === "string" ? ` · ${errMsg}` : ""
          }`;
        });
        return panify(ctx, `logs · ${executionId.slice(0, 8)}`, lines);
      } catch (err) {
        const msg = err instanceof Error ? err.message : String(err);
        return panify(ctx, "logs", [`fetch failed: ${msg}`]);
      }
    }
    case "verbose": {
      const current = process.env.SK_VERBOSE === "1";
      process.env.SK_VERBOSE = current ? "0" : "1";
      return panify(ctx, "verbose", [
        current
          ? "verbose mode OFF — tool_log lines hidden in chat (still visible in /view inspect)"
          : "verbose mode ON — every tool's tool_log lines render inline under the card",
      ]);
    }
    case "draft":
    case "connector":
    case "workflow":
    case "templates":
    case "probe":
    case "preview":
    case "edit":
    case "snapshots":
    case "versions":
    case "restore":
    case "context":
    case "approvals":
    case "policy":
      return (await dispatchAuthoringDraftSlash(dispatchName, rawArgs, ctx)) ?? null;
    case "clear":
    case "new":
    case "copy":
    case "rename":
    case "fork":
    case "mention":
    case "settings":
    case "preferences":
    case "session":
    case "export":
    case "resume":
    case "compact":
    case "model":
      return (await dispatchSessionSlash(dispatchName, rawArgs, ctx)) ?? null;
    case "logs": {
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
      const sub = (rawArgs[0] ?? "").toLowerCase();
      if (sub === "on" || sub === "off") {
        setDebugVerbose(sub === "on");
        const path = debugLogPath();
        return panify(ctx, `debug ${sub}`, [
          sub === "on"
            ? `verbose mode on — HTTP bodies and raw SSE frames now persisted to ${path}`
            : "verbose mode off — metadata still logged; bodies omitted (env SK_DEBUG / --debug re-enables on next launch)",
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
            "no records yet — make a request and try again",
          ]);
        }
        return panify(ctx, "debug log (tail)", lines, debugLogPath());
      }
      const verbose = isDebugVerbose();
      return panify(ctx, `debug ${verbose ? "verbose" : "normal"}`, [
        `path: ${debugLogPath()} (rotates at 2 MB, keeps debug.log.1, debug.log.2)`,
        verbose
          ? "verbose: HTTP bodies + raw SSE frames are persisted on every request"
          : "normal: metadata only — turn verbose on with `/debug on`, env `SK_DEBUG=1`, or `--debug`",
        "subcommands: `/debug on` · `/debug off` · `/debug tail` · `/debug path`",
      ]);
    }
    case "memory": {
      const path = join(homedir(), ".sk", "SK.md");
      return `edit ${path} then restart sk to pick it up`;
    }
    case "init": {
      const cwd = process.cwd();
      const path = join(cwd, "SK.md");
      try {
        const cwdStat = fs.lstatSync(cwd);
        if (!cwdStat.isDirectory()) {
          return `init failed: ${cwd} is not a directory`;
        }
      } catch (err) {
        return `init failed: cannot stat ${cwd}: ${err instanceof Error ? err.message : String(err)}`;
      }
      try {
        const existing = fs.lstatSync(path);
        if (existing.isSymbolicLink()) {
          return `${path} is a symlink — refusing to write (remove or point at a regular file)`;
        }
        return `${path} already exists`;
      } catch {}
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
        fs.writeFileSync(path, starter, { encoding: "utf8", flag: "wx" });
        return `wrote ${path}`;
      } catch (err) {
        return `init failed: ${err instanceof Error ? err.message : String(err)}`;
      }
    }
    case "config":
    case "usage": {
      const initialTab = dispatchName === "config" ? "Config" : "Usage";
      if (ctx.openPane) {
        ctx.openPane({ kind: "settings", initialTab });
        return null;
      }
      return `open \`sk\` with the Ink REPL to use /${dispatchName}, or edit ${join(homedir(), ".sk", "settings.json")} directly`;
    }
    case "config-form": {
      if (ctx.openPane) {
        const current = loadSettings(process.cwd()).merged;
        ctx.openPane({
          kind: "config-form",
          title: "config-form",
          fields: [
            {
              name: "model",
              label: "Default model",
              type: "text",
              default: current.model ?? "",
              group: "Conversation",
              help: "Optional model id used for new conversations.",
            },
            {
              name: "includeMemoryFile",
              label: "Include SK.md memory",
              type: "boolean",
              default: current.includeMemoryFile !== false,
              group: "Context",
              help: "When enabled, SK.md is injected into new turns.",
            },
            {
              name: "maxInlineMentionBytes",
              label: "Max inline mention bytes",
              type: "number",
              default: current.maxInlineMentionBytes ?? 262144,
              group: "Context",
              help: "Large @file mentions above this size are truncated.",
            },
            {
              name: "statusLineRefreshMs",
              label: "Status refresh ms",
              type: "number",
              default: current.statusLine?.refreshMs ?? 500,
              group: "Status line",
              help: "Minimum interval for status-line refreshes.",
            },
          ],
          onSave: async (values) => {
            const patch: {
              model?: string;
              includeMemoryFile?: boolean;
              maxInlineMentionBytes?: number;
              statusLine?: { refreshMs?: number };
            } = {};
            const model = typeof values.model === "string" ? values.model.trim() : "";
            if (model) patch.model = model;
            if (typeof values.includeMemoryFile === "boolean") {
              patch.includeMemoryFile = values.includeMemoryFile;
            }
            if (
              typeof values.maxInlineMentionBytes === "number" &&
              Number.isFinite(values.maxInlineMentionBytes)
            ) {
              patch.maxInlineMentionBytes = values.maxInlineMentionBytes;
            }
            if (
              typeof values.statusLineRefreshMs === "number" &&
              Number.isFinite(values.statusLineRefreshMs)
            ) {
              patch.statusLine = { refreshMs: values.statusLineRefreshMs };
            }
            const path = saveUserSettingsPatch(patch);
            return `config saved to ${path}`;
          },
        });
        return null;
      }
      return `edit ${join(homedir(), ".sk", "settings.json")} or run /config-form in the Ink REPL for a guided form`;
    }
    case "feedback":
    case "bug": {
      return "report issues at https://github.com/subkit/subkit/issues";
    }
    case "profile":
    case "env": {
      const cfg = loadConfig(ctx.configPath);
      const profileNames = Object.keys(cfg.profiles);
      const subArg = rawArgs[0];

      if (subArg === "add") {
        return "run 'sk profile add' outside the REPL to create a new profile";
      }

      if (subArg && profileNames.includes(subArg)) {
        if (ctx.switchProfile) {
          return await ctx.switchProfile(subArg);
        }
        cfg.active_profile = subArg;
        saveConfig(cfg, ctx.configPath);
        return `switched to "${subArg}" — restart sk to use the new profile`;
      }

      if (subArg) {
        return `profile "${subArg}" not found. Available: ${profileNames.join(", ")}`;
      }

      if (name === "profile" && ctx.openPane) {
        const tenant = ctx.statusSnapshot?.tenant.slug ?? null;
        ctx.openPane({ kind: "profile", tenant });
        return null;
      }

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
    default: {
      const inspectResult = await dispatchInspectSlash(name, ctx);
      if (inspectResult !== undefined) return inspectResult;
      const adminListResult = await dispatchAdminListSlash(name, ctx);
      if (adminListResult !== undefined) return adminListResult;
      const authBanner = dispatchAuthRedirectSlash(name);
      if (authBanner !== undefined) return authBanner;
      return `/${name} is not wired — try /help`;
    }
  }
}
