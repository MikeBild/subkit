import { Box, Text } from "ink";
import type React from "react";

import { PlanCard } from "../repl/plan-cell.tsx";
import { SEPARATOR } from "./helpers.ts";
import type { PlanStep } from "./types.ts";

// Wraps the shared `PlanCard` with the dashed separator the workflow
// `create` flow uses to delimit the pre-flight phases from the
// surrounding JSON / narration. `PlanCard` already owns the row
// rendering (status glyph + label + optional detail) so this stays a
// thin wrapper instead of a parallel renderer.
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
