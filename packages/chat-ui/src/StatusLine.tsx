// Rich status line — tenant · model · connector · skills count ·
// mode badge · token usage. Reads directly from `SkSessionState` +
// an optional host-supplied `StatusLineContext` (tenant, model,
// connector, mode, skills count).

import type { SkSessionState } from "@cli-core/index.ts";
import { Box, Text } from "ink";
import type React from "react";
import { useTheme } from "./theme/Provider.tsx";

export type Mode = "ask" | "auto" | "plan";

export interface StatusLineContext {
  tenant?: string | null;
  model?: string | null;
  connector?: string | null;
  skillsCount?: number;
  mode?: Mode;
  cwd?: string;
  branch?: string;
}

export interface StatusLineProps {
  session: SkSessionState;
  context?: StatusLineContext;
}

export const StatusLine: React.FC<StatusLineProps> = ({ session, context }) => {
  const theme = useTheme();
  const usage = session.usage;
  const parts: React.ReactNode[] = [];

  if (context?.tenant) parts.push(<Text key="t">tenant={context.tenant}</Text>);
  if (context?.model) parts.push(<Text key="m">model={context.model}</Text>);
  if (context?.connector) parts.push(<Text key="c">connector={context.connector}</Text>);
  if (context?.skillsCount !== undefined)
    parts.push(<Text key="s">skills={context.skillsCount}</Text>);
  if (context?.branch) parts.push(<Text key="b">⎇ {context.branch}</Text>);

  if (context?.mode) {
    const modeColor =
      context.mode === "plan"
        ? theme.mode.plan
        : context.mode === "auto"
          ? theme.mode.auto
          : theme.mode.ask;
    parts.push(
      <Text key="mode" color={modeColor} bold>
        [{context.mode.toUpperCase()}]
      </Text>,
    );
  }

  if (usage) {
    const remaining = usage.remaining_monthly_budget_tokens;
    const remainingLabel = remaining === null ? "∞" : remaining.toLocaleString();
    parts.push(
      <Text key="u">
        tokens={usage.turn_tokens}/{remainingLabel}
      </Text>,
    );
  }

  parts.push(
    <Text key="status" color={theme.severity.dim}>
      status={session.status}
    </Text>,
  );

  return (
    <Box flexDirection="row" marginTop={1}>
      <Text color={theme.severity.dim}>
        {parts.map((p, i) => (
          <Text key={`st-${i}`}>
            {i > 0 ? " · " : ""}
            {p}
          </Text>
        ))}
      </Text>
    </Box>
  );
};
