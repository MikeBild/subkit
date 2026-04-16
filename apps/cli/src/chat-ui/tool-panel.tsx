// Tool-call panel: renders name, args, and a live status marker.

import { Box, Text } from "ink";
import type React from "react";
import type { ToolCallState } from "./hooks.ts";

const STATUS_COLOR: Record<ToolCallState["status"], string> = {
  pending: "gray",
  running: "yellow",
  done: "green",
  failed: "red",
};

export function ToolPanel({ call }: { call: ToolCallState }): React.ReactElement {
  const color = STATUS_COLOR[call.status];
  return (
    <Box flexDirection="column" borderStyle="round" paddingX={1}>
      <Box>
        <Text color="cyan">tool </Text>
        <Text bold>{call.name}</Text>
        <Text> </Text>
        <Text color={color}>[{call.status}]</Text>
      </Box>
      <Box>
        <Text color="gray">args: </Text>
        <Text>{safeStringify(call.args)}</Text>
      </Box>
      {call.error ? <Text color="red">error: {call.error}</Text> : null}
      {call.result !== undefined && call.status === "done" ? (
        <Text color="green">result: {safeStringify(call.result)}</Text>
      ) : null}
    </Box>
  );
}

function safeStringify(v: unknown): string {
  try {
    return JSON.stringify(v);
  } catch {
    return String(v);
  }
}
