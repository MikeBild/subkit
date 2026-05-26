import { basename } from "node:path";
import { Box, Text } from "ink";
import type React from "react";
import { PlanCard, type PlanStep } from "../repl/plan-cell.tsx";
import {
  isConnectorIntent,
  isKnowledgeSourceIntent,
  isWorkflowIntent,
  triggerLine,
} from "./helpers.ts";
import type { ConnectorIntent, KnowledgeSourceIntent, WorkflowIntent } from "./types.ts";

export type AnyIntent = WorkflowIntent | ConnectorIntent | KnowledgeSourceIntent;

export function humanBytes(n: number): string {
  if (!Number.isFinite(n) || n < 0) return `${n}B`;
  const units = ["B", "KB", "MB", "GB", "TB"];
  let i = 0;
  let v = n;
  while (v >= 1024 && i < units.length - 1) {
    v /= 1024;
    i++;
  }
  const s = v >= 10 || i === 0 || Number.isInteger(v) ? v.toFixed(0) : v.toFixed(1);
  return `${s}${units[i]}`;
}

const WorkflowIntentCard: React.FC<{ intent: WorkflowIntent }> = ({ intent }) => {
  const steps: PlanStep[] = intent.steps.map((s) => ({
    id: s.key,
    label: s.connector_slug ? `${s.key} · ${s.kind} → ${s.connector_slug}` : `${s.key} · ${s.kind}`,
    status: "pending",
  }));
  const heading = intent.slug ? `${intent.name} (${intent.slug})` : intent.name;
  return (
    <Box flexDirection="column" marginBottom={1}>
      <Box>
        <Text color="cyan" bold>
          {"● "}
        </Text>
        <Text bold>{`Create workflow ${heading}`}</Text>
      </Box>
      <Box marginLeft={2}>
        <Text dimColor>trigger: {triggerLine(intent.trigger)}</Text>
      </Box>
      {steps.length > 0 ? <PlanCard steps={steps} /> : null}
    </Box>
  );
};

const ConnectorIntentCard: React.FC<{ intent: ConnectorIntent }> = ({ intent }) => {
  const heading = intent.name ? `${intent.name} (${intent.template_slug})` : intent.template_slug;
  return (
    <Box flexDirection="column" marginBottom={1}>
      <Box>
        <Text color="cyan" bold>
          {"● "}
        </Text>
        <Text bold>{`Create connector ${heading}`}</Text>
      </Box>
      <Box marginLeft={2}>
        <Text dimColor>Template: {intent.template_slug}</Text>
      </Box>
      {intent.environment ? (
        <Box marginLeft={2}>
          <Text dimColor>Environment: {intent.environment}</Text>
        </Box>
      ) : null}
      {intent.auth_type ? (
        <Box marginLeft={2}>
          <Text dimColor>Auth: {intent.auth_type}</Text>
        </Box>
      ) : null}
      {intent.base_url ? (
        <Box marginLeft={2}>
          <Text dimColor>Base URL: {intent.base_url}</Text>
        </Box>
      ) : null}
    </Box>
  );
};

const KnowledgeSourceIntentCard: React.FC<{ intent: KnowledgeSourceIntent }> = ({ intent }) => {
  return (
    <Box flexDirection="column" marginBottom={1}>
      <Box>
        <Text color="cyan" bold>
          {"● "}
        </Text>
        <Text bold>{`Create knowledge source ${intent.title}`}</Text>
      </Box>
      <Box marginLeft={2}>
        <Text dimColor>File: {basename(intent.file_path)}</Text>
      </Box>
      <Box marginLeft={2}>
        <Text dimColor>Size: {humanBytes(intent.size_bytes)}</Text>
      </Box>
      <Box marginLeft={2}>
        <Text dimColor>MIME: {intent.mime_type}</Text>
      </Box>
    </Box>
  );
};

export const IntentCard: React.FC<{ intent: AnyIntent }> = ({ intent }) => {
  if (isWorkflowIntent(intent)) return <WorkflowIntentCard intent={intent} />;
  if (isKnowledgeSourceIntent(intent)) return <KnowledgeSourceIntentCard intent={intent} />;
  if (isConnectorIntent(intent)) return <ConnectorIntentCard intent={intent} />;
  return null;
};
