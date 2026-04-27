// Structured cards for high-signal authoring milestones.
//
// The chat view shows only these milestone cards; the inspect view can
// still fall back to raw tool cards for full engine transparency.

import type { ToolCallState } from "@cli-core/index.ts";
import { Box, Text } from "ink";
import type React from "react";
import { memo } from "react";

type CardTone = "ok" | "warn" | "fail" | "pending" | "info";

function toneColor(tone: CardTone): string {
  switch (tone) {
    case "ok":
      return "green";
    case "warn":
      return "yellow";
    case "fail":
      return "red";
    case "pending":
      return "yellow";
    default:
      return "cyan";
  }
}

function badge(tone: CardTone, label: string): React.ReactNode {
  const color = toneColor(tone);
  const glyph =
    tone === "ok"
      ? "✓"
      : tone === "fail"
        ? "×"
        : tone === "pending"
          ? "…"
          : tone === "warn"
            ? "!"
            : "·";
  return (
    <>
      <Text color={color} bold>
        {glyph}
      </Text>
      <Text> </Text>
      <Text bold>{label}</Text>
    </>
  );
}

function asRecord(v: unknown): Record<string, unknown> | null {
  if (v && typeof v === "object" && !Array.isArray(v)) return v as Record<string, unknown>;
  return null;
}

function unwrapData(call: ToolCallState): Record<string, unknown> | null {
  const r = asRecord(call.result);
  if (!r) return null;
  const inner = asRecord(r.data);
  return inner ?? r;
}

// Truncate an arbitrary value to a single-line, eye-friendly preview.
// Strings >120 chars are clipped; objects/arrays are JSON-stringified
// and clipped to the same budget. Used by the output-preview blocks so
// every successful run/commit/dry-run renders the actual payload, not
// just a status badge.
function previewLine(v: unknown, max = 120): string {
  if (v === null || v === undefined) return "";
  if (typeof v === "string") return v.length > max ? `${v.slice(0, max - 1)}…` : v;
  if (typeof v === "number" || typeof v === "boolean") return String(v);
  try {
    const s = JSON.stringify(v);
    return s.length > max ? `${s.slice(0, max - 1)}…` : s;
  } catch {
    return String(v);
  }
}

// Multi-line output preview: pretty-prints the value to ~20 lines and
// returns each line. Caller renders one <Text> per line under the card.
function previewLines(v: unknown, maxLines = 20, maxWidth = 100): string[] {
  if (v === null || v === undefined) return [];
  let formatted: string;
  try {
    formatted = typeof v === "string" ? v : JSON.stringify(v, null, 2);
  } catch {
    formatted = String(v);
  }
  const lines = formatted.split("\n");
  const trimmed = lines
    .slice(0, maxLines)
    .map((line) => (line.length > maxWidth ? `${line.slice(0, maxWidth - 1)}…` : line));
  if (lines.length > maxLines) {
    trimmed.push(
      `… +${lines.length - maxLines} more line${lines.length - maxLines === 1 ? "" : "s"}`,
    );
  }
  return trimmed;
}

function statusTone(call: ToolCallState): CardTone {
  if (call.status === "failed") return "fail";
  if (call.status === "running" || call.status === "pending") return "pending";
  const d = unwrapData(call);
  const okFlag = d && typeof d.ok === "boolean" ? d.ok : null;
  if (okFlag === false) return "fail";
  // Succeeded run with non-empty `warnings` should look different from
  // a fully clean run — otherwise the operator sees green on a
  // github-private-repos-stats-style `{total_count: 0}` outcome.
  const warnings = Array.isArray(d?.warnings) ? (d?.warnings as unknown[]) : null;
  if (warnings && warnings.length > 0) return "warn";
  if (okFlag === true) return "ok";
  return call.status === "done" ? "ok" : "info";
}

interface CardProps {
  call: ToolCallState;
}

export type AuthoringCardMode = "chat" | "inspect";

