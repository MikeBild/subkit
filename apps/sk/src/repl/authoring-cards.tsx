// Structured cards for authoring-tool transcript rows.
//
// Dispatched by tool_name in ink-app.tsx. Falls back to the generic
// <ToolCard> for anything not listed here. Each card shows a one-line
// summary plus a status badge; full details live in the pane bound to
// the tool (probe-results / preview-results / commit-result) via
// slash commands.

import type { ToolCallState } from "@cli-core/index.ts";
import { Box, Text } from "ink";
import type React from "react";
import { memo } from "react";

type CardTone = "ok" | "fail" | "pending" | "info";

function toneColor(tone: CardTone): string {
  switch (tone) {
    case "ok":
      return "green";
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
  const glyph = tone === "ok" ? "✓" : tone === "fail" ? "×" : tone === "pending" ? "…" : "·";
  return (
    <Text color={color} bold>
      {glyph} {label}
    </Text>
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

function statusTone(call: ToolCallState): CardTone {
  if (call.status === "failed") return "fail";
  if (call.status === "running" || call.status === "pending") return "pending";
  const d = unwrapData(call);
  if (d && typeof d.ok === "boolean") return d.ok ? "ok" : "fail";
  return call.status === "done" ? "ok" : "info";
}

interface CardProps {
  call: ToolCallState;
}

const ConnectorProbeCard: React.FC<CardProps> = memo(({ call }) => {
  const tone = statusTone(call);
  const d = unwrapData(call);
  const probe = asRecord(d?.latest_probe);
  const method = typeof probe?.method === "string" ? probe.method : "(method)";
  const path = typeof probe?.path === "string" ? probe.path : "(path)";
  const env = typeof probe?.environment === "string" ? probe.environment : "dev";
  const status = typeof probe?.status_code === "number" ? `HTTP ${probe.status_code}` : null;
  const duration = typeof probe?.duration_ms === "number" ? `${probe.duration_ms}ms` : null;
  const summary = typeof probe?.summary === "string" ? probe.summary : "";
  return (
    <Box flexDirection="column" marginBottom={1}>
      <Box>
        {badge(tone, `probe ${method} ${path}`)}
        <Text dimColor>
          {" "}
          · {env}
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
  const kind = call.name === "dry_run_workflow" ? "workflow preview" : `preview ${stepId}`;
  return (
    <Box flexDirection="column" marginBottom={1}>
      <Box>
        {badge(tone, kind)}
        <Text dimColor>
          {classification ? ` · ${classification}` : ""}
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
          {badge(tone, `saved connector "${name}"`)}
          <Text dimColor>
            {slug ? ` · ${slug}` : ""}
            {env ? ` · ${env}` : ""}
          </Text>
        </Box>
      </Box>
    );
  }
  if (d && d.error === "probe_required") {
    return (
      <Box flexDirection="column" marginBottom={1}>
        <Box>{badge("fail", "save blocked — probe required")}</Box>
        <Box marginLeft={2}>
          <Text color="yellow">
            Probe the connector successfully before saving, or retry with force=true.
          </Text>
        </Box>
      </Box>
    );
  }
  return (
    <Box flexDirection="column" marginBottom={1}>
      <Box>{badge(tone, "save_connector_draft")}</Box>
    </Box>
  );
});
SaveResultCard.displayName = "SaveResultCard";

const CommitResultCard: React.FC<CardProps> = memo(({ call }) => {
  const tone = statusTone(call);
  const d = unwrapData(call);
  if (d && typeof d.workflow_id === "string") {
    const slug = typeof d.slug === "string" ? d.slug : "";
    return (
      <Box flexDirection="column" marginBottom={1}>
        <Box>
          {badge(tone, `committed workflow${slug ? ` ${slug}` : ""}`)}
          <Text dimColor>{` · ${d.workflow_id}`}</Text>
        </Box>
      </Box>
    );
  }
  if (d && d.error === "preview_required") {
    return (
      <Box flexDirection="column" marginBottom={1}>
        <Box>{badge("fail", "commit blocked — preview required")}</Box>
        <Box marginLeft={2}>
          <Text color="yellow">
            Run dry_run_step or dry_run_workflow successfully, or retry with force=true.
          </Text>
        </Box>
      </Box>
    );
  }
  return (
    <Box flexDirection="column" marginBottom={1}>
      <Box>{badge(tone, "commit_draft")}</Box>
    </Box>
  );
});
CommitResultCard.displayName = "CommitResultCard";

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

// Dispatcher — returns a custom card for known authoring tools, or null
// so the caller falls back to the generic ToolCard.
export function renderAuthoringCard(call: ToolCallState): React.ReactNode | null {
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
    default:
      return null;
  }
}
