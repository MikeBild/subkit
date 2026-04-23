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
import type {
  ConversationContextSnapshot,
  ConversationDetail,
  EngineClient,
  SetupValidationResponse,
  StatusSummary,
} from "../engine-client.ts";

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
  /** Latest `/v1/diagnostics/setup` snapshot when the persona can read it. */
  setupSnapshot?: SetupValidationResponse | null;
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

function conversationDetailRecord(value: unknown): ConversationDetail {
  return value as ConversationDetail;
}

function workflowStepsFromDraft(
  draft: Record<string, unknown> | null,
): Array<Record<string, unknown>> {
  const workflow = draft ? asRecord(draft.workflow) : null;
  return Array.isArray(workflow?.steps)
    ? workflow.steps.filter((step): step is Record<string, unknown> => asRecord(step) !== null)
    : [];
}

function approvalHistoryFromDetail(detail: ConversationDetail): Array<{
  tool: string;
  created_at: string;
  summary: string;
  status: string;
}> {
  return (Array.isArray(detail.tool_calls) ? detail.tool_calls : [])
    .map((call) => asRecord(call))
    .filter(
      (call): call is Record<string, unknown> =>
        call !== null &&
        (call.tool === "ask_user_confirm" ||
          call.tool === "ask_user_choice" ||
          call.tool === "ask_user_multi"),
    )
    .map((call) => {
      const output = asRecord(call.output);
      const input = asRecord(call.input);
      const confirmed = output?.confirmed;
      const status =
        confirmed === true
          ? "approved"
          : confirmed === false
            ? "rejected"
            : typeof call.approval_required === "boolean" && call.approval_required
              ? "awaiting"
              : "recorded";
      return {
        tool: recordString(call.tool),
        created_at: recordString(call.created_at),
        summary: recordString(input?.summary ?? input?.question, "—"),
        status,
      };
    });
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
      const draft = draftRecord(detail.draft);
      const connector = draft ? asRecord(draft.connector) : null;
      if (!connector) {
        return panify(ctx, "connector draft", ["no connector draft in this conversation"]);
      }
      const validation = asRecord(connector.validation);
      const latestProbe = asRecord(connector.latest_probe);
      const probeOk = latestProbe?.ok === true;
      if (ctx.openPane) {
        ctx.openPane({
          kind: "connector-draft",
          title: "connector draft",
          connector: {
            name: recordString(connector.name),
            slug: recordString(connector.slug),
            driver: recordString(connector.driver),
            environment: recordString(connector.environment),
            auth_type: recordString(connector.auth_type),
            base_url: recordString(connector.base_url),
            dsn: recordString(connector.dsn),
            template: recordString(connector.template_name ?? connector.template_id, "scratch"),
            saved_id: recordString(connector.saved_connector_id),
          },
          missing_fields: Array.isArray(validation?.missing_fields)
            ? validation.missing_fields.filter((f): f is string => typeof f === "string")
            : [],
          latest_probe: latestProbe
            ? {
                ok: probeOk,
                method: recordString(latestProbe.method),
                path: recordString(latestProbe.path),
                environment: recordString(latestProbe.environment),
                status:
                  typeof latestProbe.status_code === "number"
                    ? String(latestProbe.status_code)
                    : "—",
                duration:
                  typeof latestProbe.duration_ms === "number"
                    ? `${latestProbe.duration_ms}ms`
                    : "—",
                summary: scalarString(latestProbe.summary),
                failure_code: scalarString(latestProbe.failure_code, "—"),
              }
            : null,
        });
        return null;
      }
      return panify(ctx, "connector draft", formatConnectorLines(draft));
    }
    case "workflow": {
      if (!ctx.session.conversationId) return "no active conversation";
      const detail = await ctx.client.getConversation(ctx.session.conversationId);
      const draft = draftRecord(detail.draft);
      const workflow = draft ? asRecord(draft.workflow) : null;
      const preview = draft ? asRecord(draft.latest_preview) : null;
      if (!workflow) {
        return panify(ctx, "workflow draft", ["no workflow draft in this conversation"]);
      }
      const steps = workflowStepsFromDraft(draft);
      const requestedStepId = rawArgs[0];
      if (requestedStepId) {
        const match = steps.find((step) => scalarString(step.id, "") === requestedStepId);
        if (!match) {
          return `no workflow step named ${requestedStepId}`;
        }
        if (ctx.openPane) {
          ctx.openPane({
            kind: "step-detail",
            title: `step ${requestedStepId}`,
            step: {
              id: scalarString(match.id, requestedStepId),
              kind: scalarString(match.kind),
              ordinal: steps.indexOf(match) + 1,
              lines: JSON.stringify(match, null, 2).split("\n"),
            },
          });
          return null;
        }
        return panify(ctx, `step ${requestedStepId}`, JSON.stringify(match, null, 2).split("\n"));
      }
      const previewOk = preview?.ok === true;
      if (ctx.openPane) {
        ctx.openPane({
          kind: "workflow-draft",
          title: "workflow draft",
          workflow: {
            name: recordString(workflow.name),
            slug: recordString(workflow.slug),
            description: recordString(workflow.description),
            steps: steps.slice(0, 50).map((step, i) => ({
              id: scalarString(step.id, `#${i + 1}`),
              kind: scalarString(step.kind, "(no kind)"),
            })),
          },
          latest_preview: preview
            ? {
                ok: previewOk,
                step: scalarString(preview.step_id, "—"),
                summary: scalarString(preview.summary),
              }
            : null,
        });
        return null;
      }
      return panify(ctx, "workflow draft", formatWorkflowLines(draft));
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
      if (ctx.openPane) {
        ctx.openPane({
          kind: "template-picker",
          title: "connector templates",
          current_template: scalarString(connector?.template_name ?? connector?.template_id, ""),
          connector_name: scalarString(connector?.name, ""),
          lines,
        });
        return null;
      }
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
      // If the user passed a sub-command (e.g. `/probe show`) display
      // the latest recorded probe instead of triggering a new one.
      const sub = (rawArgs[0] ?? "").toLowerCase();
      if (sub === "show" || sub === "last") {
        const probe = asRecord(connector.latest_probe);
        if (!probe) {
          return panify(ctx, "probe", ["no probe run yet on this draft."]);
        }
        const ok = probe.ok === true;
        if (ctx.openPane) {
          ctx.openPane({
            kind: "probe-results",
            title: "latest probe",
            probe: {
              ok,
              method: recordString(probe.method, "GET"),
              path: recordString(probe.path, "/"),
              environment: recordString(probe.environment, "dev"),
              http: typeof probe.status_code === "number" ? String(probe.status_code) : "—",
              duration: typeof probe.duration_ms === "number" ? `${probe.duration_ms}ms` : "—",
              summary: scalarString(probe.summary),
              failure_code: scalarString(probe.failure_code, "—"),
            },
          });
          return null;
        }
        return panify(ctx, "latest probe", [
          `status: ${ok ? "ok" : "failed"}`,
          `method: ${recordString(probe.method, "GET")}`,
          `path: ${recordString(probe.path, "/")}`,
          `environment: ${recordString(probe.environment, "dev")}`,
        ]);
      }
      // Default (or explicit `/probe run`): trigger a new probe by
      // appending a directive message.
      // The model interprets it and invokes probe_connector_draft.
      await ctx.client.appendConversationMessage(ctx.session.conversationId, {
        message:
          "Run probe_connector_draft against the current connector draft now. Use the default GET / path unless the draft implies otherwise. After probing, summarise the result in one sentence.",
      });
      return "probe requested — run /probe show after the turn finishes to see the result";
    }
    case "preview": {
      if (!ctx.session.conversationId) return "no active conversation";
      const sub = (rawArgs[0] ?? "").toLowerCase();
      if (sub === "show" || sub === "last") {
        const detail = await ctx.client.getConversation(ctx.session.conversationId);
        const draft = draftRecord(detail.draft);
        const preview = draft ? asRecord(draft.latest_preview) : null;
        if (!preview) {
          return panify(ctx, "preview", ["no preview run yet on this draft."]);
        }
        const lines: string[] = [`status: ${preview.ok ? "ok" : "failed"}`];
        if (preview.step_id) lines.push(`step: ${scalarString(preview.step_id)}`);
        if (preview.summary) lines.push("", scalarString(preview.summary));
        if (ctx.openPane) {
          ctx.openPane({
            kind: "preview-results",
            title: "latest preview",
            preview: {
              ok: preview.ok === true,
              step: scalarString(preview.step_id, "—"),
              summary: scalarString(preview.summary),
              lines,
            },
          });
          return null;
        }
        return panify(ctx, "latest preview", lines);
      }
      const stepArg = sub === "run" ? rawArgs[1] : rawArgs[0];
      const hint = stepArg
        ? `Run dry_run_step against step \`${stepArg}\`. Report the classification and one-line summary.`
        : "Run dry_run_workflow against the current draft. Report the classification of every step that executed.";
      await ctx.client.appendConversationMessage(ctx.session.conversationId, { message: hint });
      return "preview requested — run /preview show after the turn finishes to see the result";
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
      if (ctx.openPane) {
        ctx.openPane({
          kind: "version-browser",
          title: "versions",
          workflow_id: conv.target_workflow_id,
          items: res.items,
        });
        return null;
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
      if (ctx.openPane) {
        ctx.openPane({
          kind: "context",
          title: "conversation context",
          snapshot,
        });
        return null;
      }
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
      if (snapshot.attachments.total > 0) {
        lines.push("");
        lines.push(`attachments: ${snapshot.attachments.total}`);
        for (const a of snapshot.attachments.items) {
          const bytes = a.bytes !== null ? ` · ${a.bytes}b` : "";
          lines.push(`  @attachment:${a.slug}${a.filename ? ` (${a.filename})` : ""}${bytes}`);
        }
      }
      if (snapshot.latest_probe) {
        lines.push("");
        lines.push(
          `latest probe: ${snapshot.latest_probe.ok ? "ok" : "failed"}${snapshot.latest_probe.failure_code ? ` (${snapshot.latest_probe.failure_code})` : ""}`,
        );
        if (snapshot.latest_probe.summary) lines.push(`  ${snapshot.latest_probe.summary}`);
      }
      if (snapshot.latest_preview) {
        lines.push("");
        lines.push(
          `latest preview: ${snapshot.latest_preview.ok ? "ok" : "failed"}${snapshot.latest_preview.step_id ? ` (${snapshot.latest_preview.step_id})` : ""}`,
        );
        if (snapshot.latest_preview.summary) lines.push(`  ${snapshot.latest_preview.summary}`);
      }
      if (snapshot.workflow_version) {
        lines.push("");
        const v = snapshot.workflow_version.current_version;
        lines.push(
          `workflow version: ${snapshot.workflow_version.workflow_id}${v !== null ? ` · v${v}` : ""}`,
        );
      }
      return panify(ctx, "conversation context", lines);
    }
    case "approvals": {
      if (!ctx.session.conversationId) return "no active conversation";
      const detail = conversationDetailRecord(
        await ctx.client.getConversation(ctx.session.conversationId),
      );
      const items = approvalHistoryFromDetail(detail);
      if (items.length === 0) {
        return panify(ctx, "approval history", ["no approval requests recorded yet."]);
      }
      if (ctx.openPane) {
        ctx.openPane({
          kind: "approval-history",
          title: "approval history",
          items,
        });
        return null;
      }
      return panify(
        ctx,
        "approval history",
        items.map((item) => `${item.status.padEnd(9)} ${item.tool} · ${item.summary}`),
      );
    }
    case "clear":
    case "new": {
      ctx.setConversationId(null);
      return "session cleared";
    }
    case "export": {
      // Render the current session transcript to a Markdown file in
      // the current working directory. Covers user/assistant messages,
      // tool calls (with truncated output), and the usage summary so
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
            parts.push(`**tool:** \`${tc.name}\` · ${tc.status}`);
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
        parts.push("### Orphan tool calls (no parent message)");
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
            ? `full trace logging enabled — appending to ${path}`
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
          ? "every dialog turn, request/response, and streamed event is logged as JSONL"
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
    case "knowledge": {
      const r = await ctx.client.listKnowledgeSources({ limit: 20 });
      if (r.items.length === 0) return "no knowledge sources";
      const lines = r.items.map((ks) => {
        const k = ks as Record<string, unknown>;
        return `${String(k.id ?? "").slice(0, 8)}  ${String(k.title ?? k.name ?? "")}  ${String(k.kind ?? "")}`;
      });
      return panify(ctx, "knowledge sources", lines, `${r.items.length} found`);
    }
    case "connectors": {
      const r = await ctx.client.listConnectors({ limit: 20 });
      if (r.items.length === 0) return "no connectors";
      const lines = r.items.map((c) => {
        const ct = c as Record<string, unknown>;
        return `${String(ct.id ?? "").slice(0, 8)}  ${String(ct.name ?? "").padEnd(20)}  ${String(ct.slug ?? "")}`;
      });
      return panify(ctx, "connectors", lines, `${r.items.length} found`);
    }
    case "workflows": {
      const r = await ctx.client.listWorkflows({ limit: 20 });
      if (r.items.length === 0) return "no workflows";
      const lines = r.items.map((w) => {
        const wf = w as Record<string, unknown>;
        return `${String(wf.id ?? "").slice(0, 8)}  ${String(wf.name ?? "").padEnd(20)}  ${String(wf.status ?? "")}`;
      });
      return panify(ctx, "workflows", lines, `${r.items.length} found`);
    }
    case "executions":
    case "runs": {
      const r = await ctx.client.listExecutions({ limit: 10 });
      if (r.items.length === 0) return "no executions";
      const lines = r.items.map((e) => {
        const ex = e as Record<string, unknown>;
        return `${String(ex.id ?? "").slice(0, 8)}  wf:${String(ex.workflow_id ?? "").slice(0, 8)}  ${String(ex.status ?? "").padEnd(12)}  ${String(ex.started_at ?? "")}`;
      });
      return panify(ctx, "executions", lines, `latest ${r.items.length}`);
    }
    case "patch-candidates": {
      const r = await ctx.client.listPatchCandidates({ limit: 10 });
      if (r.items.length === 0) return "no pending patch candidates";
      const lines = r.items.map((p) => {
        const pc = p as Record<string, unknown>;
        return `${String(pc.id ?? "").slice(0, 8)}  wf:${String(pc.workflow_id ?? "").slice(0, 8)}  ${String(pc.status ?? "")}`;
      });
      return panify(ctx, "patch candidates", lines, `${r.items.length} pending`);
    }
    case "notifications": {
      const [channels, rules] = await Promise.all([
        ctx.client
          .listNotificationChannels()
          .catch(() => ({ items: [] as Record<string, unknown>[] })),
        ctx.client
          .listNotificationRules()
          .catch(() => ({ items: [] as Record<string, unknown>[] })),
      ]);
      const lines: string[] = [];
      lines.push(`channels (${channels.items.length}):`);
      for (const c of channels.items) {
        const ch = c as Record<string, unknown>;
        lines.push(
          `  ${String(ch.id ?? "").slice(0, 8)}  ${String(ch.name ?? "").padEnd(20)}  ${String(ch.kind ?? "")}`,
        );
      }
      lines.push("");
      lines.push(`rules (${rules.items.length}):`);
      for (const rule of rules.items) {
        const r = rule as Record<string, unknown>;
        lines.push(
          `  ${String(r.id ?? "").slice(0, 8)}  ${String(r.event_type ?? "").padEnd(24)}  → ch:${String(r.channel_id ?? "").slice(0, 8)}`,
        );
      }
      return panify(ctx, "notifications", lines);
    }
    case "tunnels": {
      const r = await ctx.client.listTunnels();
      if (r.items.length === 0) return "no tunnels";
      const lines = r.items.map((t) => {
        const tun = t as Record<string, unknown>;
        return `${String(tun.id ?? "").slice(0, 8)}  ${String(tun.name ?? "").padEnd(20)}  ${String(tun.status ?? "")}`;
      });
      return panify(ctx, "tunnels", lines, `${r.items.length} found`);
    }
    case "discovery": {
      const r = await ctx.client.listDiscoveryRuns({ limit: 10 });
      if (r.items.length === 0) return "no discovery runs";
      const lines = r.items.map((d) => {
        const dr = d as Record<string, unknown>;
        return `${String(dr.id ?? "").slice(0, 8)}  ${String(dr.label ?? "").padEnd(20)}  ${String(dr.status ?? "")}`;
      });
      return panify(ctx, "discovery runs", lines, `${r.items.length} found`);
    }
    case "apikeys": {
      const r = await ctx.client.listApiKeys();
      if (r.items.length === 0) return "no API keys";
      const lines = r.items.map((k) => {
        const ak = k as Record<string, unknown>;
        return `${String(ak.id ?? "").slice(0, 8)}  ${String(ak.name ?? "").padEnd(20)}  ${String(ak.prefix ?? "***")}`;
      });
      return panify(ctx, "API keys", lines, `${r.items.length} keys`);
    }
    case "users": {
      const r = await ctx.client.listIdentityUsers({ limit: 20 });
      if (r.items.length === 0) return "no users";
      const lines = r.items.map((u) => {
        const user = u as Record<string, unknown>;
        return `${String(user.id ?? "").slice(0, 8)}  ${String(user.email ?? "").padEnd(30)}  ${String(user.kind ?? "")}`;
      });
      return panify(ctx, "users", lines, `${r.items.length} found`);
    }
    case "system-accounts": {
      const r = await ctx.client.listSystemAccounts();
      if (r.items.length === 0) return "no system accounts";
      const lines = r.items.map((sa) => {
        const acc = sa as Record<string, unknown>;
        return `${String(acc.id ?? "").slice(0, 8)}  ${String(acc.name ?? "")}`;
      });
      return panify(ctx, "system accounts", lines, `${r.items.length} found`);
    }
    // Install wizards — complex interactive prompts; redirect to CLI command.
    case "install-slack":
      return "run 'sk install slack' outside the REPL to set up Slack notifications";
    case "install-teams":
      return "run 'sk install teams' outside the REPL to set up Microsoft Teams notifications";
    case "install-github":
      return "run 'sk install github' outside the REPL to connect GitHub";
    case "install-google-workspace":
      return "run 'sk install google-workspace' outside the REPL to connect Google Workspace";
    case "install-salesforce":
      return "run 'sk install salesforce' outside the REPL to connect Salesforce";
    case "install-jira":
      return "run 'sk install jira' outside the REPL to connect Jira";
    case "install-hubspot":
      return "run 'sk install hubspot' outside the REPL to connect HubSpot";
    default:
      return `/${name} is not wired — try /help`;
  }
}
