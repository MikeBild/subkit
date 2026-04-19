import { Box, Text } from "ink";
import type React from "react";
import { memo } from "react";

export interface StarterAction {
  key: string;
  label: string;
  detail: string;
}

export const DEFAULT_STARTER_ACTIONS: readonly StarterAction[] = [
  { key: "1", label: "Resume recent conversation", detail: "opens /resume" },
  { key: "2", label: "Connect a system", detail: "guided connector setup prompt" },
  { key: "3", label: "Describe a workflow", detail: "guided workflow authoring prompt" },
  { key: "4", label: "Import docs or a spec", detail: "guided docs-first prompt" },
  { key: "5", label: "Open help", detail: "shows slash commands" },
] as const;

interface StarterActionsProps {
  actions?: readonly StarterAction[];
}

const StarterActionsImpl: React.FC<StarterActionsProps> = ({
  actions = DEFAULT_STARTER_ACTIONS,
}) => {
  return (
    <Box flexDirection="column" marginBottom={1}>
      <Text dimColor>quick start</Text>
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
