import { Box, Text } from "ink";
import type React from "react";
import { PlanCard } from "../repl/plan-cell.tsx";
import { SEPARATOR } from "./helpers.ts";
import type { PlanStep } from "./types.ts";

export const TaskList: React.FC<{ phases: ReadonlyArray<PlanStep> }> = ({ phases }) => {
  return (
    <Box flexDirection="column" marginBottom={1}>
      <Box>
        <Text color="gray">{SEPARATOR}</Text>
      </Box>
      <PlanCard steps={phases} />
    </Box>
  );
};
