// Inline Approve/Reject prompt rendered when the conversation loop is
// blocked on an approval request. Captures Y/Enter to approve or N to
// reject; ESC is treated as a reject as well so the user can always
// escape the prompt without a stack trace.

import { Box, Text, useInput } from "ink";
import type React from "react";

export interface ApprovalPromptProps {
  title: string;
  diff: string;
  approvalId: string;
  onDecide: (decision: "approved" | "rejected") => void;
  /** Disable input handling — used by tests that drive keys manually. */
  inputDisabled?: boolean | undefined;
}

export function ApprovalPrompt({
  title,
  diff,
  approvalId,
  onDecide,
  inputDisabled,
}: ApprovalPromptProps): React.ReactElement {
  useInput(
    (input, key) => {
      if (key.return || input === "y" || input === "Y") {
        onDecide("approved");
        return;
      }
      if (input === "n" || input === "N" || key.escape) {
        onDecide("rejected");
      }
    },
    { isActive: !inputDisabled },
  );

  return (
    <Box borderStyle="double" paddingX={1} flexDirection="column">
      <Text color="yellow">approval needed: {title}</Text>
      <Text color="gray">id: {approvalId}</Text>
      <Text>{diff}</Text>
      <Box marginTop={1}>
        <Text color="green">[Enter/Y] Approve</Text>
        <Text> · </Text>
        <Text color="red">[N] Reject</Text>
      </Box>
    </Box>
  );
}
