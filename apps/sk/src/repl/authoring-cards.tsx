// Structured cards for high-signal authoring milestones.
//
// The chat view shows only these milestone cards; the inspect view can
// still fall back to raw tool cards for full engine transparency.

import type { ToolCallState } from "@cli-core/index.ts";
import { Box, Text } from "ink";
import type React from "react";
import { memo } from "react";
import { debugLog } from "../debug.ts";
import { IntentCard } from "../render/intent-card.tsx";
import { SummaryCard } from "../render/summary-card.tsx";
import type {
  ConnectorIntent,
  ConnectorSummary,
  KnowledgeSourceSummary,
  WorkflowIntent,
  WorkflowSummary,
  WorkflowTrigger,
} from "../render/types.ts";
import { describeConfirmationPayload } from "./approval/describe-confirmation.ts";

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
  // Array-of-objects: render as a human-readable bulleted list so the
  // operator can read the actual values at a glance instead of having
  // to mentally parse JSON. Pre-fix the run_workflow card showed
  // [{ "project_id": "d6742...", … }] truncated mid-string and the
  // user couldn't see the data — they had to ask the LLM to reformat,
  // which doubled tokens and round-trips. This is chat/MCP-only by
  // construction (the card never renders in HTTP/webhook responses);
  // raw JSON ships unchanged through HTTP.
  if (Array.isArray(v) && v.length > 0 && typeof v[0] === "object" && v[0] !== null) {
    return renderArrayOfObjects(v as Array<Record<string, unknown>>, maxLines, maxWidth);
  }
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

/**
 * Render an array of objects as a bulleted list:
 *
 *   1. <name-or-id>
 *      • field: value
 *      • nested_array: <count> items
 *
 * Picks a "title" key (name / title / slug / id / ...) heuristically.
 * Nested arrays show their length; nested objects show "<obj>". Long
 * primitive values are truncated to maxWidth. Keeps the operator's
 * mental model aligned with the actual workflow output without
 * forcing the LLM to reformat in prose.
 */
const TITLE_KEYS = ["name", "title", "slug", "project_name", "id", "project_id"] as const;

/**
 * Walk one level into nested objects to find a title-shaped string field.
 * For shape `{ project: { name: "X" }, resources: [...] }` returns
 * `{ key: "project.name", value: "X" }`. Walks one level only — deeper
 * nesting is rare in workflow outputs and would risk picking up unrelated
 * id-like leaves. Falls back to first nested string-valued field on a
 * one-level child if no canonical title key is found.
 */
function findNestedTitle(obj: Record<string, unknown>): { key: string; value: string } | null {
  for (const k of TITLE_KEYS) {
    if (typeof obj[k] === "string") return { key: k, value: obj[k] as string };
  }
  for (const [parentKey, child] of Object.entries(obj)) {
    if (!child || typeof child !== "object" || Array.isArray(child)) continue;
    const childObj = child as Record<string, unknown>;
    for (const k of TITLE_KEYS) {
      if (typeof childObj[k] === "string") {
        return { key: `${parentKey}.${k}`, value: childObj[k] as string };
      }
    }
  }
  // Last-resort: first string field on a nested object whose value
  // isn't itself a path/url/uuid pattern. Keeps the renderer useful
  // even when the upstream API uses non-standard names.
  for (const [parentKey, child] of Object.entries(obj)) {
    if (!child || typeof child !== "object" || Array.isArray(child)) continue;
    const childObj = child as Record<string, unknown>;
    for (const [k, v] of Object.entries(childObj)) {
      if (typeof v === "string" && v.length > 0 && v.length <= 80) {
        return { key: `${parentKey}.${k}`, value: v };
      }
    }
  }
  return null;
}

/**
 * Format a count suffix for arrays / nested arrays of objects so the
 * row reads "Title — N resources" instead of "Title  • resources: <4 items>".
 */
function arrayCountSuffix(obj: Record<string, unknown>): string | null {
  for (const [k, v] of Object.entries(obj)) {
    if (Array.isArray(v) && v.length > 0 && typeof v[0] === "object") {
      return `${v.length} ${k}`;
    }
  }
  return null;
}

