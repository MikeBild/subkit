// Parallel-step spinner tree — renders workflow execution steps as a
// tree with box-drawing connectors. Each step reports a verb
// ("running", "waiting", "done", "failed") and optional token /
// duration metadata. Mirrors Claude Code's `TeammateSpinnerTree`.

import { Box, Text } from "ink";
import type React from "react";
import { useTheme } from "../theme/Provider.tsx";

export type StepStatus = "running" | "waiting" | "done" | "failed" | "stalled";

export interface StepNode {
  id: string;
  label: string;
  status: StepStatus;
  verb?: string;
  tokens?: number;
  durationMs?: number;
}

export interface StepTreeProps {
  title: string;
  steps: StepNode[];
}

const STATUS_GLYPH: Record<StepStatus, string> = {
  running: "⣾",
  waiting: "⏳",
  done: "✓",
  failed: "×",
  stalled: "…",
};

export const StepTree: React.FC<StepTreeProps> = ({ title, steps }) => {
  const theme = useTheme();
  return (
    <Box flexDirection="column" marginY={1}>
      <Text bold>┌─ {title}</Text>
      {steps.map((s, i) => {
        const isLast = i === steps.length - 1;
        const connector = isLast ? "└─" : "├─";
        const color =
          s.status === "done"
            ? theme.emphasis.added
            : s.status === "failed"
              ? theme.severity.error
              : s.status === "stalled"
                ? theme.severity.dim
                : theme.severity.info;
        const tail = [
          s.verb,
          s.tokens !== undefined ? `${formatTokens(s.tokens)} tk` : null,
          s.durationMs !== undefined ? `${Math.round(s.durationMs / 100) / 10}s` : null,
        ]
          .filter((v): v is string => Boolean(v))
          .join(" · ");
        return (
          <Text key={s.id} color={color}>
            {connector} {STATUS_GLYPH[s.status]} {s.label}
            {tail ? <Text color={theme.severity.dim}> — {tail}</Text> : null}
          </Text>
        );
      })}
    </Box>
  );
};

function formatTokens(n: number): string {
  if (n < 1000) return String(n);
  if (n < 1_000_000) return `${(n / 1000).toFixed(1)}k`;
  return `${(n / 1_000_000).toFixed(1)}M`;
}
