// Shared slash-command handler reused by both the readline REPL
// and the Ink REPL. Pure function in, side-effecting calls through
// the provided EngineClient. Returns a string to display as a
// transient banner, or `null` when the command handled its own
// output (e.g. `/clear` which resets the session).
//
// Handlers that need cross-turn state mutation (`/clear`, `/resume`)
// call back through `setConversationId` — the caller owns the
// React / closure state shape.
//
// cf. `apps/sk/src/repl/slash/dispatcher.ts` — the dispatcher
// classifies each slash by its `routing` field (local vs. engine)
// before reaching this handler. This module owns only execution;
// classification + RBAC routing live in the dispatcher.

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
import { classifySlash, removedSlashGuidance } from "./dispatcher.ts";
import { dispatchAdminListSlash } from "./handlers/admin-lists.ts";
import { dispatchAuthRedirectSlash } from "./handlers/auth-redirects.ts";
import { dispatchAuthoringDraftSlash } from "./handlers/authoring-drafts.ts";
import { dispatchChatSpaceSlash } from "./handlers/chat-spaces.ts";
import { dispatchInspectSlash } from "./handlers/inspect.ts";
import { dispatchOnboardingSlash } from "./handlers/onboarding.ts";
import { dispatchSessionSlash } from "./handlers/session-lifecycle.ts";

