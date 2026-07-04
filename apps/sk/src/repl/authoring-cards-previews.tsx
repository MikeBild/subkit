// Endpoint-check and dry-run preview cards. ConnectorProbeCard renders
// probe_connector / probe_connector_draft results (incl. the scrubbed
// upstream failure preview); StepPreviewCard renders dry_run_step /
// dry_run_workflow envelopes — per-step trace, held writes, judge
// verdict, and the last-step output preview. Extracted verbatim from
// authoring-cards.tsx, which keeps the renderAuthoringCard dispatch.

import { Box, Text } from "ink";
import type React from "react";
import { memo } from "react";
import {
  asRecord,
  badge,
  type CardProps,
  previewLine,
  previewLines,
  statusTone,
  unwrapData,
} from "./authoring-cards-shared.tsx";

export const ConnectorProbeCard: React.FC<CardProps> = memo(({ call }) => {
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
  // On failure surface the upstream's own words — the engine ships
  // a scrubbed `response_preview` body snippet plus allowlisted
  // diagnostic `response_headers` (www-authenticate, x-*-loginreason,
  // …) on the probe summary. Pre-fix the card stopped at "HTTP 403".
  const failed = probe?.ok === false;
  const rawPreview = typeof probe?.response_preview === "string" ? probe.response_preview : "";
  const preview = rawPreview.length > 200 ? `${rawPreview.slice(0, 200)}…` : rawPreview;
  const headerBag = asRecord(probe?.response_headers);
  const headerLine = headerBag
    ? Object.entries(headerBag)
        .map(([k, v]) => `${k}=${String(v)}`)
        .join(" · ")
    : "";
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
      {failed && preview ? (
        <Box marginLeft={2}>
          <Text dimColor>{preview}</Text>
        </Box>
      ) : null}
      {failed && headerLine ? (
        <Box marginLeft={2}>
          <Text dimColor>{headerLine}</Text>
        </Box>
      ) : null}
    </Box>
  );
});
ConnectorProbeCard.displayName = "ConnectorProbeCard";

export const StepPreviewCard: React.FC<CardProps> = memo(({ call }) => {
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
  // `step_trace` is the canonical per-step array on the dry_run_workflow
  // envelope (both the blocked and the auto-committed shapes); `steps`
  // is the older key some tools still emit. Read both.
  const stepPreviews = Array.isArray(d?.steps)
    ? (d?.steps as unknown[])
    : Array.isArray(d?.step_trace)
      ? (d?.step_trace as unknown[])
      : null;
  // Instruction-grounded preview judge (dry_run_workflow). `passes`
  // renders one quiet line, `skipped` renders nothing, partial/failed
  // render a prominent block — the verdict is WHY the preview did not
  // auto-commit, so hiding it would leave the operator staring at an
  // unexplained needs_repair.
  const judge = asRecord(d?.judge);
  const judgeVerdict = typeof judge?.verdict === "string" ? judge.verdict : null;
  const judgeReason = typeof judge?.reason === "string" ? judge.reason : null;
  const judgeMissing = Array.isArray(judge?.missing)
    ? judge.missing.filter((m): m is string => typeof m === "string")
    : [];
  // step_outputs[] is the per-step preview array dry_run_workflow
  // emits. When present we surface the LAST step's preview as
  // the "what did the workflow produce" line — without it the dry-run
  // card stops at the summary and the user has to ask the LLM to
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
                : typeof r?.step_id === "string"
                  ? r.step_id
                  : typeof r?.id === "string"
                    ? r.id
                    : `step_${i}`;
            const sStatus = typeof r?.status === "string" ? r.status : "?";
            const sKind = typeof r?.kind === "string" ? r.kind : "";
            const sDur = typeof r?.duration_ms === "number" ? `${r.duration_ms}ms` : "";
            // Hold-writes preview: the step was resolved but NOT
            // dispatched. It must never read as a normal green step —
            // the materialized request (method, URL, body) is the
            // operator's review artifact, so it gets its own block.
            if (r?.held === true) {
              const hr = asRecord(r?.held_request);
              const hMethod = typeof hr?.method === "string" ? hr.method : "";
              const hUrl = typeof hr?.url === "string" ? hr.url : "";
              const hBody = previewLine(hr?.body, 200);
              return (
                <Box key={`pv-step-${call.id}-${i}`} flexDirection="column">
                  <Text>
                    {"  "}
                    <Text color="yellow" bold>
                      ⏸ HELD
                    </Text>
                    <Text color="yellow"> — resolved, not dispatched</Text>
                    <Text
                      dimColor
                    >{` · ${id}${sKind ? ` (${sKind})` : ""}${sDur ? ` · ${sDur}` : ""}`}</Text>
                  </Text>
                  {hMethod || hUrl ? (
                    <Text dimColor>{`    ${[hMethod, hUrl].filter(Boolean).join(" ")}`}</Text>
                  ) : null}
                  {hBody ? <Text dimColor>{`    body: ${hBody}`}</Text> : null}
                </Box>
              );
            }
            const sOut = previewLine(r?.output_preview ?? r?.output, 80);
            return (
              <Text key={`pv-step-${call.id}-${i}`} dimColor>
                {`  ${sStatus === "succeeded" ? "✓" : sStatus === "failed" ? "✗" : "·"} ${id}${sKind ? ` (${sKind})` : ""}${sDur ? ` · ${sDur}` : ""}${sOut ? ` · ${sOut}` : ""}`}
              </Text>
            );
          })}
        </Box>
      ) : null}
      {judgeVerdict === "passes" ? (
        <Box marginLeft={2}>
          <Text dimColor>judge: passes</Text>
        </Box>
      ) : null}
      {judgeVerdict === "partial" || judgeVerdict === "failed" ? (
        <Box marginLeft={2} flexDirection="column">
          <Text color={judgeVerdict === "failed" ? "red" : "yellow"} bold>
            ⚖ judge: {judgeVerdict} — preview does not satisfy the goal
          </Text>
          {judgeReason ? (
            <Text color="yellow" wrap="wrap">
              {judgeReason}
            </Text>
          ) : null}
          {judgeMissing.map((m, i) => (
            <Text key={`pv-judge-miss-${call.id}-${i}`} color="yellow">
              {`  • ${m}`}
            </Text>
          ))}
          <Text dimColor>
            fix via edit_workflow_patch and re-run dry_run_workflow — or save explicitly
            (save_workflow_draft) to commit anyway
          </Text>
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
