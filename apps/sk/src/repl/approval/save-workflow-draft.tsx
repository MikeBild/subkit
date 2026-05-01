// save_workflow_draft approval body — renders a structured view of the
// draft workflow about to be committed. The `diff` payload
// conventionally carries a `{name, slug, description, steps[]}`
// shape matching WorkflowDef; we surface the name + the step
// count + a short summary per step so the operator can eyeball
// what's about to land before approving.

import { Box, Text } from "ink";
import type React from "react";

interface Step {
  id?: string;
  kind?: string;
  name?: string;
  connector_id?: string;
  path?: string;
  expression?: string;
}

interface DraftDoc {
  name?: string;
  slug?: string;
  description?: string;
  steps?: Step[];
}

function isDraft(v: unknown): v is DraftDoc {
  return typeof v === "object" && v !== null;
}

function summarizeStep(step: Step, idx: number): string {
  const kind = step.kind ?? "?";
  const id = step.id ?? `step-${idx + 1}`;
  const extras: string[] = [];
  if (step.connector_id) extras.push(`connector=${step.connector_id.slice(0, 8)}`);
  if (step.path) extras.push(`path=${step.path}`);
  if (step.expression) extras.push(`expr=${step.expression.slice(0, 40)}`);
  const tail = extras.length > 0 ? ` (${extras.join(", ")})` : "";
  return `${idx + 1}. ${id} [${kind}]${tail}`;
}

export interface CommitDraftApprovalProps {
  diff: unknown;
}

export const CommitDraftApproval: React.FC<CommitDraftApprovalProps> = ({ diff }) => {
  if (!isDraft(diff)) {
    return (
      <Box flexDirection="column" marginTop={1}>
        <Text dimColor>(no draft payload — engine did not attach a diff)</Text>
      </Box>
    );
  }
  const steps = Array.isArray(diff.steps) ? diff.steps : [];
  return (
    <Box flexDirection="column" marginTop={1} marginBottom={1}>
      <Text>
        <Text dimColor>workflow:</Text> <Text bold>{diff.name ?? diff.slug ?? "(unnamed)"}</Text>
      </Text>
      {diff.description ? <Text dimColor>{diff.description}</Text> : null}
      <Text>
        <Text dimColor>steps:</Text> <Text bold>{steps.length}</Text>
      </Text>
      {steps.slice(0, 6).map((step, idx) => (
        <Text key={`step-${idx}`}>{`  ${summarizeStep(step, idx)}`}</Text>
      ))}
      {steps.length > 6 ? <Text dimColor> … {steps.length - 6} more</Text> : null}
    </Box>
  );
};