/**
 * Rich pane descriptions returned by slash commands that open a modal
 * instead of (or in addition to) a one-line banner. The Ink host
 * renders the right component based on `kind`. Adding a new pane kind
 * means: extend this union, handle it in the host's modal slot, and
 * the readline fallback's text mirror.
 */
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
      /**
       * Onboarding wizard overlay launched by `/onboard`. The pane
       * carries the pre-fetched template catalog plus three callbacks
       * the slash handler wires to engine tools: probe, save, and
       * dismiss. Functions are kept on the spec because the wizard's
       * step machine needs to invoke them at arbitrary points; the
       * pane is otherwise opaque to the host.
       */
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
      /** Lines rendered verbatim inside the pane, one `<Text>` per line. */
      lines: ReadonlyArray<string>;
    }
  | {
      /**
       * Structured authoring pane. Each section carries a tone so the
       * Ink renderer can colour-code headings (green for ok / ready,
       * yellow for needs_input, red for failed, dim for info). Rows
       * inside a section are `[key, value]` pairs, optionally with a
       * tone override for a single row.
       */
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
      // /settings opened from the REPL — host renders SettingsModal
      // in-process with the operator's REPL state piped in so the
      // Status tab shows real session id / permission mode / tokens.
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
      // The portal-token mint flow never returns the plaintext token
      // through the slash result — slash returns are persisted into
      // the assistant transcript and the token is short-lived but
      // bearer-equivalent. Render the QR + URL inline in a transient
      // pane (mirroring the AdminTab ApiKeysSubTab "shown once"
      // yellow panel) and dismiss on Esc / 'y' (copy via OSC 52). The
      // token id (not the secret) is the
      // only thing we surface back to the transcript.
      kind: "portal-token";
      url: string;
      ttl_minutes: number;
      token_id: string;
      expires_at: string;
      workflow_id: string;
    }
  | {
      // `/permissions`, `/profile`, `/admin` — single-pane modals that
      // wrap the corresponding *Tab via SinglePane. Lifted out of
      // /settings as part of the 5-tab refactor; only the 5 surfaces
      // {Status, Config, Usage, Skills, Knowledge} remain inside
      // SettingsModal.
      kind: "permissions";
      tenant?: string | null;
    }
  | { kind: "profile"; tenant?: string | null }
  | { kind: "admin"; tenant?: string | null };

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
  /** Latest `/v1/diagnostics/setup` snapshot when the persona can read it. */
  setupSnapshot?: SetupValidationResponse | null;
  /**
   * Latest `/v1/sk/bootstrap` snapshot — passed through from the
   * Ink host's `usePersona` hook. Lets `/status` surface
   * `fetchedAt + source` so an operator rotating an api_key can see
   * whether the slash menu reflects the current token (network) or
   * a stale cache (cache, fallback).
   */
  bootstrapSnapshot?: {
    fetchedAt: number;
    source: "network" | "cache" | "fallback";
    label: string;
  } | null;
  /**
   * Engine-resolved REPL preferences. Carries `portalTokenTtlMin` so
   * `/session` mints with the tenant-tuned TTL instead of a magic
   * 15-minute literal.
   */
  prefs?: {
    portalTokenTtlMin?: number;
    [k: string]: unknown;
  } | null;
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
  // The subtitle carries the cardinality footer ("showing 20 of 45" /
  // "12 total") — dropping it in the banner fallback would hide the
  // ground-truth count from readline users, so render it inline.
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
  // Persist frequency for the autocomplete bias. Best-effort — a
  // write failure never blocks the dispatch.
  recordUsage(name);
  // Consume `classifySlash` so the dispatcher seam
  // is real, not aspirational. The classification is logged via
  // `debugLog` for telemetry and used to short-circuit unknown
  // commands; it never silently bypasses a registered command. A
  // future contributor who adds `/connectors` to `LOCAL_ONLY_NAMES`
  // by accident (or who tags a state-mutating command as
  // `routing: "local"` in the registry) can be caught by the
  // dispatcher's `_localOnlySnapshot()` test, which already enforces
  // that engine-routed commands stay out of the local set.
  const plan = classifySlash(name);
  if (plan.routing === "unknown") {
    debugLog("dialog.warning", { reason: "unknown_slash", slash_name: name }, {});
    // Short-circuit removed/never-shipped slashes with a one-line
    // guidance message pointing at the new home. The guidance map
    // lives in the dispatcher to keep the registry pure; entries
    // decay one release after the actual delete pass per
    // "no backwards-compat shims".
    const hint = removedSlashGuidance(name);
    if (hint) return `/${name} ${hint}`;
  } else {
    debugLog("dialog.elicitation_routing", { slash_name: name, routing: plan.routing }, {});
  }
  // Validate positional args against the per-
  // command Zod schema at the dispatcher boundary. Commands that
  // don't set `argsSchema` skip this check (default schema accepts
  // any string array). When validation fails, return a structured
  // error string the REPL renders as a transient banner — without
  // ever reaching the per-command branch below.
  if (plan.command?.argsSchema) {
    const parsed = plan.command.argsSchema.safeParse(rawArgs);
    if (!parsed.success) {
      const issue = parsed.error.issues[0];
      const where = issue?.path?.length ? `[${issue.path.join(".")}] ` : "";
      return `/${name}: invalid args — ${where}${issue?.message ?? "schema validation failed"}`;
    }
  }
  // Switch on the canonical command name (post-alias resolution)
  // rather than the typed string. The dispatcher's
  // `resolveSlashCommand` already maps `/install` → `/onboard`
  // (and `/quit` → `/exit`, `/bug` → `/feedback`, etc.) through
  // `command.aliases`. Switching on `plan.command?.name`
  // means the handler can drop the `case "install":` fallthrough
  // mirrors and there's exactly one branch per canonical slash.
  // When the command isn't in the registry (unknown / removed) the
  // typed name still flows through so the existing
  // `/${name}` error / removed-slash guidance branches still work.
  const dispatchName = plan.command?.name ?? name;
  switch (dispatchName) {
    case "status": {
      // `/status` is local-only by design — same shape as
      // `/cost`. Reads the Ink host's latest `/v1/status` snapshot
      // (refreshed every completed turn) without re-hitting the
      // engine. A "force refresh" path would belong on a separate
      // slash if it's ever needed.
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
      // Surface the bootstrap snapshot's source + age so an
      // operator who just rotated an api_key can tell whether the
      // slash menu reflects the current token or a stale cache. The
      // `loadBootstrap` cache TTL is 6h.
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
      // Readline fallback: render as a multi-line banner.
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
      // Pending-space list/install flow lives in handlers/chat-spaces.ts
      // to keep this file under the size cap.
      return (await dispatchChatSpaceSlash(rawArgs, ctx)) ?? null;
    // The `/onboard` wizard wiring (template catalog fetch + probe /
    // save callbacks) lives in handlers/onboarding.ts. The case labels
    // stay here so the dispatcher contract test keeps seeing one
    // branch per canonical slash in this file.
    case "install":
    case "onboard":
      return (await dispatchOnboardingSlash(dispatchName, ctx)) ?? null;
    case "cost": {
      // `/cost` is local-only by design — it reads
      // `ctx.statusSnapshot` (cached) and `ctx.session.usage` (in-
      // memory). The snapshot is refreshed by the Ink host after
      // every completed turn, so values are at-most one-turn stale;
      // refreshing on every `/cost` would burn an audit row + a
      // round-trip on a read-of-cached-state. Keep local.
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
        // Per-section breakdown — answers the user's "why is this turn
        // 88k tokens?" complaint by showing skills vs transcript vs
        // docs splits. Only rendered when the engine emitted them; a
        // turn that didn't drive an LLM call has no breakdown.
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
        // The caller's OWN figures, when the engine attributed them (a
        // user principal; null for system_account / API-key callers).
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
      // Per-step audit for an execution. With no argument, picks the
      // latest execution from the conversation's draft state. With an
      // explicit `<execution_id>` (full UUID or first 8 chars), fetches
      // that one. Renders one line per step — the same surface the
      // ExecutionDiagnosisCard summarizes — so the user can audit a
      // run from chat without leaving the REPL.
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
      // Toggle SK_VERBOSE for this REPL process. Inline tool_log lines
      // become visible/hidden under chat-mode tool cards. Persists for
      // the current session only — set SK_VERBOSE=1 in the environment
      // to make it the default.
      const current = process.env.SK_VERBOSE === "1";
      process.env.SK_VERBOSE = current ? "0" : "1";
      return panify(ctx, "verbose", [
        current
          ? "verbose mode OFF — tool_log lines hidden in chat (still visible in /view inspect)"
          : "verbose mode ON — every tool's tool_log lines render inline under the card",
      ]);
    }
    // Draft-centric authoring slashes — connector/workflow draft
    // inspection, probe/preview, direct edit, snapshots/versions,
    // context, approvals, and tool policies. Bodies live in
    // handlers/authoring-drafts.ts; the case labels stay here so the
    // dispatcher contract test keeps seeing one branch per canonical
    // slash in this file.
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
    // Session-lifecycle slashes — conversation reset/rename/fork,
    // transcript copy/export, portal-token minting, resume, compact,
    // and the settings deep-link. Bodies live in
    // handlers/session-lifecycle.ts; the case labels stay here so the
    // dispatcher contract test keeps seeing one branch per canonical
    // slash in this file.
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
    // /skills, /mcp, /permissions, /audit moved to handlers/inspect.ts
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
      // /debug         → status (verbose on/off + path + tail count)
      // /debug on/off  → toggle verbose body capture (HTTP bodies + raw SSE frames)
      // /debug tail    → render the last 40 lines of the debug log
      // /debug path    → just the file path (handy for `tail -f` outside the REPL)
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
      // Defend against TOCTOU + symlink races.
      //   1. `lstatSync` (not stat) so a symlinked SK.md doesn't
      //      mask the existence check.
      //   2. Use `wx` flag on writeFileSync so the create is atomic
      //      and refuses to overwrite an existing file (including a
      //      symlink target outside `cwd`). EEXIST is the safe
      //      "already exists" path; we report it the same way.
      //   3. Reject if `cwd` itself isn't a directory or isn't
      //      writable — the operator presumably ran sk in the wrong
      //      place.
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
      } catch {
        // ENOENT — fall through to create.
      }
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
        // `wx` = write, fail if exists. Atomic + symlink-safe via
        // open(2) O_CREAT|O_EXCL semantics.
        fs.writeFileSync(path, starter, { encoding: "utf8", flag: "wx" });
        return `wrote ${path}`;
      } catch (err) {
        return `init failed: ${err instanceof Error ? err.message : String(err)}`;
      }
    }
    case "config":
    case "usage": {
      // Deep-link into the SettingsModal on the matching tab for
      // `/config`, `/usage`. Status is the default landing,
      // so `/settings` alone (handled in case "settings" below) also
      // works. The legacy `config-form` 4-field user-settings prompt
      // moved to `/config-form` so this slot can host the full Config
      // tab (every engine leaf, searchable).
      const initialTab = dispatchName === "config" ? "Config" : "Usage";
      if (ctx.openPane) {
        ctx.openPane({ kind: "settings", initialTab });
        return null;
      }
      return `open \`sk\` with the Ink REPL to use /${dispatchName}, or edit ${join(homedir(), ".sk", "settings.json")} directly`;
    }
    case "config-form": {
      // Original 4-field user-settings prompt — kept for scripted /
      // muscle-memory use; the full Config surface lives behind /config.
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

      // /profile (no args, Ink host) → open the SinglePane ProfileCommand.
      // Readline fallback (and `/env` alias) keeps the text listing.
      if (name === "profile" && ctx.openPane) {
        const tenant = ctx.statusSnapshot?.tenant.slug ?? null;
        ctx.openPane({ kind: "profile", tenant });
        return null;
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
    // /login, /logout, /tenant moved to handlers/auth-redirects.ts
    // /knowledge moved to handlers/inspect.ts
    default: {
      // Per-category dispatchers extracted into
      // `apps/sk/src/repl/slash/handlers/`. The main switch above
      // owns interactive / multi-step commands; the sub-dispatchers
      // own the long tail of list-and-render commands and the
      // banner-only redirects. Each returns `undefined` when the
      // name doesn't belong to its category, so we can fall through
      // to the next handler in priority order:
      //   1. inspect — read-only, low-tier (/skills, /mcp, …)
      //   2. admin-lists — read-only, admin-tier (/connectors, …)
      //   3. install-wizards — banner redirects to `sk install <kind>`
      //   4. auth-redirects — banner redirects to `sk login` etc.
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