const ConnectorProbeCard: React.FC<CardProps> = memo(({ call }) => {
  const tone = statusTone(call);
  const d = unwrapData(call);
  const probe = asRecord(d?.latest_probe);
  // Hide unresolved method/path placeholders instead of rendering
  // "(method)" / "(path)" literally — those strings leaked into the
  // sk-cli chat view when the tool result was missing the probe
  // object. Better to show a compact card than an honest-looking line
  // with fake values.
  const method = typeof probe?.method === "string" ? probe.method : null;
  const path = typeof probe?.path === "string" ? probe.path : null;
  const env = typeof probe?.environment === "string" ? probe.environment : "dev";
  const status = typeof probe?.status_code === "number" ? `HTTP ${probe.status_code}` : null;
  const duration = typeof probe?.duration_ms === "number" ? `${probe.duration_ms}ms` : null;
  const summary = typeof probe?.summary === "string" ? probe.summary : "";
  const request = [method, path].filter((x): x is string => !!x).join(" ");
  return (
    <Box flexDirection="column" marginBottom={1}>
      <Box>
        {badge(
          tone,
          tone === "fail"
            ? "Endpoint check failed"
            : tone === "pending"
              ? "Checking endpoint"
              : "Endpoint check complete",
        )}
        <Text dimColor>
          {request ? ` · ${request}` : ""}
          {" · "}
          {env}
          {status ? ` · ${status}` : ""}
          {duration ? ` · ${duration}` : ""}
        </Text>
      </Box>
      {summary ? (
        <Box marginLeft={2}>
          <Text dimColor>{summary}</Text>
        </Box>
      ) : null}
    </Box>
  );
});
ConnectorProbeCard.displayName = "ConnectorProbeCard";

const StepPreviewCard: React.FC<CardProps> = memo(({ call }) => {
  const tone = statusTone(call);
  const d = unwrapData(call);
  const stepId =
    typeof d?.step_id === "string"
      ? d.step_id
      : typeof d?.stopped_at_step_id === "string"
        ? d.stopped_at_step_id
        : "(step)";
  const classification =
    typeof d?.classification === "string" ? (d.classification as string) : null;
  const duration = typeof d?.duration_ms === "number" ? `${d.duration_ms}ms` : null;
  const summary = typeof d?.summary === "string" ? d.summary : "";
  const kind = call.name === "dry_run_workflow" ? "workflow" : `step ${stepId}`;
  // Prefer the explicit per-step preview the engine returns; fall back
  // to a generic output field. A successful preview that produced []
  // (e.g. a loop body that never iterated) renders the literal "[]" so
  // the operator can see it WITHOUT having to ask "display results".
  const stepPreviews = Array.isArray(d?.steps) ? (d?.steps as unknown[]) : null;
  const output = d?.output ?? d?.preview ?? d?.output_preview;
  const outputLines = output !== undefined && output !== null ? previewLines(output) : [];
  const hasOutput = outputLines.length > 0;
  return (
    <Box flexDirection="column" marginBottom={1}>
      <Box>
        {badge(
          tone,
          tone === "fail"
            ? "Preview failed"
            : tone === "pending"
              ? "Preview running"
              : "Preview complete",
        )}
        <Text dimColor>
          {" "}
          · {kind}
          {classification ? ` · ${classification}` : ""}
          {duration ? ` · ${duration}` : ""}
        </Text>
      </Box>
      {summary ? (
        <Box marginLeft={2}>
          <Text dimColor>{summary}</Text>
        </Box>
      ) : null}
      {stepPreviews && stepPreviews.length > 0 ? (
        <Box marginLeft={2} flexDirection="column">
          {stepPreviews.slice(0, 8).map((s, i) => {
            const r = asRecord(s);
            const id =
              typeof r?.step_key === "string"
                ? r.step_key
                : typeof r?.id === "string"
                  ? r.id
                  : `step_${i}`;
            const sStatus = typeof r?.status === "string" ? r.status : "?";
            const sKind = typeof r?.kind === "string" ? r.kind : "";
            const sDur = typeof r?.duration_ms === "number" ? `${r.duration_ms}ms` : "";
            const sOut = previewLine(r?.output_preview ?? r?.output, 80);
            return (
              <Text key={`pv-step-${call.id}-${i}`} dimColor>
                {`  ${sStatus === "succeeded" ? "✓" : sStatus === "failed" ? "✗" : "·"} ${id}${sKind ? ` (${sKind})` : ""}${sDur ? ` · ${sDur}` : ""}${sOut ? ` · ${sOut}` : ""}`}
              </Text>
            );
          })}
        </Box>
      ) : null}
      {hasOutput && (!stepPreviews || stepPreviews.length === 0) ? (
        <Box marginLeft={2} flexDirection="column">
          <Text dimColor>output:</Text>
          {outputLines.map((line, i) => (
            <Text key={`pv-out-${call.id}-${i}`} dimColor>
              {`  ${line}`}
            </Text>
          ))}
        </Box>
      ) : null}
    </Box>
  );
});
StepPreviewCard.displayName = "StepPreviewCard";

