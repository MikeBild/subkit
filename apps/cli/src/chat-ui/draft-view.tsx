// Side panel showing the current workflow draft as JSON.

import { Box, Text } from "ink";
import type React from "react";

export function DraftView({ draft }: { draft: unknown }): React.ReactElement {
  const pretty = draft === null || draft === undefined ? "(empty draft)" : safeStringify(draft);
  return (
    <Box flexDirection="column" borderStyle="round" paddingX={1}>
      <Text color="magenta">draft</Text>
      <Text>{pretty}</Text>
    </Box>
  );
}

function safeStringify(v: unknown): string {
  try {
    return JSON.stringify(v, null, 2);
  } catch {
    return String(v);
  }
}
