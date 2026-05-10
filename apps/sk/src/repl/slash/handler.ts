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
// classification + RBAC routing live in the dispatcher (R2-S12
// review fix).

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
  ConversationDetail,
  EngineClient,
  SetupValidationResponse,
  StatusSummary,
} from "../../engine-client.ts";
import { loadSettings, saveUserSettingsPatch } from "../../settings.ts";
import type {
  OnboardingProbeResult,
  OnboardingSaveResult,
  OnboardingTemplate,
} from "../onboarding-wizard.tsx";
import { classifySlash, removedSlashGuidance } from "./dispatcher.ts";
import { dispatchAdminListSlash } from "./handlers/admin-lists.ts";
import { dispatchAuthRedirectSlash } from "./handlers/auth-redirects.ts";
import { dispatchInspectSlash } from "./handlers/inspect.ts";

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
   * Latest `/v1/sk/bootstrap` snapshot — passed through from the
   * Ink host's `usePersona` hook. Lets `/status` surface
   * `fetchedAt + source` so an operator rotating an api_key can see
   * whether the slash menu reflects the current token (network) or
   * a stale cache (cache, fallback). R7-S1.
   */
  bootstrapSnapshot?: {
    fetchedAt: number;
    source: "network" | "cache" | "fallback";
    label: string;
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
    `template: ${recordString(connector.template_name ?? connector.template_slug, "scratch")}`,
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
  // R3-W2 review fix: consume `classifySlash` so the dispatcher seam
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
    // M13 of #159 — short-circuit removed/never-shipped slashes with
    // a one-line guidance message pointing at the new home. The
    // guidance map lives in the dispatcher to keep the registry pure;
    // entries decay one release after the actual delete pass per
    // "no backwards-compat shims".
    const hint = removedSlashGuidance(name);
    if (hint) return `/${name} ${hint}`;
  } else {
    debugLog("dialog.elicitation_routing", { slash_name: name, routing: plan.routing }, {});
  }
  // R5-W3 review fix: validate positional args against the per-
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
  switch (name) {
    case "status": {
      // R3-S4: `/status` is local-only by design — same shape as
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
      // R7-S1: surface the bootstrap snapshot's source + age so an
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
    case "install":
    case "onboard": {
      // Fetch the template catalog up-front so the wizard mounts with
      // a ready list. Picking a template is the first step; the
      // remaining steps (credential → probe → save) route through the
      // existing engine connector tools so this slash command never
      // duplicates business logic — it's a UI affordance over the
      // same surface a hand-typed conversation would walk.
      const templatesResp = await ctx.client.listConnectorTemplates();
      const templates = (templatesResp.items ?? [])
        .map((raw) => {
          const slug = typeof raw.slug === "string" ? raw.slug : null;
          if (!slug) return null;
          const oauthRaw = raw.oauth as Record<string, unknown> | null | undefined;
          const oauth =
            oauthRaw && typeof oauthRaw === "object"
              ? {
                  authorization_url:
                    typeof oauthRaw.authorization_url === "string"
                      ? oauthRaw.authorization_url
                      : undefined,
                  scopes: Array.isArray(oauthRaw.scopes)
                    ? (oauthRaw.scopes.filter(
                        (s): s is string => typeof s === "string",
                      ) as string[])
                    : null,
                }
              : null;
          const template: OnboardingTemplate = {
            slug,
            ...(typeof raw.name === "string" ? { name: raw.name } : {}),
            ...(typeof raw.driver === "string" ? { driver: raw.driver } : {}),
            ...(typeof raw.auth_type === "string" ? { auth_type: raw.auth_type } : {}),
            ...(typeof raw.description === "string" ? { description: raw.description } : {}),
            ...(typeof raw.setup_instructions === "string"
              ? { setup_instructions: raw.setup_instructions }
              : {}),
            ...(oauth ? { oauth } : {}),
          };
          return template;
        })
        .filter((t): t is OnboardingTemplate => t !== null);
      if (!ctx.openPane) {
        return "/onboard requires the Ink REPL — run `sk` interactively to launch the wizard";
      }
      // Two-phase wiring: the wizard's `probe` step creates a draft
      // connector via `POST /v1/connectors/from-template/:slug` (a
      // single-shot atomic create that runs the engine's draft +
      // validate + probe pipeline), and the `save` step is a no-op
      // when the from-template route already persisted the connector.
      // For OAuth templates the from-template route returns a draft
      // that requires an OAuth start round-trip; the wizard surfaces
      // the failure reason and lets the operator retry.
      let createdConnectorId: string | null = null;
      const onProbe = async (
        template: OnboardingTemplate,
        credential: string,
      ): Promise<OnboardingProbeResult> => {
        try {
          const body: Record<string, unknown> = {};
          if (credential.length > 0) body.credential = credential;
          const resp = (await ctx.client.createConnectorFromTemplate(template.slug, body)) as {
            ok?: boolean;
            connector?: { id?: string };
            id?: string;
            reason?: string;
          };
          if (resp.ok === false) {
            return { ok: false, reason: resp.reason ?? "probe failed" };
          }
          createdConnectorId = resp.connector?.id ?? resp.id ?? null;
          if (!createdConnectorId) {
            return {
              ok: false,
              reason: "engine returned no connector id — cannot probe",
            };
          }
          // Confirm liveness via the explicit /test endpoint so the
          // wizard's probe step matches what `sk` users would run by
          // hand. A failing test is the operator-facing analog of a
          // failed `probe_connector_draft` tool call.
          const testResp = (await ctx.client.testConnector(createdConnectorId)) as {
            ok?: boolean;
            reason?: string;
          };
          if (testResp.ok === false) {
            return { ok: false, reason: testResp.reason ?? "connector test failed" };
          }
          return { ok: true };
        } catch (err) {
          return {
            ok: false,
            reason: err instanceof Error ? err.message : "probe call failed",
          };
        }
      };
      const onSave = async (
        _template: OnboardingTemplate,
        _credential: string,
      ): Promise<OnboardingSaveResult> => {
        // The probe step already persisted the connector via the
        // from-template route. Save is a no-op acknowledgement so
        // the wizard's step machine stays consistent across template
        // types (OAuth flows that need a follow-up call would
        // override this in the future).
        if (createdConnectorId) {
          return { ok: true, connector_id: createdConnectorId };
        }
        return { ok: false, reason: "probe must succeed before save" };
      };
      const onComplete = (_result: {
        status: "saved" | "cancelled" | "skipped";
        reason?: string;
      }): void => {
        // Pane dismissal is owned by the host — the wizard component
        // calls onDone, the host clears the pane via setPane(null).
        // We pass through here so the type-checker is satisfied.
      };
      ctx.openPane({
        kind: "onboarding-wizard",
        title: "onboarding",
        templates,
        onProbe,
        onSave,
        onComplete,
      });
      return null;
    }
    case "cost": {
      // R3-S4: `/cost` is local-only by design — it reads
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
            template: recordString(connector.template_name ?? connector.template_slug, "scratch"),
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
        if (connector.template_slug) {
          lines.push(`template slug: ${scalarString(connector.template_slug)}`);
        }
        lines.push("");
      }
      lines.push(
        "Ask the assistant to `suggest_connector_templates` for a ranked list,",
        "or use `start_connector_from_template` to seed a draft from one.",
        "",
        "Templates are optional — describe the connector target in your own words any time.",
      );
      if (ctx.openPane) {
        ctx.openPane({
          kind: "template-picker",
          title: "connector templates",
          current_template: scalarString(connector?.template_name ?? connector?.template_slug, ""),
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
        `calls: ${snapshot.tool_calls_total}`,
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
    case "policy": {
      // /policy                              → list tools + current mode
      // /policy <tool> auto|ask|review|reset → pin per-conversation override
      // Mirrors reference impl's `setToolPolicy` + AgentCapabilities panel
      // in one slash. The "review" alias maps to confirm_after_execution
      // (mirrors APPROVAL_LABELS["approval_after"] = "Review after run").
      if (!ctx.session.conversationId) return "no active conversation";
      const args = rawArgs;
      // Map CLI shorthands → engine modes.
      const modeAlias: Record<
        string,
        "no_confirm" | "confirm_before_execution" | "confirm_after_execution" | null
      > = {
        auto: "no_confirm",
        ask: "confirm_before_execution",
        before: "confirm_before_execution",
        review: "confirm_after_execution",
        after: "confirm_after_execution",
        reset: null,
        clear: null,
        default: null,
      };
      if (args.length >= 2) {
        const tool = args[0];
        const aliasRaw = args[1]?.toLowerCase() ?? "";
        if (!tool) return "/policy: missing tool name";
        if (!(aliasRaw in modeAlias)) {
          return `/policy: unknown mode '${aliasRaw}' — use auto | ask | review | reset`;
        }
        const mode = modeAlias[aliasRaw] ?? null;
        const result = await ctx.client.setConversationToolPolicies(ctx.session.conversationId, {
          [tool]: mode,
        });
        const verb = mode === null ? "cleared" : `pinned to ${aliasRaw}`;
        const remaining = Object.keys(result.policies).length;
        return `/policy: ${tool} ${verb}. ${remaining} per-tool override${remaining === 1 ? "" : "s"} active.`;
      }
      // Listing path. Pull current overrides + emit the badge per
      // visible tool. The "default badge" comes from the engine's
      // tool-policies module — but the slash handler can't import the
      // engine package; we render the override map and tell the user
      // how to read the default by category.
      const { policies } = await ctx.client.getConversationToolPolicies(ctx.session.conversationId);
      const overrideKeys = Object.keys(policies).sort();
      const lines =
        overrideKeys.length === 0
          ? [
              "no per-tool overrides set for this conversation.",
              "",
              "default behaviour is set by the engine's tool-policies module:",
              "  - tenant_read tools  → auto (run automatically)",
              "  - draft_write tools  → auto",
              "  - tenant_write tools → ask before running",
              "",
              "set an override with `/policy <tool_name> auto|ask|review|reset`.",
            ]
          : [
              "per-conversation tool overrides:",
              "",
              ...overrideKeys.map((tool) => {
                const mode = policies[tool];
                const badge =
                  mode === "no_confirm"
                    ? "auto         "
                    : mode === "confirm_after_execution"
                      ? "review-after "
                      : "ask-before   ";
                return `  ${badge} ${tool}`;
              }),
              "",
              "clear an override with `/policy <tool_name> reset`.",
            ];
      return panify(ctx, "tool policies", lines);
    }
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
      // S5 of PR #161 review round 2: when the in-memory transcript
      // does not contain an assistant turn (resumed session, paged
      // history scrolled past it, or REPL booted into an existing
      // conversation), fall back to the engine's persisted messages.
      // We avoid a network call when the in-memory cache already has
      // text, so the happy path stays fully local.
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
      // W2 of PR #161 review (round 2): wired to the engine
      // fork-from-message route. /fork creates a real fork at the
      // most recent persisted assistant message, copying messages
      // 0..N into a new conversation, and switches the local
      // sessionId to the new one. The original conversation stays
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
        // W3 of PR #161 review (round 4): annotate the truncation
        // outcome inline so the operator notices when older context
        // was dropped at fork time. The anchor is always preserved;
        // it's only earlier messages that get clipped.
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
      if (ctx.session.conversationId) pane.sessionId = ctx.session.conversationId;
      if (ctx.session.usage && typeof ctx.session.usage.turn_tokens === "number") {
        pane.sessionTokens = ctx.session.usage.turn_tokens;
      }
      ctx.openPane(pane);
      return null;
    }
    case "session": {
      // Mint a portal token scoped to the workflow id provided in args
      // and render a terminal QR + URL. The token is short-lived
      // (15 min default) and tenant-scoped via the engine's existing
      // /v1/identity/portal-tokens audit invariants. M12 of #159.
      const workflowId = rawArgs[0];
      if (!workflowId) {
        return "/session usage: `/session <workflow-id>` — engine requires at least one workflow scope per portal token";
      }
      try {
        const me = await ctx.client.whoami();
        const issued = (await ctx.client.issuePortalToken({
          user_id: me.id,
          allowed_workflows: [workflowId],
          ttl_minutes: 15,
        })) as {
          id: string;
          plaintext_token?: string;
          prefix?: string;
          expires_at: string;
        };
        const token = issued.plaintext_token ?? "";
        if (!token) return "/session: engine did not return a token";
        const url = `${ctx.profile.engine_url.replace(/\/$/, "")}/portal#token=${token}`;
        // Render the QR async; qrcode-terminal logs to stdout. We
        // await it via a Promise wrapper so the slash response includes
        // the URL only — the QR is already on stdout when this returns.
        const qrcode = await import("qrcode-terminal");
        await new Promise<void>((resolve) => {
          qrcode.default.generate(url, { small: true }, () => resolve());
        });
        // S3 of PR #161 review — explicit do-not-share warning.
        // The plaintext URL above contains a portal token that grants
        // mobile/portal-side access for the next 15 minutes; copying
        // it into chat / commit messages / shared screens leaks the
        // session.
        return `portal token issued (15 min, single-use) — ${url}\n⚠ do not share this URL — anyone holding it can attach to your session until ${issued.expires_at}\nscan the QR above with your phone to connect; the QR clears when this pane closes.`;
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
    // /skills, /mcp, /permissions, /audit moved to handlers/inspect.ts (R7-S2)
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
      // R8-W4 review fix: defend against TOCTOU + symlink races.
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
    case "config": {
      if (ctx.openPane) {
        const current = loadSettings(process.cwd()).merged;
        ctx.openPane({
          kind: "config-form",
          title: "config",
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
      return `edit ${join(homedir(), ".sk", "settings.json")} or run /config in the Ink REPL for a guided form`;
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
    // /login, /logout, /tenant moved to handlers/auth-redirects.ts (R7-S2)
    // /knowledge moved to handlers/inspect.ts (R7-S2)
    default: {
      // R7-S2: per-category dispatchers extracted into
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
