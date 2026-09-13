// Structured cards for high-signal authoring milestones.
//
// The chat view shows only these milestone cards; the inspect view can
// still fall back to raw tool cards for full engine transparency.
//
// Shared tone/badge chrome, envelope readers, and output-preview
// formatting live in authoring-cards-shared.tsx; the payload
// extractors, the probe/dry-run preview cards, and the reauth
// affordance live in the other authoring-cards-* siblings. This module
// keeps the remaining milestone cards plus the renderAuthoringCard
// dispatcher, and re-exports the extracted surface so existing
// importers are unaffected.

import type { ToolCallState } from "@cli-core/index.ts";
import { Box, Text } from "ink";
import type React from "react";
import { memo } from "react";

import { debugLog } from "../debug.ts";
import { IntentCard } from "../render/intent-card.tsx";
import { SummaryCard } from "../render/summary-card.tsx";
import { describeConfirmationPayload } from "./approval/describe-confirmation.ts";
import {
  extractConnectorIntent,
  extractConnectorSummary,
  extractKnowledgeSourceSummary,
  extractWorkflowSummary,
} from "./authoring-cards-extractors.ts";
import { ConnectorProbeCard, StepPreviewCard } from "./authoring-cards-previews.tsx";
import { extractReauthOutcome, ReauthCard } from "./authoring-cards-reauth.tsx";
import {
  asRecord,
  badge,
  type CardProps,
  type CardTone,
  isPolicyGatePending,
  previewLine,
  previewLines,
  statusTone,
  unwrapData,
} from "./authoring-cards-shared.tsx";

export {
  extractConnectorIntent,
  extractConnectorSummary,
  extractKnowledgeSourceSummary,
  extractWorkflowIntent,
  extractWorkflowSummary,
} from "./authoring-cards-extractors.ts";
export {
  extractReauthOutcome,
  ReauthCard,
  type ReauthCardProps,
  type ReauthOutcome,
  resetReauthAutoOpenForTests,
} from "./authoring-cards-reauth.tsx";
export { __testHooks, isPolicyGatePending } from "./authoring-cards-shared.tsx";

export type AuthoringCardMode = "chat" | "inspect";

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

// Workflow-draft card — fires on validate_draft / inspect_workflow_draft.
// One-line "N step(s), last step: <id> (<kind>)" plus validation errors
// when present.
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

// author_workflow — the one-shot authoring pipeline. The envelope is a
// draft-mutation payload carrying `{ workflow: { name, slug, goal,
// step_count }, definition, validation, recorded_eval: { ok, summary,
// expressions[], gates, missing_evidence, next_actions }, attempts,
// next_step: "dry_run_workflow" }`. The card answers three operator
// questions in one glance: what was built (name/slug/steps), did the
// recorded evaluation pass (clean vs. findings), and what happens next
// (always dry_run_workflow).
const AuthorWorkflowCard: React.FC<CardProps> = memo(({ call }) => {
  const tone = statusTone(call);
  const d = unwrapData(call);
  const workflow = asRecord(d?.workflow);
  const name =
    typeof workflow?.name === "string"
      ? workflow.name
      : typeof d?.name === "string"
        ? (d.name as string)
        : null;
  const slug = typeof workflow?.slug === "string" ? workflow.slug : null;
  // Step count + kinds summary from the full definition when present;
  // the lighter workflow.step_count otherwise.
  const definition = asRecord(d?.definition);
  const defSteps = Array.isArray(definition?.steps) ? definition.steps : null;
  const stepCount =
    defSteps?.length ?? (typeof workflow?.step_count === "number" ? workflow.step_count : null);
  const kindsSummary = (() => {
    if (!defSteps) return "";
    const counts = new Map<string, number>();
    for (const s of defSteps) {
      const kind = typeof asRecord(s)?.kind === "string" ? (asRecord(s)?.kind as string) : "step";
      counts.set(kind, (counts.get(kind) ?? 0) + 1);
    }
    return [...counts.entries()].map(([k, n]) => (n > 1 ? `${k}×${n}` : k)).join(", ");
  })();
  const attempts = typeof d?.attempts === "number" ? d.attempts : null;
  const nextStep = typeof d?.next_step === "string" ? d.next_step : "dry_run_workflow";

  // Failure envelope (gate error / pipeline failure): error_code +
  // message, no definition. Render the refusal plainly.
  const errorCode = typeof d?.error_code === "string" ? d.error_code : null;
  const message = typeof d?.message === "string" ? d.message : null;
  if (tone === "fail" || (errorCode && !definition)) {
    return (
      <Box flexDirection="column" marginBottom={1}>
        <Box>
          {badge("fail", "Workflow authoring failed")}
          {errorCode ? <Text dimColor>{` · ${errorCode}`}</Text> : null}
        </Box>
        {message ? (
          <Box marginLeft={2}>
            <Text color="yellow" wrap="wrap">
              {message}
            </Text>
          </Box>
        ) : null}
      </Box>
    );
  }

  // Recorded-eval verdict line. Clean → one quiet line. Findings →
  // count by status plus the first finding's site + message so the
  // operator sees WHERE without opening inspect view.
  const recordedEval = asRecord(d?.recorded_eval);
  const evalOk = recordedEval?.ok === true;
  const findings = (
    Array.isArray(recordedEval?.expressions) ? recordedEval.expressions : []
  ).flatMap((f) => {
    const r = asRecord(f);
    return r && typeof r.status === "string" && r.status !== "ok" ? [r] : [];
  });
  const findingsByStatus = (() => {
    const counts = new Map<string, number>();
    for (const f of findings)
      counts.set(f.status as string, (counts.get(f.status as string) ?? 0) + 1);
    return [...counts.entries()].map(([s, n]) => `${n} ${s}`).join(", ");
  })();
  const firstFinding = findings[0] ?? null;
  const firstFindingLine = firstFinding
    ? `${typeof firstFinding.site === "string" ? firstFinding.site : "(site)"}${
        typeof firstFinding.message === "string"
          ? ` — ${previewLine(firstFinding.message, 160)}`
          : ""
      }`
    : null;

  return (
    <Box flexDirection="column" marginBottom={1}>
      <Box>
        {badge(
          recordedEval && !evalOk ? "warn" : tone === "info" ? "ok" : tone,
          "Workflow authored",
        )}
        <Text dimColor>
          {name ? ` · ${name}` : ""}
          {slug ? ` · ${slug}` : ""}
          {stepCount !== null
            ? ` · ${stepCount} step${stepCount === 1 ? "" : "s"}${kindsSummary ? ` (${kindsSummary})` : ""}`
            : ""}
          {attempts !== null ? ` · ${attempts} attempt${attempts === 1 ? "" : "s"}` : ""}
        </Text>
      </Box>
      {recordedEval ? (
        evalOk ? (
          <Box marginLeft={2}>
            <Text color="green">evaluated clean against recorded evidence</Text>
          </Box>
        ) : (
          <Box marginLeft={2} flexDirection="column">
            <Text color="yellow">
              {`recorded eval: ${findings.length} finding${findings.length === 1 ? "" : "s"}${findingsByStatus ? ` (${findingsByStatus})` : ""}`}
            </Text>
            {firstFindingLine ? (
              <Text dimColor wrap="wrap">
                {firstFindingLine}
              </Text>
            ) : null}
          </Box>
        )
      ) : null}
      <Box marginLeft={2}>
        <Text color="cyan">→ {nextStep}</Text>
      </Box>
    </Box>
  );
});
AuthorWorkflowCard.displayName = "AuthorWorkflowCard";

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
  "author_workflow",
  "run_workflow",
  "diagnose_latest_execution",
  "create_knowledge_source",
  // The reauth affordance MUST surface in chat mode — the sign-in link
  // is the whole point of the tool result; hiding it behind inspect
  // view would dead-end the recovery flow.
  "request_connector_reauth",
]);