const SaveResultCard: React.FC<CardProps> = memo(({ call }) => {
  const tone = statusTone(call);
  const d = unwrapData(call);
  const connector = asRecord(d?.connector);
  if (connector) {
    const name =
      typeof connector.display_name === "string" ? connector.display_name : "(connector)";
    const slug = typeof connector.slug === "string" ? connector.slug : "";
    const env = typeof connector.environment === "string" ? connector.environment : "";
    return (
      <Box flexDirection="column" marginBottom={1}>
        <Box>
          {badge(tone, `Connector saved`)}
          <Text dimColor>
            {` · ${name}`}
            {slug ? ` · ${slug}` : ""}
            {env ? ` · ${env}` : ""}
          </Text>
        </Box>
      </Box>
    );
  }
  const errorCode = typeof d?.error_code === "string" ? d.error_code : d?.error;
  const nextRequired =
    typeof d?.next_required_action === "string"
      ? d.next_required_action
      : typeof asRecord(d?.summary)?.next_required_action === "string"
        ? (asRecord(d?.summary)?.next_required_action as string)
        : null;
  if (errorCode === "connector_not_ready" || errorCode === "validation_failed") {
    return (
      <Box flexDirection="column" marginBottom={1}>
        <Box>{badge("fail", "Connector save blocked")}</Box>
        <Box marginLeft={2}>
          <Text color="yellow">
            {nextRequired ?? "Probe and validate the connector before saving."}
          </Text>
        </Box>
      </Box>
    );
  }
  return (
    <Box flexDirection="column" marginBottom={1}>
      <Box>{badge(tone, "Saving connector")}</Box>
    </Box>
  );
});
SaveResultCard.displayName = "SaveResultCard";

const CommitResultCard: React.FC<CardProps> = memo(({ call }) => {
  const tone = statusTone(call);
  const d = unwrapData(call);
  if (d && typeof d.workflow_id === "string") {
    const slug = typeof d.slug === "string" ? d.slug : "";
    const version = typeof d.version === "number" ? ` · v${d.version}` : "";
    const stepCount =
      typeof d.steps === "number"
        ? d.steps
        : typeof asRecord(d.workflow)?.step_count === "number"
          ? (asRecord(d.workflow)?.step_count as number)
          : null;
    const lastPreview = previewLine(d.last_preview_output ?? d.preview, 100);
    return (
      <Box flexDirection="column" marginBottom={1}>
        <Box>
          {badge(tone, "Workflow saved")}
          <Text
            dimColor
          >{`${slug ? ` · ${slug}` : ""}${version}${stepCount !== null ? ` · ${stepCount} step${stepCount === 1 ? "" : "s"}` : ""}`}</Text>
        </Box>
        {lastPreview ? (
          <Box marginLeft={2}>
            <Text dimColor>{`preview: ${lastPreview}`}</Text>
          </Box>
        ) : null}
      </Box>
    );
  }
  const errorCode = typeof d?.error_code === "string" ? d.error_code : d?.error;
  const nextRequired =
    typeof d?.next_required_action === "string"
      ? d.next_required_action
      : typeof asRecord(d?.summary)?.next_required_action === "string"
        ? (asRecord(d?.summary)?.next_required_action as string)
        : null;
  if (errorCode === "workflow_not_ready" || errorCode === "invalid_final_draft") {
    return (
      <Box flexDirection="column" marginBottom={1}>
        <Box>{badge("fail", "Workflow save blocked")}</Box>
        <Box marginLeft={2}>
          <Text color="yellow">
            {nextRequired ?? "Refresh inspect, validation, and preview before committing."}
          </Text>
        </Box>
      </Box>
    );
  }
  return (
    <Box flexDirection="column" marginBottom={1}>
      <Box>{badge(tone, "Saving workflow")}</Box>
    </Box>
  );
});
CommitResultCard.displayName = "CommitResultCard";