function renderArrayOfObjects(
  arr: Array<Record<string, unknown>>,
  maxLines: number,
  maxWidth: number,
): string[] {
  const out: string[] = [];
  const itemBudget = Math.max(2, Math.floor(maxLines / Math.min(arr.length, 10)));
  for (let i = 0; i < arr.length && out.length < maxLines; i++) {
    const obj = arr[i] ?? {};
    const found = findNestedTitle(obj);
    const title = found ? found.value : `item ${i + 1}`;
    const countSuffix = arrayCountSuffix(obj);
    const headline = countSuffix ? `${title} — ${countSuffix}` : title;
    out.push(`${i + 1}. ${headline.slice(0, maxWidth - 4)}`);
    let fieldsRendered = 0;
    const skipKey = found && !found.key.includes(".") ? found.key : null;
    for (const [k, v] of Object.entries(obj)) {
      if (k === skipKey) continue;
      if (fieldsRendered >= itemBudget) break;
      const valueStr = renderValueInline(v, maxWidth - k.length - 8);
      out.push(`   • ${k}: ${valueStr}`);
      fieldsRendered++;
      if (out.length >= maxLines) break;
    }
  }
  if (arr.length * 2 > maxLines) {
    out.push(`… +${arr.length} items total`);
  }
  return out;
}

// Test-only re-export of internal helpers so the array-of-objects
// renderer can be unit-tested without spinning up Ink.
export const __testHooks = { previewLines, renderArrayOfObjects };

function renderValueInline(v: unknown, maxLen: number): string {
  if (v === null || v === undefined) return "—";
  if (Array.isArray(v)) {
    if (v.length === 0) return "[]";
    if (typeof v[0] === "object" && v[0] !== null) return `<${v.length} items>`;
    const joined = v
      .slice(0, 3)
      .map((x) => String(x))
      .join(", ");
    return v.length > 3
      ? `[${joined}, …+${v.length - 3}]`.slice(0, maxLen)
      : `[${joined}]`.slice(0, maxLen);
  }
  if (typeof v === "object") return "<obj>";
  const s = String(v);
  return s.length > maxLen ? `${s.slice(0, maxLen - 1)}…` : s;
}

