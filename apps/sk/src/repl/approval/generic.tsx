// Generic approval body — last-resort renderer for `kind: "other"`
// or any unknown approval shape. Prints the target (if any) and
// a pretty-printed JSON dump of the diff so the operator has
// something to audit before approving.

import { Box, Text } from "ink";
import type React from "react";

function truncate(value: unknown, maxBytes = 600): string {
  let s: string;
  try {
    s = typeof value === "string" ? value : JSON.stringify(value, null, 2);
  } catch {
    s = String(value);
  }
  return s.length > maxBytes ? `${s.slice(0, maxBytes)}\n… (truncated)` : s;
}

export interface GenericApprovalProps {
  diff: unknown;
  target: unknown;
}

export const GenericApproval: React.FC<GenericApprovalProps> = ({ diff, target }) => {
  const hasDiff = diff !== null && diff !== undefined;
  const hasTarget = target !== null && target !== undefined;
  if (!hasDiff && !hasTarget) {
    return (
      <Box marginTop={1}>
        <Text dimColor>(no additional payload)</Text>
      </Box>
    );
  }
  return (
    <Box flexDirection="column" marginTop={1} marginBottom={1}>
      {hasTarget ? (
        <Box flexDirection="column">
          <Text dimColor>target:</Text>
          <Text>{truncate(target)}</Text>
        </Box>
      ) : null}
      {hasDiff ? (
        <Box flexDirection="column" marginTop={hasTarget ? 1 : 0}>
          <Text dimColor>diff:</Text>
          <Text>{truncate(diff)}</Text>
        </Box>
      ) : null}
    </Box>
  );
};