const ExecutionDiagnosisCard: React.FC<CardProps> = memo(({ call }) => {
  const tone = statusTone(call);
  const d = unwrapData(call);
  if (call.name === "diagnose_latest_execution") {
    const diagnosis = asRecord(d?.diagnosis);
    const reason = typeof diagnosis?.reason === "string" ? diagnosis.reason : null;
    const warningSources = Array.isArray(diagnosis?.warning_sources)
      ? diagnosis.warning_sources.length
      : 0;
    const steps = Array.isArray(diagnosis?.steps) ? diagnosis.steps.length : 0;
    return (
      <Box flexDirection="column" marginBottom={1}>
        <Box>
          {badge("info", "Execution diagnosis ready")}
          <Text dimColor>
            {steps > 0 ? ` · ${steps} step${steps === 1 ? "" : "s"}` : ""}
            {warningSources > 0
              ? ` · ${warningSources} warning source${warningSources === 1 ? "" : "s"}`
              : ""}
          </Text>
        </Box>
        {reason ? (
          <Box marginLeft={2}>
            <Text dimColor>{reason}</Text>
          </Box>
        ) : null}
      </Box>
    );
  }
  // Status comes from `d.status` (run_workflow lifecycle payload).
  // Missing here means the engine returned a payload without a status
  // field — that is a contract bug, NOT a run state. Surface it as red
  // so the regression is visible the moment it lands. Never paper over
  // it with a string like "unknown" that looks like a state.
  const rawStatus = typeof d?.status === "string" ? d.status : null;
  const status =
    rawStatus ??
    (call.status === "running" || call.status === "pending"
      ? "running"
      : call.status === "failed"
        ? "failed"
        : null);
  const statusMissing = rawStatus === null && status === null;
  const warnings = Array.isArray(d?.warnings) ? d.warnings.length : 0;
  const needsDiagnosis = d?.diagnosis_available === true;
  const isPartial = rawStatus === "partial_success";
  const version = typeof d?.workflow_version === "number" ? ` · v${d.workflow_version}` : "";
  const output = d?.output;
  const outputLines =
    !needsDiagnosis && !statusMissing && output !== undefined && output !== null
      ? previewLines(output)
      : [];
  const hasOutput = outputLines.length > 0;
  const headerTone: CardTone = statusMissing ? "fail" : needsDiagnosis || isPartial ? "warn" : tone;
  const headerLabel = statusMissing
    ? "Execution status missing from engine — bug, not a state"
    : needsDiagnosis
      ? "Execution needs diagnosis"
      : isPartial
        ? "Execution partial — verify output"
        : "Execution complete";
  return (
    <Box flexDirection="column" marginBottom={1}>
      <Box>
        {badge(headerTone, headerLabel)}
        <Text dimColor>
          {status ? ` · ${status}` : ""}
          {version}
          {warnings > 0 ? ` · ${warnings} warning${warnings === 1 ? "" : "s"}` : ""}
        </Text>
      </Box>
      {needsDiagnosis || isPartial ? (
        <Box marginLeft={2}>
          <Text color="yellow">
            {isPartial
              ? "Loop body produced no rows. Repair before relying on this run."
              : "Open diagnosis before editing the workflow."}
          </Text>
        </Box>
      ) : null}
      {hasOutput ? (
        <Box marginLeft={2} flexDirection="column">
          <Text dimColor>output:</Text>
          {outputLines.map((line, i) => (
            <Text key={`exec-out-${call.id}-${i}`} dimColor>
              {`  ${line}`}
            </Text>
          ))}
        </Box>
      ) : null}
    </Box>
  );
});
ExecutionDiagnosisCard.displayName = "ExecutionDiagnosisCard";