function statusTone(call: ToolCallState): CardTone {
  if (call.status === "failed") return "fail";
  if (call.status === "running" || call.status === "pending") return "pending";
  const d = unwrapData(call);
  const okFlag = d && typeof d.ok === "boolean" ? d.ok : null;
  // A `needs_repair` preview is `ok:false` (the workflow produced broken
  // output — an empty transform, an unresolved ref) but the run itself
  // did not crash. Render it as a warning, not a hard driver failure,
  // so the operator reads "fix this" rather than "the engine died".
  if (d?.classification === "needs_repair") return "warn";
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
  // step_outputs[] is the per-step preview array dry_run_workflow
  // emits (#22). When present we surface the LAST step's preview as
  // the "what did the workflow produce" line — pre-fix the dry-run
  // card stopped at the summary and the user had to ask the LLM to
  // show the data (session 86de186b).
  const stepOutputs = Array.isArray(d?.step_outputs) ? (d?.step_outputs as unknown[]) : null;
  const lastStepFromOutputs =
    stepOutputs && stepOutputs.length > 0 ? asRecord(stepOutputs[stepOutputs.length - 1]) : null;
  const lastStep = asRecord(d?.last_step);
  const output =
    d?.output ??
    d?.preview ??
    d?.output_preview ??
    lastStep?.output_preview ??
    lastStepFromOutputs?.output_preview;
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
              : classification === "needs_repair"
                ? "Preview needs repair"
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
  // When missing AND the call lifecycle says "done", the engine sent a
  // tool_result without a status field — that is a contract bug, NOT a
  // run state. We log it as `card.execution_status_missing` so the
  // regression stays detectable for engineers, but render a friendly
  // "Awaiting result..." badge to the user instead of the scary
  // `× bug, not a state` literal that scared the operator in session
  // a6440493. The user has nothing to act on; making them stare at a
  // dev-targeted error is worse than silently surfacing pending state.
  const rawStatus = typeof d?.status === "string" ? d.status : null;
  const status =
    rawStatus ??
    (call.status === "running" || call.status === "pending"
      ? "running"
      : call.status === "failed"
        ? "failed"
        : null);
  const statusMissing = rawStatus === null && status === null;
  if (statusMissing) {
    debugLog(
      "dialog.error",
      {
        stage: "execution_status_missing",
        tool: call.name,
        call_id: call.id,
        call_status: call.status,
        data_keys:
          d && typeof d === "object" ? Object.keys(d as Record<string, unknown>).length : 0,
      },
      {},
    );
  }
  const warnings = Array.isArray(d?.warnings) ? d.warnings.length : 0;
  const needsDiagnosis = d?.diagnosis_available === true;
  const isPartial = rawStatus === "partial_success";
  // Surface the ACTUAL warning(s) the run produced — never a hardcoded
  // cause. A `partial_success` can come from an empty transform, an
  // unresolved reference, a loop that never iterated, etc. The engine
  // already ships a human-readable message on every warning; the card
  // must read it instead of asserting "Loop body produced no rows" for
  // a workflow that may have no loop at all.
  const warningEntries = Array.isArray(d?.warnings)
    ? (d.warnings as Array<{ code?: string; message?: string }>)
    : [];
  const warningLine = (() => {
    const msgs = warningEntries
      .map((w) => (typeof w.message === "string" && w.message ? w.message : w.code))
      .filter((m): m is string => typeof m === "string" && m.length > 0)
      .map((m) => (m.length > 180 ? `${m.slice(0, 179)}…` : m));
    if (msgs.length > 0) return msgs.join(" · ");
    if (typeof d?.warning_summary === "string" && d.warning_summary) return d.warning_summary;
    return null;
  })();
  const version = typeof d?.workflow_version === "number" ? ` · v${d.workflow_version}` : "";
  const output = d?.output;
  const outputLines =
    !needsDiagnosis && !statusMissing && output !== undefined && output !== null
      ? previewLines(output)
      : [];
  const hasOutput = outputLines.length > 0;
  const headerTone: CardTone = statusMissing ? "info" : needsDiagnosis || isPartial ? "warn" : tone;
  const headerLabel = statusMissing
    ? "Awaiting execution result…"
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
            {warningLine ??
              (needsDiagnosis
                ? "Open diagnosis before editing the workflow."
                : "This run needs a closer look before you rely on it.")}
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

// Generic milestone fallback — used when a tool fires a milestone card
// but its result shape didn't match the dedicated extractor. Renders
// a single tone-aware line plus a short preview of the result so the
// chat conversation always has *something* to say instead of going
// silent on a shape regression.
const GenericMilestoneCard: React.FC<CardProps & { label: string }> = memo(({ call, label }) => {
  const tone = statusTone(call);
  const d = unwrapData(call);
  const errorCode = typeof d?.error === "string" ? d.error : null;
  const message = typeof d?.message === "string" ? d.message : null;
  const headline =
    tone === "fail"
      ? `${label} failed`
      : tone === "pending"
        ? `${label} in progress`
        : tone === "warn"
          ? `${label} returned a warning`
          : `${label} ready`;
  const detail = errorCode ?? message ?? previewLine(d, 100);
  return (
    <Box flexDirection="column" marginBottom={1}>
      <Box>{badge(tone, headline)}</Box>
      {detail ? (
        <Box marginLeft={2}>
          <Text dimColor>{detail}</Text>
        </Box>
      ) : null}
    </Box>
  );
});
GenericMilestoneCard.displayName = "GenericMilestoneCard";

// Approval card — renders ask_user_confirm / ask_user_choice elicitation
// *requests* inline (while the user is answering) and their resolved
// outcome afterwards. The kind tells the user what they're approving.
const ApprovalCard: React.FC<CardProps> = memo(({ call }) => {
  const args = asRecord(call.args) ?? {};
  const d = unwrapData(call);
  const kind = typeof args.kind === "string" ? (args.kind as string) : call.name;
  const question = typeof args.question === "string" ? (args.question as string) : null;
  const confirmed =
    d && typeof (d as Record<string, unknown>).confirmed === "boolean"
      ? Boolean((d as Record<string, unknown>).confirmed)
      : null;
  const summaryPreview = describeConfirmationPayload(args);
  const summary =
    confirmed === null && question !== null && summaryPreview === question ? null : summaryPreview;
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
  "save_workflow_draft",
  "start_connector_from_description",
  "start_connector_from_template",
  "build_workflow",
  "start_workflow_from_goal",
  "run_workflow",
  "diagnose_latest_execution",
  "create_knowledge_source",
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
  "create_knowledge_source",
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

// Safe extractors — return a typed Intent/Summary built from the tool
// payload, or null when the shape doesn't match. Callers fall back to
// the legacy compact cards on null, so engine response evolution
// doesn't break the REPL.
function extractTrigger(raw: unknown): WorkflowTrigger {
  const r = asRecord(raw);
  if (r) {
    if (r.kind === "schedule") {
      return {
        kind: "schedule",
        cron: typeof r.cron === "string" ? r.cron : "?",
        tz: typeof r.tz === "string" ? r.tz : "UTC",
      };
    }
    if (r.kind === "webhook") {
      return {
        kind: "webhook",
        source: typeof r.source === "string" ? r.source : "?",
        events: Array.isArray(r.events) ? r.events.filter((e) => typeof e === "string") : [],
      };
    }
  }
  return { kind: "request" };
}

export function extractWorkflowIntent(call: ToolCallState): WorkflowIntent | null {
  const d = unwrapData(call);
  if (!d) return null;
  const workflow = asRecord(d.workflow) ?? d;
  const definition = asRecord(workflow.definition) ?? asRecord(d.definition);
  const rawSteps =
    (Array.isArray(definition?.steps) && definition?.steps) ||
    (Array.isArray(workflow.steps) && (workflow.steps as unknown[])) ||
    null;
  if (!rawSteps) return null;
  const name =
    typeof workflow.name === "string" ? workflow.name : typeof d.name === "string" ? d.name : null;
  if (!name) return null;
  const steps = rawSteps
    .map((s) => {
      const r = asRecord(s);
      if (!r) return null;
      return {
        key: typeof r.key === "string" ? r.key : typeof r.id === "string" ? r.id : "(step)",
        kind: typeof r.kind === "string" ? r.kind : "step",
        ...(typeof r.connector_slug === "string"
          ? { connector_slug: r.connector_slug as string }
          : {}),
      };
    })
    .filter((s): s is { key: string; kind: string; connector_slug?: string } => s !== null);
  return {
    name,
    ...(typeof workflow.slug === "string" ? { slug: workflow.slug as string } : {}),
    trigger: extractTrigger(definition?.trigger ?? workflow.trigger),
    steps,
  };
}

export function extractConnectorIntent(call: ToolCallState): ConnectorIntent | null {
  const d = unwrapData(call);
  if (!d) return null;
  const connector = asRecord(d.connector) ?? d;
  const templateSlug =
    typeof connector.template_slug === "string"
      ? connector.template_slug
      : typeof d.template_slug === "string"
        ? d.template_slug
        : null;
  if (!templateSlug) return null;
  const env = connector.environment;
  return {
    template_slug: templateSlug,
    ...(typeof connector.name === "string" ? { name: connector.name as string } : {}),
    ...(env === "dev" || env === "prod" ? { environment: env } : {}),
    ...(typeof connector.auth_type === "string"
      ? { auth_type: connector.auth_type as string }
      : {}),
    ...(typeof connector.base_url === "string" ? { base_url: connector.base_url as string } : {}),
  };
}

export function extractWorkflowSummary(call: ToolCallState): WorkflowSummary | null {
  const d = unwrapData(call);
  if (!d) return null;
  const id = typeof d.workflow_id === "string" ? d.workflow_id : null;
  if (!id) return null;
  const workflow = asRecord(d.workflow) ?? {};
  const name =
    typeof workflow.name === "string" ? workflow.name : typeof d.name === "string" ? d.name : null;
  const version =
    typeof d.version === "number"
      ? d.version
      : typeof workflow.version === "number"
        ? workflow.version
        : null;
  if (!name || version === null) return null;
  const definition = asRecord(workflow.definition) ?? asRecord(d.definition) ?? {};
  return {
    id,
    version,
    name,
    trigger: extractTrigger(definition.trigger),
  };
}

export function extractConnectorSummary(call: ToolCallState): ConnectorSummary | null {
  const d = unwrapData(call);
  if (!d) return null;
  const connector = asRecord(d.connector);
  if (!connector) return null;
  const id = typeof connector.id === "string" ? connector.id : null;
  const slug = typeof connector.slug === "string" ? connector.slug : null;
  const templateSlug = typeof connector.template_slug === "string" ? connector.template_slug : null;
  if (!id || !slug || !templateSlug) return null;
  return { id, slug, template_slug: templateSlug };
}

// create_knowledge_source returns
//   { created: true, knowledge_source: { id, name, slug, scope, status,
//     chunk_count, bytes_total }, audit_log_id }
// The tool intentionally does NOT echo back mime_type or file_id —
// those are inputs. We recover what we can from `call.args`
// (`mime_type` for inline mode, `file_id` for from_attachment) so the
// card matches the existing `KnowledgeSourceSummary` rendering used by
// the CLI `sk knowledge-sources create` command.
export function extractKnowledgeSourceSummary(call: ToolCallState): KnowledgeSourceSummary | null {
  const d = unwrapData(call);
  if (!d) return null;
  const ks = asRecord(d.knowledge_source);
  if (!ks) return null;
  const id = typeof ks.id === "string" ? ks.id : null;
  const name = typeof ks.name === "string" ? ks.name : null;
  if (!id || !name) return null;
  const bytes_total = typeof ks.bytes_total === "number" ? ks.bytes_total : 0;
  const args = asRecord(call.args) ?? {};
  const argMime = typeof args.mime_type === "string" ? args.mime_type : null;
  const argFileId = typeof args.file_id === "string" ? args.file_id : null;
  // Default inline mode is text/markdown per the tool implementation;
  // fall back to that when args didn't carry one.
  const mime_type =
    argMime ?? (args.mode === "inline" ? "text/markdown" : "application/octet-stream");
  return {
    id,
    name,
    mime_type,
    size_bytes: bytes_total,
    ...(argFileId ? { file_id: argFileId } : {}),
  };
}

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
    case "save_connector_draft": {
      const summary = extractConnectorSummary(call);
      if (summary) return <SummaryCard key={`acc-${call.id}`} summary={summary} />;
      return <SaveResultCard key={`acc-${call.id}`} call={call} />;
    }
    case "save_workflow_draft": {
      const summary = extractWorkflowSummary(call);
      if (summary) return <SummaryCard key={`acc-${call.id}`} summary={summary} />;
      return <CommitResultCard key={`acc-${call.id}`} call={call} />;
    }
    case "create_knowledge_source": {
      const summary = extractKnowledgeSourceSummary(call);
      if (summary) return <SummaryCard key={`acc-${call.id}`} summary={summary} />;
      // Fall back to a compact one-liner when the result shape didn't
      // match — keeps the chat narration alive instead of vanishing.
      return <GenericMilestoneCard key={`acc-${call.id}`} call={call} label="Knowledge source" />;
    }
    case "run_workflow":
    case "diagnose_latest_execution":
      return <ExecutionDiagnosisCard key={`acc-${call.id}`} call={call} />;
    case "start_connector_from_description":
    case "start_connector_from_template": {
      const intent = extractConnectorIntent(call);
      if (intent) return <IntentCard key={`acc-${call.id}`} intent={intent} />;
      return <ConnectorDraftCard key={`acc-${call.id}`} call={call} />;
    }
    case "update_connector_draft":
    case "validate_connector_draft":
    case "inspect_connector_draft":
      return <ConnectorDraftCard key={`acc-${call.id}`} call={call} />;
    case "start_workflow_from_goal":
    case "build_workflow": {
      const intent = extractWorkflowIntent(call);
      if (intent) return <IntentCard key={`acc-${call.id}`} intent={intent} />;
      return <WorkflowDraftCard key={`acc-${call.id}`} call={call} />;
    }
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
