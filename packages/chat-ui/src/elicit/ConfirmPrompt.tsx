// askUser.confirm prompt — unified replacement for the legacy
// `ApprovalPrompt` / `ApprovalRouter` pair. Digit keybinds (1
// Approve / 3 Reject), arrow+Enter fallback, Tab reveals a
// reason text area for a `decision_reason`. The `kind` input picks
// the sub-body (commit-draft diff, external-write target, generic).
//
// `destructive: true` flips the default selection to Reject and
// colors the title red.
//
// All input flows through a single `useInput` owned by this
// component. When the reason panel is open, printable chars /
// Backspace route into `reason`; Tab closes the panel; Enter commits
// the reason and closes the panel (it does NOT submit the form — the
// user must then press 1, 3, or arrow+Enter to decide). This matches
// the claude-code single-owner pattern and avoids the bug where the
// embedded `@inkjs/ui` TextInput would swallow Tab and treat Enter as
// "submit the whole form".

import { Box, Text, useInput } from "ink";
import type React from "react";
import { useState } from "react";
import { StructuredDiff } from "../diff/StructuredDiff.tsx";
import { useTheme } from "../theme/Provider.tsx";
import { ControlledTextField } from "./ControlledTextField.tsx";

export type ConfirmKind = "save_workflow_draft" | "external_write" | "generic";

export interface ConfirmPromptProps {
  question: string;
  summary?: string | undefined;
  kind?: ConfirmKind | undefined;
  diff?: unknown;
  target?: unknown;
  destructive?: boolean | undefined;
  /** Pre-selected answer if the user just presses Enter. */
  defaultChoice?: "approve" | "reject" | undefined;
  riskLevel?: "low" | "medium" | "high" | "critical" | string | undefined;
  targetLabel?: string | undefined;
  reversible?: boolean | undefined;
  /**
   * Structured "what will happen" preview produced by the gated tool's
   * `buildPendingOutput` policy hook. When present, the prompt renders
   * each key/value as a labelled row (e.g. `target: wf-abc`,
   * `environment: prod`) so the user can see WHAT they're approving
   * without parsing raw JSON in `diff` / `target`.
   */
  pendingOutput?: Record<string, unknown> | undefined;
  onResponse: (value: { confirmed: boolean; decision_reason?: string }) => void;
  inputDisabled?: boolean | undefined;
}

function isPrintable(input: string, key: { ctrl: boolean; meta: boolean }): boolean {
  if (key.ctrl || key.meta) return false;
  if (input.length !== 1) return false;
  const code = input.charCodeAt(0);
  return code >= 0x20 && code !== 0x7f;
}

function describePendingValue(value: unknown): string {
  if (value === null || value === undefined) return "—";
  if (Array.isArray(value)) return `[${value.length}] ${value.slice(0, 3).join(", ")}`;
  if (typeof value === "object") {
    const obj = value as Record<string, unknown>;
    const keys = Object.keys(obj);
    return keys.length > 0 ? `{${keys.slice(0, 4).join(", ")}}` : "{}";
  }
  return String(value);
}

