import { Box, Text } from "ink";
import type React from "react";
import { memo } from "react";
import type { PersonaProbe } from "../slash.ts";
import { starterTaskActionsForPersona, TASK_ACTIONS, type TaskAction } from "./task-actions.ts";

export interface StarterAction {
  key: string;
  label: string;
  detail: string;
  actionId?: string | undefined;
}

function starterActionFromTask(action: TaskAction): StarterAction {
  return {
    key: action.key ?? "",
    label: action.label,
    detail: action.detail,
    actionId: action.id,
  };
}

export const DEFAULT_STARTER_ACTIONS: readonly StarterAction[] = [
  "resume-recent",
  "create-connector",
  "build-workflow",
  "inspect-tenant",
  "surface-help",
]
  .map((id) => TASK_ACTIONS.find((action) => action.id === id))
  .filter((action): action is TaskAction => Boolean(action))
  .map(starterActionFromTask);

export function starterActionsForPersona(
  persona: string,
  probe?: PersonaProbe,
): readonly StarterAction[] {
  // Pass the probe through so the rendered list is RBAC-filtered the same way
  // the dispatch list is — render and dispatch must show the same entries.
  return starterTaskActionsForPersona(persona, probe).map(starterActionFromTask);
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