export interface ResumeSummaryProps {
  active_target: {
    kind: "connector" | "workflow" | "none";
    name: string | null;
    environment: string | null;
  };
  stage: string;
  next_action: string;
  one_sentence: string;
  last_successful_probe: string | null;
  last_successful_preview: string | null;
}

export const ResumeSummaryCard: React.FC<ResumeSummaryProps> = memo(
  ({
    active_target,
    stage,
    next_action,
    one_sentence,
    last_successful_probe,
    last_successful_preview,
  }) => {
    return (
      <Box flexDirection="column" marginBottom={1}>
        <Box>
          <Text color="magenta" bold>
            ↺ resumed
          </Text>
          <Text dimColor>
            {" "}
            · {active_target.kind}
            {active_target.name ? ` "${active_target.name}"` : ""}
            {active_target.environment ? ` · ${active_target.environment}` : ""}
            {" · "}
            {stage}
          </Text>
        </Box>
        <Box marginLeft={2} flexDirection="column">
          <Text>{one_sentence}</Text>
          {last_successful_probe ? <Text dimColor>probe: {last_successful_probe}</Text> : null}
          {last_successful_preview ? (
            <Text dimColor>preview: {last_successful_preview}</Text>
          ) : null}
          <Text color="cyan">→ {next_action}</Text>
        </Box>
      </Box>
    );
  },
);
ResumeSummaryCard.displayName = "ResumeSummaryCard";

// Connector-draft card — fires on start_connector_from_* /
// update_connector_draft / validate_connector_draft. Shows the driver,
// auth, env, and validation-missing list inline under the tool call.
const ConnectorDraftCard: React.FC<CardProps> = memo(({ call }) => {
  const tone = statusTone(call);
  const d = unwrapData(call);
  const connector = asRecord(d?.connector) ?? d ?? null;
  if (!connector) {
    return (
      <Box flexDirection="column" marginBottom={1}>
        <Box>{badge(tone, call.name)}</Box>
      </Box>
    );
  }
  const name = typeof connector.name === "string" ? connector.name : null;
  const driver = typeof connector.driver === "string" ? connector.driver : null;
  const env = typeof connector.environment === "string" ? connector.environment : null;
  const auth = typeof connector.auth_type === "string" ? connector.auth_type : null;
  const missing = asRecord(connector.validation)?.missing_fields;
  const missingList = Array.isArray(missing) ? missing.filter((x) => typeof x === "string") : [];
  return (
    <Box flexDirection="column" marginBottom={1}>
      <Box>
        {badge(tone, tone === "pending" ? "Preparing connector" : "Connector draft ready")}
        <Text dimColor>
          {name ? ` · ${name}` : ""}
          {driver ? ` · ${driver}` : ""}
          {env ? ` · ${env}` : ""}
          {auth ? ` · auth=${auth}` : ""}
        </Text>
      </Box>
      {missingList.length > 0 ? (
        <Box marginLeft={2}>
          <Text color="yellow">missing: {missingList.join(", ")}</Text>
        </Box>
      ) : null}
    </Box>
  );
});
ConnectorDraftCard.displayName = "ConnectorDraftCard";