// Tools we render an in-flight card for (running/pending) — even in
// chat mode — so the operator sees what the engine is doing. The
// `IN_FLIGHT_VISIBLE_TOOLS` set is broader than `CHAT_MILESTONE_TOOLS`
// because authoring tools that *substantively edit* state benefit from
// a "started" line while running. Pure-introspection / pre-flight
// tools are EXCLUDED so the operator doesn't see the LLM's plumbing:
// `validate_draft`, `inspect_workflow_draft`, `inspect_connector_draft`
// load state for the LLM, never produce a result the operator needs to
// see; the assistant's `text_delta` narrative is what surfaces. The
// May 2026 OCPP review session showed 8+ cards for one workflow edit
// because every meta-tool got its own in-flight card.
const IN_FLIGHT_VISIBLE_TOOLS = new Set([
  ...CHAT_MILESTONE_TOOLS,
  // Excluded as of 6.2.13 — informational reads, not edits. They run
  // silently; the assistant narrates any salient outcome via text:
  //   "validate_draft", "inspect_workflow_draft", "inspect_connector_draft"
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
  // different — preview shows step id, run shows env, a step-shaped
  // arg shows step.id+kind, etc.
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
  // Policy-gated tenant-write tools (e.g. create_knowledge_source,
  // run_workflow, save_workflow_draft) return a sentinel envelope
  // BEFORE the side effect runs when policy is
  // `confirm_before_execution`. The companion `elicit_request` event
  // surfaces the approval UI separately. Suppress the result card so
  // the operator doesn't see "✓ Knowledge source ready" while the
  // engine is still waiting for the approve/decline click.
  if (isPolicyGatePending(call)) {
    return mode === "chat" ? null : (
      <InFlightToolCard key={`acc-${call.id}-pending-approval`} call={call} />
    );
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
    case "author_workflow":
      return <AuthorWorkflowCard key={`acc-${call.id}`} call={call} />;
    case "validate_draft":
    case "inspect_workflow_draft":
      return <WorkflowDraftCard key={`acc-${call.id}`} call={call} />;
    case "request_connector_reauth": {
      const outcome = extractReauthOutcome(call);
      if (outcome) return <ReauthCard key={`acc-${call.id}`} call={call} outcome={outcome} />;
      // Errors and the non-OAuth credential_re_issue path (which the
      // assistant narrates and follows with ask_user_form) render the
      // generic milestone line.
      return <GenericMilestoneCard key={`acc-${call.id}`} call={call} label="Connector re-auth" />;
    }
    case "ask_user_confirm":
    case "ask_user_choice":
    case "ask_user_multi":
      if (mode === "chat") return null;
      return <ApprovalCard key={`acc-${call.id}`} call={call} />;
    default:
      return null;
  }
}
