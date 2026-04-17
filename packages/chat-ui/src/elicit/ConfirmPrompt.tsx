// askUser.confirm prompt — unified replacement for the legacy
// `ApprovalPrompt` / `ApprovalRouter` pair. Digit keybinds (1
// Approve / 3 Reject), arrow+Enter fallback, Tab reveals a
// textarea for a `decision_reason`. The `kind` input picks the
// sub-body (commit-draft diff, external-write target, generic).
//
// `destructive: true` flips the default selection to Reject and
// colors the title red.

import { TextInput } from "@inkjs/ui";
import { Box, Text, useInput } from "ink";
import type React from "react";
import { useState } from "react";
import { StructuredDiff } from "../diff/StructuredDiff.tsx";
import { useTheme } from "../theme/Provider.tsx";

export type ConfirmKind = "commit_draft" | "external_write" | "generic";

export interface ConfirmPromptProps {
  question: string;
  summary?: string | undefined;
  kind?: ConfirmKind | undefined;
  diff?: unknown;
  target?: unknown;
  destructive?: boolean | undefined;
  /** Pre-selected answer if the user just presses Enter. */
  defaultChoice?: "approve" | "reject" | undefined;
  onResponse: (value: { confirmed: boolean; decision_reason?: string }) => void;
  inputDisabled?: boolean | undefined;
}

export const ConfirmPrompt: React.FC<ConfirmPromptProps> = ({
  question,
  summary,
  kind = "generic",
  diff,
  target,
  destructive,
  defaultChoice,
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
        if (key.escape) setReasonOpen(false);
        return;
      }
      if (input === "1") submit(true);
      else if (input === "3") submit(false);
      else if (key.leftArrow) setFocused(0);
      else if (key.rightArrow) setFocused(1);
      else if (key.tab) setReasonOpen((v) => !v);
      else if (key.return) submit(focused === 0);
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
          <TextInput
            placeholder="why?"
            onChange={(v) => setReason(v)}
            onSubmit={(v) => {
              setReason(v);
              setReasonOpen(false);
            }}
          />
        </Box>
      ) : (
        <Text color={theme.severity.dim}>Tab for reason · Enter to submit</Text>
      )}
    </Box>
  );
};
