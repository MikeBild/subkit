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
  { key: "2", label: "Create a connector", detail: "guided setup" },
  { key: "3", label: "Build a workflow", detail: "guided authoring" },
  { key: "4", label: "Inspect tenant state", detail: "workflows · connectors · runs" },
  { key: "5", label: "API / MCP / chat help", detail: "surface guidance" },
] as const;

export function starterActionsForPersona(persona: string): readonly StarterAction[] {
  const label = persona.trim().toLowerCase();
  if (label === "portal" || label === "enduser") {
    return [
      DEFAULT_STARTER_ACTIONS[0]!,
      DEFAULT_STARTER_ACTIONS[1]!,
      DEFAULT_STARTER_ACTIONS[2]!,
      { key: "4", label: "Check accessible work", detail: "status · workflows · runs" },
      { key: "5", label: "API / MCP / chat help", detail: "surface guidance" },
    ] as const;
  }
  return DEFAULT_STARTER_ACTIONS;
}

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