// Workflow-draft card — fires on propose_step / start_workflow_from_goal
// / build_workflow / connect_steps / update_param. One-line "N step(s),
// last step: <id> (<kind>)" plus validation errors when present.
const WorkflowDraftCard: React.FC<CardProps> = memo(({ call }) => {
  const tone = statusTone(call);
  const d = unwrapData(call);
  if (!d) {
    return (
      <Box flexDirection="column" marginBottom={1}>
        <Box>{badge(tone, call.name)}</Box>
      </Box>
    );
  }
  const nestedWorkflow = asRecord(d.workflow);
  const stepCount = typeof d.steps === "number" ? (d.steps as number) : null;
  const derivedStepCount =
    stepCount ??
    (typeof nestedWorkflow?.step_count === "number" ? nestedWorkflow.step_count : null);
  const lastStep = typeof d.last_step_id === "string" ? (d.last_step_id as string) : null;
  const kind = typeof d.step_type === "string" ? (d.step_type as string) : null;
  const name =
    typeof d.name === "string"
      ? (d.name as string)
      : typeof nestedWorkflow?.name === "string"
        ? (nestedWorkflow.name as string)
        : null;
  const errors = Array.isArray(d.errors) ? d.errors : [];
  return (
    <Box flexDirection="column" marginBottom={1}>
      <Box>
        {badge(tone, tone === "pending" ? "Drafting workflow" : "Workflow draft updated")}
        <Text dimColor>
          {name ? ` · ${name}` : ""}
          {derivedStepCount !== null
            ? ` · ${derivedStepCount} step${derivedStepCount === 1 ? "" : "s"}`
            : ""}
          {lastStep ? ` · last=${lastStep}` : ""}
          {kind ? ` (${kind})` : ""}
        </Text>
      </Box>
      {errors.length > 0 ? (
        <Box marginLeft={2} flexDirection="column">
          {errors.slice(0, 3).map((e, i) => {
            const rec = asRecord(e);
            const path = rec && typeof rec.path === "string" ? rec.path : "";
            const msg = rec && typeof rec.message === "string" ? rec.message : String(e);
            return (
              <Text key={`wfd-err-${i}`} color="red">
                {path ? `${path}: ` : ""}
                {msg}
              </Text>
            );
          })}
          {errors.length > 3 ? <Text dimColor>…and {errors.length - 3} more</Text> : null}
        </Box>
      ) : null}
    </Box>
  );
});
WorkflowDraftCard.displayName = "WorkflowDraftCard";

// Approval card — renders ask_user_confirm / ask_user_choice elicitation
// *requests* inline (while the user is answering) and their resolved
// outcome afterwards. The kind tells the user what they're approving.
const ApprovalCard: React.FC<CardProps> = memo(({ call }) => {
  const args = asRecord(call.args) ?? {};
  const d = unwrapData(call);
  const kind = typeof args.kind === "string" ? (args.kind as string) : call.name;
  const summary = typeof args.summary === "string" ? (args.summary as string) : null;
  const question = typeof args.question === "string" ? (args.question as string) : null;
  const confirmed =
    d && typeof (d as Record<string, unknown>).confirmed === "boolean"
      ? Boolean((d as Record<string, unknown>).confirmed)
      : null;
  const tone: CardTone =
    call.status === "running" || call.status === "pending"
      ? "pending"
      : confirmed === true
        ? "ok"
        : confirmed === false
          ? "fail"
          : statusTone(call);
  const verb =
    confirmed === true
      ? "approved"
      : confirmed === false
        ? "rejected"
        : call.status === "running" || call.status === "pending"
          ? "awaiting"
          : call.name;
  return (
    <Box flexDirection="column" marginBottom={1}>
      <Box>
        {badge(tone, `${verb}: ${kind}`)}
        {summary ? <Text dimColor>{` · ${summary}`}</Text> : null}
      </Box>
      {question && confirmed === null ? (
        <Box marginLeft={2}>
          <Text>{question}</Text>
        </Box>
      ) : null}
    </Box>
  );
});
ApprovalCard.displayName = "ApprovalCard";

const CHAT_MILESTONE_TOOLS = new Set([
  "probe_connector_draft",
  "probe_connector",
  "dry_run_step",
  "dry_run_workflow",
  "save_connector_draft",
  "commit_draft",
  "start_connector_from_description",
  "start_connector_from_template",
  "build_workflow",
  "start_workflow_from_goal",
  "run_workflow",
  "diagnose_latest_execution",
]);

// Tools we always render an in-flight card for (running/pending) —
// even in chat mode — so the user sees what the engine is doing. The
// `IN_FLIGHT_VISIBLE_TOOLS` set is broader than `CHAT_MILESTONE_TOOLS`
// because almost every authoring tool benefits from a "started" line
// while it's running. The reference codebase shows a shimmer for every
// tool call; we mirror that here with a single one-line indicator.
const IN_FLIGHT_VISIBLE_TOOLS = new Set([
  ...CHAT_MILESTONE_TOOLS,
  "propose_step",
  "build_workflow",
  "update_param",
  "connect_steps",
  "validate_draft",
  "inspect_workflow_draft",
  "inspect_connector_draft",
  "discover_connector_endpoints",
  "fetch_connector_docs",
  "list_connector_endpoints",
  "search_docs",
  "search_knowledge",
  "load_skill",
  "list_skill_suggestions",
]);

