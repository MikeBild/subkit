// Elicit router — dispatches on the `ask_user_*` tool family and
// renders a kind-specific component. Mounted by the host app when a
// `pendingElicitation` is present on the session state.
//
// The input payload shape is read permissively — each prompt
// component tolerates partially-shaped data and falls back to sane
// defaults.

import type { PendingElicitation } from "@cli-core/index.ts";
import { Box, Text } from "ink";
import type React from "react";
import { useTheme } from "../theme/Provider.tsx";
import { type ChoiceOption, ChoicePrompt } from "./ChoicePrompt.tsx";
import { type ConfirmKind, ConfirmPrompt } from "./ConfirmPrompt.tsx";
import { type FormField, FormPrompt } from "./FormPrompt.tsx";
import { MultiChoicePrompt } from "./MultiChoicePrompt.tsx";
import { PartialApprovalPrompt, type PartialDiffEntry } from "./PartialApprovalPrompt.tsx";
import { TextPrompt } from "./TextPrompt.tsx";

export type ElicitationResponse =
  | { value: string }
  | { values: string[] }
  | { text: string }
  | { values: Record<string, unknown> }
  | { confirmed: boolean; decision_reason?: string }
  | {
      // Partial-diff approval response (Bug TT). When `partial` is
      // true, the engine applies only the diffs at `approved_indices`;
      // when false, treat as a binary confirm/reject.
      confirmed: boolean;
      partial?: boolean;
      approved_indices?: number[];
      decision_reason?: string;
    };

export interface ElicitRouterProps {
  elicitation: PendingElicitation;
  onResponse: (out: ElicitationResponse) => void;
  inputDisabled?: boolean | undefined;
}

export const ElicitRouter: React.FC<ElicitRouterProps> = ({
  elicitation,
  onResponse,
  inputDisabled,
}) => {
  const theme = useTheme();
  const input = (
    elicitation.input && typeof elicitation.input === "object"
      ? (elicitation.input as Record<string, unknown>)
      : {}
  ) as Record<string, unknown>;
  const question = typeof input.question === "string" ? input.question : elicitation.summary || "?";

  switch (elicitation.tool_name) {
    case "ask_user_choice": {
      const options = Array.isArray(input.options) ? (input.options as ChoiceOption[]) : [];
      return (
        <ChoicePrompt
          question={question}
          options={options}
          onResponse={onResponse}
          inputDisabled={inputDisabled}
        />
      );
    }
    case "ask_user_multi": {
      const options = Array.isArray(input.options) ? (input.options as ChoiceOption[]) : [];
      const min = typeof input.min === "number" ? input.min : undefined;
      const max = typeof input.max === "number" ? input.max : undefined;
      return (
        <MultiChoicePrompt
          question={question}
          options={options}
          min={min}
          max={max}
          onResponse={onResponse}
          inputDisabled={inputDisabled}
        />
      );
    }
    case "ask_user_text": {
      const placeholder = typeof input.placeholder === "string" ? input.placeholder : undefined;
      const validationRegex =
        typeof input.validation_regex === "string" ? input.validation_regex : undefined;
      const multiline = typeof input.multiline === "boolean" ? input.multiline : undefined;
      return (
        <TextPrompt
          question={question}
          placeholder={placeholder}
          multiline={multiline}
          validationRegex={validationRegex}
          onResponse={onResponse}
          inputDisabled={inputDisabled}
        />
      );
    }
    case "ask_user_form": {
      const fields = Array.isArray(input.fields) ? (input.fields as FormField[]) : [];
      return (
        <FormPrompt
          question={question}
          fields={fields}
          onResponse={onResponse}
          inputDisabled={inputDisabled}
        />
      );
    }
    case "ask_user_confirm": {
      // Per-patch partial approval (Bug TT). When the gated tool
      // emitted a list of JSON-Patch ops with kind:"partial_diff_approval",
      // route to the per-row picker instead of the binary ConfirmPrompt
      // so the operator can accept some patches and reject others.
      if (input.kind === "partial_diff_approval" && Array.isArray(input.diffs)) {
        return (
          <PartialApprovalPrompt
            question={question}
            diffs={input.diffs as PartialDiffEntry[]}
            onResponse={onResponse}
            inputDisabled={inputDisabled}
          />
        );
      }
      const kind: ConfirmKind = isConfirmKind(input.kind) ? input.kind : "generic";
      const summary = typeof input.summary === "string" ? input.summary : elicitation.summary;
      const destructive = input.destructive === true;
      const riskLevel =
        typeof input.risk_level === "string"
          ? input.risk_level
          : typeof input.riskLevel === "string"
            ? input.riskLevel
            : undefined;
      const targetLabel =
        typeof input.target_label === "string"
          ? input.target_label
          : typeof input.targetLabel === "string"
            ? input.targetLabel
            : undefined;
      const reversible = typeof input.reversible === "boolean" ? input.reversible : undefined;
      const defaultChoice =
        input.default === "approve" || input.default === "reject" ? input.default : undefined;
      // pending_output may live either on the elicitation input
      // (when the gated tool emitted it directly) or on a sibling
      // field of the elicit_request event (when sdk-wrap derived it
      // from the policy). Prefer the input-level value because the
      // tool itself owns the canonical preview shape.
      const pendingOutput =
        input.pending_output && typeof input.pending_output === "object"
          ? (input.pending_output as Record<string, unknown>)
          : undefined;
      return (
        <ConfirmPrompt
          question={question}
          summary={summary}
          kind={kind}
          diff={input.diff}
          target={input.target}
          destructive={destructive}
          defaultChoice={defaultChoice}
          riskLevel={riskLevel}
          targetLabel={targetLabel}
          reversible={reversible}
          pendingOutput={pendingOutput}
          onResponse={onResponse}
          inputDisabled={inputDisabled}
        />
      );
    }
    default:
      return (
        <Box
          flexDirection="column"
          borderStyle="round"
          borderColor={theme.severity.warning}
          paddingX={1}
        >
          <Text color={theme.severity.warning} bold>
            unknown elicitation: {elicitation.tool_name}
          </Text>
          <Text>{elicitation.summary}</Text>
        </Box>
      );
  }
};

function isConfirmKind(v: unknown): v is ConfirmKind {
  return v === "save_workflow_draft" || v === "external_write" || v === "generic";
}
