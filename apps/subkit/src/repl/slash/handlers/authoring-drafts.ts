import fs from "node:fs";
import { homedir } from "node:os";
import { join } from "node:path";
import type { ConversationDetail } from "../../../engine-client.ts";
import { panify, type SlashHandlerContext } from "../handler.ts";

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

export async function dispatchAuthoringDraftSlash(
  name: string,
  rawArgs: string[],
  ctx: SlashHandlerContext,
): Promise<string | null | undefined> {
  switch (name) {
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
      const renderProbe = (probe: Record<string, unknown>, title: string): string | null => {
        const ok = probe.ok === true;
        if (ctx.openPane) {
          ctx.openPane({
            kind: "probe-results",
            title,
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
        return panify(ctx, title, [
          `status: ${ok ? "ok" : "failed"}`,
          `method: ${recordString(probe.method, "GET")}`,
          `path: ${recordString(probe.path, "/")}`,
          `environment: ${recordString(probe.environment, "dev")}`,
          ...(scalarString(probe.summary) ? ["", scalarString(probe.summary)] : []),
        ]);
      };
      const sub = (rawArgs[0] ?? "").toLowerCase();
      if (sub === "show" || sub === "last") {
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
          return panify(ctx, "probe", ["no probe run yet on this draft."]);
        }
        return renderProbe(probe, "latest probe");
      }
      const pathArg = sub === "run" ? rawArgs[1] : rawArgs[0];
      const outcome = await ctx.client.probeConversationConnector(
        ctx.session.conversationId,
        pathArg ? { path: pathArg } : {},
      );
      const data = asRecord(outcome.data) ?? {};
      const probe = asRecord(data.latest_probe);
      if (probe) return renderProbe(probe, "probe");
      return panify(ctx, "probe", [
        `status: ${outcome.ok ? "ok" : "failed"}`,
        ...(scalarString(data.message) ? [scalarString(data.message)] : []),
        ...(scalarString(data.error) ? [scalarString(data.error)] : []),
      ]);
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
      const outcome = await ctx.client.previewConversationDraft(
        ctx.session.conversationId,
        stepArg ? { step_id: stepArg } : {},
      );
      const data = asRecord(outcome.data) ?? {};
      const dryRunSummary = asRecord(data.dry_run_summary);
      const lines: string[] = [`status: ${outcome.ok ? "ok" : "failed"}`];
      if (data.auto_committed === true) {
        lines.push(
          `committed: workflow persisted${typeof data.version === "number" ? ` (v${data.version})` : ""}`,
        );
      } else if (data.save_required === true) {
        lines.push("committed: no — green preview awaiting explicit save");
      }
      const stepsRan = dryRunSummary?.steps_ran ?? data.steps_ran;
      const durationMs = dryRunSummary?.duration_ms ?? data.duration_ms;
      if (typeof stepsRan === "number") {
        lines.push(
          `steps: ${stepsRan}${typeof durationMs === "number" ? ` · ${durationMs}ms` : ""}`,
        );
      }
      const summaryText =
        scalarString(data.summary) || scalarString(data.message) || scalarString(data.next_prompt);
      if (summaryText) lines.push("", summaryText);
      const warningSummary = scalarString(data.warning_summary);
      if (warningSummary) lines.push(`warnings: ${warningSummary}`);
      const stepTrace = Array.isArray(data.step_trace) ? data.step_trace : [];
      if (stepTrace.length > 0) {
        lines.push("");
        for (const entry of stepTrace) {
          const step = asRecord(entry);
          if (!step) continue;
          lines.push(
            `  ${recordString(step.step_id, "?")} (${recordString(step.kind, "?")}) ${recordString(step.status, "?")}${typeof step.duration_ms === "number" ? ` · ${step.duration_ms}ms` : ""}`,
          );
        }
      }
      if (ctx.openPane) {
        ctx.openPane({
          kind: "preview-results",
          title: "preview",
          preview: {
            ok: outcome.ok,
            step: scalarString(stepArg, "—"),
            summary: summaryText,
            lines,
          },
        });
        return null;
      }
      return panify(ctx, "preview", lines);
    }
    case "edit": {
      if (!ctx.session.conversationId) return "no active conversation";
      const editDir = join(homedir(), ".subkit", "edit");
      const bodyPath = join(editDir, `${ctx.session.conversationId}.json`);
      const metaPath = join(editDir, `${ctx.session.conversationId}.meta.json`);
      const sub = (rawArgs[0] ?? "").toLowerCase();
      if (sub === "apply") {
        let body: unknown;
        let meta: { target: "workflow" | { step: string }; before: unknown };
        try {
          body = JSON.parse(fs.readFileSync(bodyPath, "utf8"));
          meta = JSON.parse(fs.readFileSync(metaPath, "utf8"));
        } catch (err) {
          return err instanceof Error && "code" in err && err.code === "ENOENT"
            ? "no pending edit — start one with `/edit [step]`"
            : `edit apply failed: ${err instanceof Error ? err.message : String(err)}`;
        }
        const escapePointer = (key: string): string => key.replace(/~/g, "~0").replace(/\//g, "~1");
        const patches: Array<{
          op: "add" | "remove" | "replace";
          path: string;
          value?: unknown;
        }> = [];
        const editTarget = meta.target;
        if (editTarget === "workflow") {
          const before = asRecord(meta.before) ?? {};
          const after = asRecord(body);
          if (!after) return "edit apply failed: the edited file must contain a JSON object";
          for (const key of new Set([...Object.keys(before), ...Object.keys(after)])) {
            const b = before[key];
            const a = after[key];
            if (JSON.stringify(b) === JSON.stringify(a)) continue;
            if (a === undefined) patches.push({ op: "remove", path: `/${escapePointer(key)}` });
            else if (b === undefined)
              patches.push({ op: "add", path: `/${escapePointer(key)}`, value: a });
            else patches.push({ op: "replace", path: `/${escapePointer(key)}`, value: a });
          }
        } else {
          const detail = await ctx.client.getConversation(ctx.session.conversationId);
          const draft = draftRecord(detail.draft);
          const workflow = draft ? asRecord(draft.workflow) : null;
          const steps = workflow && Array.isArray(workflow.steps) ? workflow.steps : [];
          const idx = steps.findIndex((s) => asRecord(s)?.id === editTarget.step);
          if (idx < 0) {
            return `edit apply failed: step \`${editTarget.step}\` no longer exists in the draft`;
          }
          if (JSON.stringify(steps[idx]) !== JSON.stringify(body)) {
            patches.push({ op: "replace", path: `/steps/${idx}`, value: body });
          }
        }
        if (patches.length === 0) {
          fs.rmSync(bodyPath, { force: true });
          fs.rmSync(metaPath, { force: true });
          return "no changes — draft left untouched";
        }
        const outcome = await ctx.client.patchConversationDraft(
          ctx.session.conversationId,
          patches,
        );
        const data = asRecord(outcome.data) ?? {};
        if (outcome.ok) {
          fs.rmSync(bodyPath, { force: true });
          fs.rmSync(metaPath, { force: true });
        }
        const lines = [
          `status: ${outcome.ok ? "applied" : "refused"}`,
          `patches: ${patches.length}`,
          ...(scalarString(data.message) ? ["", scalarString(data.message)] : []),
          ...(scalarString(data.summary) ? ["", scalarString(data.summary)] : []),
          ...(Array.isArray(data.errors)
            ? data.errors.map((e) => {
                const err = asRecord(e);
                return `  ${recordString(err?.path, "?")}: ${recordString(err?.message, "invalid")}`;
              })
            : []),
          ...(outcome.ok ? ["", "next: `/preview` to dry-run the change"] : []),
        ];
        return panify(ctx, "edit", lines);
      }
      const detail = await ctx.client.getConversation(ctx.session.conversationId);
      const draft = draftRecord(detail.draft);
      const workflow = draft ? asRecord(draft.workflow) : null;
      if (!workflow) {
        return "no workflow draft to edit — author one first (e.g. describe the workflow you want)";
      }
      const stepId = rawArgs[0];
      let editBody: unknown = workflow;
      let target: "workflow" | { step: string } = "workflow";
      if (stepId) {
        const steps = Array.isArray(workflow.steps) ? workflow.steps : [];
        const step = steps.find((s) => asRecord(s)?.id === stepId);
        if (!step) return `no step \`${stepId}\` in the draft — see /workflow for step ids`;
        editBody = step;
        target = { step: stepId };
      }
      fs.mkdirSync(editDir, { recursive: true });
      fs.writeFileSync(bodyPath, `${JSON.stringify(editBody, null, 2)}\n`, "utf8");
      fs.writeFileSync(
        metaPath,
        `${JSON.stringify({ target, before: editBody }, null, 2)}\n`,
        "utf8",
      );
      const editorHint = process.env.EDITOR ? `\`${process.env.EDITOR} ${bodyPath}\`` : bodyPath;
      return `wrote ${bodyPath} — edit it (${editorHint}), then run \`/edit apply\``;
    }
    case "snapshots": {
      if (!ctx.session.conversationId) return "no active conversation";
      const sub = (rawArgs[0] ?? "").toLowerCase();
      if (sub === "restore") {
        const outcome = await ctx.client.restoreConversationDraftSnapshot(
          ctx.session.conversationId,
          rawArgs[1],
        );
        const data = asRecord(outcome.data) ?? {};
        return panify(ctx, "snapshots", [
          `status: ${outcome.ok ? "restored" : "failed"}`,
          ...(scalarString(data.message) ? [scalarString(data.message)] : []),
          ...(scalarString(data.summary) ? [scalarString(data.summary)] : []),
          ...(outcome.ok ? ["next: `/workflow` to inspect, `/preview` to dry-run"] : []),
        ]);
      }
      const outcome = await ctx.client.listConversationDraftSnapshots(ctx.session.conversationId);
      const data = asRecord(outcome.data) ?? {};
      const snapshots = Array.isArray(data.snapshots) ? data.snapshots : [];
      if (snapshots.length === 0) {
        return panify(ctx, "snapshots", ["no draft snapshots yet — they record every draft edit"]);
      }
      const lines = [
        ...snapshots.map((s) => {
          const snap = asRecord(s) ?? {};
          const when = scalarString(snap.snapshot_at).slice(0, 19).replace("T", " ");
          return `  ${recordString(snap.id, "?").slice(0, 8)}  turn ${typeof snap.turn_index === "number" ? snap.turn_index : "?"}  ${when}  ${scalarString(snap.label)}`.trimEnd();
        }),
        "",
        "Roll back with `/snapshots restore [id]` (newest when omitted).",
      ];
      return panify(ctx, "snapshots", lines);
    }
    case "versions": {
      if (!ctx.session.conversationId) return "no active conversation";
      const detail = await ctx.client.getConversation(ctx.session.conversationId);
      const conv = detail.conversation;
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
      const conv = detail.conversation;
      if (!conv.target_workflow_id) {
        return "no committed workflow bound to this conversation — nothing to restore";
      }
      const arg = rawArgs[0];
      const version = arg ? Number.parseInt(arg, 10) : Number.NaN;
      if (!Number.isFinite(version) || version <= 0) {
        return "usage: /restore <version-number>";
      }
      const restored = await ctx.client.restoreWorkflowVersion(conv.target_workflow_id, version);
      return `restored workflow ${restored.id} to version ${version} (new current version ${restored.current_version ?? "—"})`;
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
      if (snapshot.last_context_budget) {
        const b = snapshot.last_context_budget;
        lines.push("");
        lines.push(`context budget (last turn): ${b.total_tokens}/${b.cap_tokens} tokens`);
        lines.push(
          b.dropped_sections.length > 0
            ? `  trimmed to fit: ${b.dropped_sections.join(", ")}`
            : "  nothing was trimmed",
        );
      }
      if (snapshot.grounding_status?.state === "stale" && snapshot.grounding_status.advisory) {
        lines.push("");
        lines.push(`⚠ grounding: ${snapshot.grounding_status.advisory}`);
      }
      return panify(ctx, "conversation context", lines);
    }
    case "approvals": {
      if (!ctx.session.conversationId) return "no active conversation";
      const detail = await ctx.client.getConversation(ctx.session.conversationId);
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
      if (!ctx.session.conversationId) return "no active conversation";
      const args = rawArgs;
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
    default:
      return undefined;
  }
}