export const ConfirmPrompt: React.FC<ConfirmPromptProps> = ({
  question,
  summary,
  kind = "generic",
  diff,
  target,
  destructive,
  defaultChoice,
  riskLevel,
  targetLabel,
  reversible,
  pendingOutput,
  onResponse,
  inputDisabled,
}) => {
  const theme = useTheme();
  const initialFocus = destructive || defaultChoice === "reject" ? 1 : 0;
  const [focused, setFocused] = useState<0 | 1>(initialFocus);
  const [reasonOpen, setReasonOpen] = useState(false);
  const [reason, setReason] = useState("");

  const submit = (confirmed: boolean): void => {
    const out: { confirmed: boolean; decision_reason?: string } = { confirmed };
    const trimmed = reason.trim();
    if (trimmed) out.decision_reason = trimmed;
    onResponse(out);
  };

  useInput(
    (input, key) => {
      if (reasonOpen) {
        if (key.escape || key.tab) {
          setReasonOpen(false);
          return;
        }
        if (key.return) {
          // Commit the typed reason and close the panel — do NOT submit.
          setReasonOpen(false);
          return;
        }
        if (key.backspace || key.delete) {
          setReason((r) => r.slice(0, -1));
          return;
        }
        if (isPrintable(input, key)) {
          setReason((r) => r + input);
        }
        return;
      }

      // Number keys mirror the displayed labels (1=Approve, 3=Reject).
      // Letter shortcuts (`y`/`a` = approve, `n`/`r` = reject) match
      // the convention every CLI confirm uses; they are case-insensitive
      // so a paste-mode user with shift held doesn't lose the binding.
      // Arrow keys move focus, Enter submits the focused choice, Tab
      // opens the optional decision_reason input.
      const lower = input.toLowerCase();
      if (input === "1" || lower === "y" || lower === "a") submit(true);
      else if (input === "3" || lower === "n" || lower === "r") submit(false);
      else if (key.leftArrow) setFocused(0);
      else if (key.rightArrow) setFocused(1);
      else if (key.tab) setReasonOpen(true);
      else if (key.return) submit(focused === 0);
      else if (key.escape) submit(false);
    },
    { isActive: !inputDisabled },
  );

  const titleColor = destructive ? theme.emphasis.destructive : theme.severity.warning;
  const kindLabel = destructive ? `${kind} (DESTRUCTIVE)` : kind;

  return (
    <Box
      flexDirection="column"
      borderStyle="round"
      borderColor={titleColor}
      paddingX={1}
      marginY={1}
    >
      <Text color={titleColor} bold>
        confirm: {kindLabel}
      </Text>
      <Text bold>{question}</Text>
      {summary && summary.trim() !== question.trim() ? <Text>{summary}</Text> : null}
      {riskLevel || targetLabel || reversible !== undefined ? (
        <Box flexDirection="column" marginTop={1}>
          {riskLevel ? (
            <Text>
              <Text color={theme.severity.dim}>risk: </Text>
              {riskLevel}
            </Text>
          ) : null}
          {targetLabel ? (
            <Text>
              <Text color={theme.severity.dim}>target: </Text>
              {targetLabel}
            </Text>
          ) : null}
          {reversible !== undefined ? (
            <Text>
              <Text color={theme.severity.dim}>reversible: </Text>
              {reversible ? "yes" : "no"}
            </Text>
          ) : null}
        </Box>
      ) : null}
      {pendingOutput && Object.keys(pendingOutput).length > 0 ? (
        <Box flexDirection="column" marginTop={1}>
          {Object.entries(pendingOutput).map(([key, value]) => (
            <Text key={key}>
              <Text color={theme.severity.dim}>{key}: </Text>
              {describePendingValue(value)}
            </Text>
          ))}
        </Box>
      ) : null}
      {kind === "external_write" && target !== undefined ? (
        <Text>
          <Text color={theme.severity.dim}>target: </Text>
          {typeof target === "string" ? target : JSON.stringify(target)}
        </Text>
      ) : null}
      {diff !== undefined ? <StructuredDiff diff={diff} /> : null}
      <Box>
        <Text {...(focused === 0 ? { color: theme.role.user } : {})}>
          {focused === 0 ? "▶ " : "  "}1. Approve
        </Text>
        <Text> </Text>
        <Text {...(focused === 1 ? { color: theme.role.user } : {})}>
          {focused === 1 ? "▶ " : "  "}3. Reject
        </Text>
      </Box>
      {reasonOpen && !inputDisabled ? (
        <Box marginTop={1} flexDirection="column">
          <Text color={theme.severity.dim}>reason (optional):</Text>
          <ControlledTextField value={reason} focused={true} placeholder="why?" />
          <Text color={theme.severity.dim}>Enter to keep · Tab/Esc to close</Text>
        </Box>
      ) : (
        <Text color={theme.severity.dim}>
          y/Enter to approve · n/Esc to reject · ←→ to focus · Tab for reason
          {reason.trim() ? ` · reason: "${reason.trim()}"` : ""}
        </Text>
      )}
    </Box>
  );
};
