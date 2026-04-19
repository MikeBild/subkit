import { Box, Text } from "ink";
import type React from "react";
import { memo } from "react";

export interface StarterAction {
  key: string;
  label: string;
  detail: string;
}

export const DEFAULT_STARTER_ACTIONS: readonly StarterAction[] = [
  { key: "1", label: "Resume recent", detail: "/resume" },
  { key: "2", label: "Connect a system", detail: "guided setup" },
  { key: "3", label: "Build a workflow", detail: "guided authoring" },
  { key: "4", label: "Import docs/spec", detail: "docs-first flow" },
  { key: "5", label: "Help", detail: "/help" },
] as const;

interface StarterActionsProps {
  actions?: readonly StarterAction[];
}

const StarterActionsImpl: React.FC<StarterActionsProps> = ({
  actions = DEFAULT_STARTER_ACTIONS,
}) => {
  return (
    <Box flexDirection="column" marginBottom={1}>
      <Text dimColor>start with</Text>
      {actions.map((action) => (
        <Box key={action.key}>
          <Text bold>{action.key}. </Text>
          <Text>{action.label}</Text>
          <Text dimColor> · {action.detail}</Text>
        </Box>
      ))}
    </Box>
  );
};

export const StarterActions = memo(StarterActionsImpl);
