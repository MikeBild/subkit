// external_write approval body — renders the target endpoint
// (URL + method) and the outgoing payload so the operator can
// confirm before the engine hits a third-party service.

import { Box, Text } from "ink";
import type React from "react";

interface Target {
  url?: string;
  method?: string;
  workflow_id?: string;
  path?: string;
}

function isTarget(v: unknown): v is Target {
  return typeof v === "object" && v !== null;
}

function truncate(value: unknown, maxBytes = 400): string {
  let s: string;
  try {
    s = typeof value === "string" ? value : JSON.stringify(value, null, 2);
  } catch {
    s = String(value);
  }
  return s.length > maxBytes ? `${s.slice(0, maxBytes)}\n… (truncated)` : s;
}

export interface ExternalWriteApprovalProps {
  target: unknown;
  diff: unknown;
}

export const ExternalWriteApproval: React.FC<ExternalWriteApprovalProps> = ({ target, diff }) => {
  const tgt = isTarget(target) ? target : null;
  return (
    <Box flexDirection="column" marginTop={1} marginBottom={1}>
      {tgt ? (
        <Box flexDirection="column">
          <Text>
            <Text dimColor>target:</Text>{" "}
            <Text bold color="magenta">
              {tgt.method ?? "POST"} {tgt.url ?? tgt.path ?? "(unknown)"}
            </Text>
          </Text>
          {tgt.workflow_id ? <Text dimColor>workflow: {tgt.workflow_id.slice(0, 8)}</Text> : null}
        </Box>
      ) : (
        <Text dimColor>(target not provided)</Text>
      )}
      {diff !== null && diff !== undefined ? (
        <Box flexDirection="column" marginTop={1}>
          <Text dimColor>payload:</Text>
          <Text>{truncate(diff)}</Text>
        </Box>
      ) : null}
    </Box>
  );
};
