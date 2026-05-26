import { Box, Text } from "ink";
import type React from "react";
import { humanBytes } from "./intent-card.tsx";
import type {
  ConnectorSummary,
  KnowledgeSourceSummary,
  WorkflowSummary,
  WorkflowTrigger,
} from "./types.ts";

export type AnySummary = WorkflowSummary | ConnectorSummary | KnowledgeSourceSummary;

function isWorkflowSummary(s: AnySummary): s is WorkflowSummary {
  return typeof (s as WorkflowSummary).version === "number";
}
function isKnowledgeSourceSummary(s: AnySummary): s is KnowledgeSourceSummary {
  return typeof (s as KnowledgeSourceSummary).mime_type === "string";
}
function isConnectorSummary(s: AnySummary): s is ConnectorSummary {
  return typeof (s as ConnectorSummary).template_slug === "string";
}

function triggerLine(trigger: WorkflowTrigger): string {
  if (trigger.kind === "schedule") return `schedule cron=${trigger.cron} tz=${trigger.tz}`;
  if (trigger.kind === "webhook") {
    const evs = trigger.events.length > 0 ? trigger.events.join(",") : "*";
    return `webhook source=${trigger.source} events=${evs}`;
  }
  return "request";
}

const NextBlock: React.FC<{ commands: string[] }> = ({ commands }) => (
  <Box flexDirection="column" marginTop={1}>
    <Text dimColor>Next:</Text>
    {commands.map((c, i) => (
      <Box key={`next-${i}`} marginLeft={2}>
        <Text dimColor>{c}</Text>
      </Box>
    ))}
  </Box>
);

const WorkflowSummaryCard: React.FC<{ summary: WorkflowSummary }> = ({ summary }) => {
  const nextCommands = [
    `sk workflows run ${summary.id}`,
    `sk workflows get ${summary.id}`,
    `sk workflows history ${summary.id}`,
  ];
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
      <NextBlock commands={nextCommands} />
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
  const nextCommands = [
    `sk connectors get ${summary.id}`,
    `sk connectors probe ${summary.id}`,
    `sk connectors docs-ingest ${summary.id} --url <docs-url>`,
  ];
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
      <NextBlock commands={nextCommands} />
    </Box>
  );
};

const KnowledgeSourceSummaryCard: React.FC<{ summary: KnowledgeSourceSummary }> = ({ summary }) => {
  const nextCommands = [
    `sk knowledge-sources get ${summary.id}`,
    `sk knowledge-sources search <query>`,
  ];
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
      <NextBlock commands={nextCommands} />
    </Box>
  );
};

export const SummaryCard: React.FC<{ summary: AnySummary }> = ({ summary }) => {
  if (isWorkflowSummary(summary)) return <WorkflowSummaryCard summary={summary} />;
  if (isKnowledgeSourceSummary(summary)) return <KnowledgeSourceSummaryCard summary={summary} />;
  if (isConnectorSummary(summary)) return <ConnectorSummaryCard summary={summary} />;
  return null;
};
