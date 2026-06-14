import { Box, Text } from "ink";
import type React from "react";
import {
  humanBytes,
  isConnectorSummary,
  isKnowledgeSourceSummary,
  isWorkflowSummary,
  triggerLine,
} from "./helpers.ts";
import type {
  ConnectorSummary,
  FollowUpOption,
  KnowledgeSourceSummary,
  ResourceUsage,
  WorkflowSummary,
} from "./types.ts";

export type AnySummary = WorkflowSummary | ConnectorSummary | KnowledgeSourceSummary;

// Dynamic usage block — renders the engine-provided `usage` payload
// (inputs, output, access mechanisms, follow-up) from the persist
// envelope. When `usage` is absent (degenerate envelope) the card
// renders without it; there is no hardcoded command fallback.
const UsageBlock: React.FC<{ usage: ResourceUsage }> = ({ usage }) => (
  <Box flexDirection="column" marginTop={1}>
    {usage.inputs.length > 0 ? (
      <Box marginLeft={2}>
        <Text dimColor>
          inputs:{" "}
          {usage.inputs.map((i) => `${i.name}${i.required ? " (required)" : ""}`).join(", ")}
        </Text>
      </Box>
    ) : null}
    {usage.output ? (
      <Box marginLeft={2}>
        <Text dimColor>output: {usage.output}</Text>
      </Box>
    ) : null}
    <Text dimColor>Use it via:</Text>
    {usage.access.map((entry, i) => (
      <Box key={`use-${entry.via}-${i}`} marginLeft={2}>
        <Text dimColor>
          {entry.label}: {entry.command ?? entry.url ?? entry.tool ?? ""}
          {entry.detail ? ` — ${entry.detail}` : ""}
        </Text>
      </Box>
    ))}
    <Box marginTop={1} flexDirection="column">
      {usage.follow_up_options && usage.follow_up_options.length > 0 ? (
        usage.follow_up_options.map((opt: FollowUpOption, i: number) => (
          <Box key={`opt-${opt.value}-${i}`} marginLeft={2}>
            <Text dimColor>
              {`${i + 1}. ${opt.label}`}
              {opt.detail ? `: ${opt.detail}` : ""}
            </Text>
          </Box>
        ))
      ) : (
        <Text dimColor italic>
          {usage.follow_up}
        </Text>
      )}
    </Box>
  </Box>
);

const WorkflowSummaryCard: React.FC<{ summary: WorkflowSummary }> = ({ summary }) => {
  return (
    <Box flexDirection="column" marginBottom={1}>
      <Box>
        <Text color="green" bold>
          {"✓ "}
        </Text>
        <Text
          bold
        >{`Created workflow "${summary.name}" · id=${summary.id} · version=${summary.version}`}</Text>
      </Box>
      <Box marginLeft={2}>
        <Text dimColor>trigger: {triggerLine(summary.trigger)}</Text>
      </Box>
      {summary.preview_execution_id ? (
        <Box marginLeft={2}>
          <Text dimColor>preview execution: {summary.preview_execution_id}</Text>
        </Box>
      ) : null}
      {summary.usage ? <UsageBlock usage={summary.usage} /> : null}
    </Box>
  );
};

const ConnectorSummaryCard: React.FC<{ summary: ConnectorSummary }> = ({ summary }) => {
  const probeLine = summary.probe
    ? `probe: ${summary.probe.ok ? "ok" : "FAILED"}${
        typeof summary.probe.status_code === "number"
          ? ` · status=${summary.probe.status_code}`
          : ""
      }${typeof summary.probe.duration_ms === "number" ? ` · ${summary.probe.duration_ms}ms` : ""}`
    : null;
  return (
    <Box flexDirection="column" marginBottom={1}>
      <Box>
        <Text color="green" bold>
          {"✓ "}
        </Text>
        <Text
          bold
        >{`Created connector "${summary.slug}" · id=${summary.id} · template=${summary.template_slug}`}</Text>
      </Box>
      {probeLine ? (
        <Box marginLeft={2}>
          <Text dimColor>{probeLine}</Text>
        </Box>
      ) : null}
      {summary.usage ? <UsageBlock usage={summary.usage} /> : null}
    </Box>
  );
};

const KnowledgeSourceSummaryCard: React.FC<{ summary: KnowledgeSourceSummary }> = ({ summary }) => {
  return (
    <Box flexDirection="column" marginBottom={1}>
      <Box>
        <Text color="green" bold>
          {"✓ "}
        </Text>
        <Text bold>{`Created knowledge source "${summary.name}" · id=${summary.id}`}</Text>
      </Box>
      <Box marginLeft={2}>
        <Text dimColor>
          {summary.mime_type} · {humanBytes(summary.size_bytes)}
          {summary.file_id ? ` · file=${summary.file_id}` : ""}
        </Text>
      </Box>
      {summary.link_failed ? (
        <Box marginLeft={2}>
          <Text color="yellow">warning: file link did not persist (best-effort)</Text>
        </Box>
      ) : null}
      {summary.usage ? <UsageBlock usage={summary.usage} /> : null}
    </Box>
  );
};

export const SummaryCard: React.FC<{ summary: AnySummary }> = ({ summary }) => {
  if (isWorkflowSummary(summary)) return <WorkflowSummaryCard summary={summary} />;
  if (isKnowledgeSourceSummary(summary)) return <KnowledgeSourceSummaryCard summary={summary} />;
  if (isConnectorSummary(summary)) return <ConnectorSummaryCard summary={summary} />;
  return null;
};
