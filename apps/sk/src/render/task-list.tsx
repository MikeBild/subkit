import { Box, Text } from "ink";
import type React from "react";
import { STATUS_COLOR, STATUS_GLYPH } from "../repl/plan-cell.tsx";
import type { Phase } from "./types.ts";

export const TaskList: React.FC<{ phases: ReadonlyArray<Phase> }> = ({ phases }) => {
  return (
    <Box flexDirection="column" marginBottom={1}>
      <Box>
        <Text color="gray">─────────────────────────────</Text>
      </Box>
      {phases.map((p, i) => {
        const glyph = STATUS_GLYPH[p.status];
        const color = STATUS_COLOR[p.status];
        const isDim = p.status === "skipped" || p.status === "succeeded" || p.status === "pending";
        return (
          <Box key={`phase-${i}`}>
            <Text
              color={color}
              dimColor={isDim}
              bold={p.status === "running" || p.status === "in_progress" || p.status === "failed"}
            >
              {glyph}
            </Text>
            <Text> {p.name}</Text>
            {p.detail ? (
              <Text color="gray" dimColor>
                {" · "}
                {p.detail}
              </Text>
            ) : null}
          </Box>
        );
      })}
    </Box>
  );
};