function shouldRenderInChat(call: ToolCallState): boolean {
  if (call.status === "running" || call.status === "pending") {
    return IN_FLIGHT_VISIBLE_TOOLS.has(call.name);
  }
  if (call.status === "failed") return CHAT_MILESTONE_TOOLS.has(call.name);
  return CHAT_MILESTONE_TOOLS.has(call.name);
}

// In-flight one-liner — renders while a tool call is running. Shows
// the tool name + a tiny one-line summary derived from the call's
// args. On completion the milestone card replaces this in place
// (because the same `call.id` keys both renders).
const InFlightToolCard: React.FC<CardProps> = memo(({ call }) => {
  const args = asRecord(call.args) ?? {};
  // Pick a single salient field from the args that helps the user
  // diagnose what's happening RIGHT NOW. Each tool surfaces something
  // different — preview shows step id, run shows env, propose_step
  // shows step.id+kind, etc.
  const stepArg = asRecord(args.step) ?? null;
  const summary =
    typeof args.url === "string"
      ? args.url
      : typeof args.path === "string" && typeof args.method === "string"
        ? `${args.method} ${args.path}`
        : typeof args.workflow_id === "string"
          ? `wf ${(args.workflow_id as string).slice(0, 8)}`
          : typeof stepArg?.id === "string"
            ? `${stepArg.id}${typeof stepArg?.kind === "string" ? ` (${stepArg.kind})` : ""}`
            : typeof args.environment === "string"
              ? `env=${args.environment}`
              : typeof args.template_id === "string"
                ? `template ${args.template_id}`
                : typeof args.query === "string"
                  ? `q="${previewLine(args.query, 60)}"`
                  : "";
  return (
    <Box flexDirection="column" marginBottom={0}>
      <Box>
        <Text color="cyan">… </Text>
        <Text dimColor>{call.name}</Text>
        {summary ? <Text dimColor>{` · ${summary}`}</Text> : null}
      </Box>
    </Box>
  );
});
InFlightToolCard.displayName = "InFlightToolCard";

// Dispatcher — returns a custom card for known authoring tools, or null
// so the caller falls back to the generic ToolCard.
export function renderAuthoringCard(
  call: ToolCallState,
  mode: AuthoringCardMode = "inspect",
): React.ReactNode | null {
  if (mode === "chat" && !shouldRenderInChat(call)) return null;
  // Running/pending tools render the in-flight one-liner so the user
  // sees what the engine is doing in real time, instead of a silent
  // 5–8s spinner with nothing on screen.
  if (call.status === "running" || call.status === "pending") {
    return <InFlightToolCard key={`acc-${call.id}-flight`} call={call} />;
  }
  switch (call.name) {
    case "probe_connector_draft":
    case "probe_connector":
      return <ConnectorProbeCard key={`acc-${call.id}`} call={call} />;
    case "dry_run_step":
    case "dry_run_workflow":
      return <StepPreviewCard key={`acc-${call.id}`} call={call} />;
    case "save_connector_draft":
      return <SaveResultCard key={`acc-${call.id}`} call={call} />;
    case "commit_draft":
      return <CommitResultCard key={`acc-${call.id}`} call={call} />;
    case "run_workflow":
    case "diagnose_latest_execution":
      return <ExecutionDiagnosisCard key={`acc-${call.id}`} call={call} />;
    case "start_connector_from_description":
    case "start_connector_from_template":
    case "update_connector_draft":
    case "validate_connector_draft":
    case "inspect_connector_draft":
      return <ConnectorDraftCard key={`acc-${call.id}`} call={call} />;
    case "start_workflow_from_goal":
    case "build_workflow":
    case "propose_step":
    case "update_param":
    case "connect_steps":
    case "validate_draft":
    case "inspect_workflow_draft":
      return <WorkflowDraftCard key={`acc-${call.id}`} call={call} />;
    case "ask_user_confirm":
    case "ask_user_choice":
    case "ask_user_multi":
      if (mode === "chat") return null;
      return <ApprovalCard key={`acc-${call.id}`} call={call} />;
    default:
      return null;
  }
}
