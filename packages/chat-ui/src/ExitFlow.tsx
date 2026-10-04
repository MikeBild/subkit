import { Box, Text, useInput } from "ink";
import type React from "react";
import { useState } from "react";
import { useTheme } from "./theme/Provider.tsx";

export interface ExitFlowProps {
  onExit: () => void;
  armWindowMs?: number;
  showBanner?: boolean;
}

export const ExitFlow: React.FC<ExitFlowProps> = ({
  onExit,
  armWindowMs = 1500,
  showBanner = true,
}) => {
  const theme = useTheme();
  const [armed, setArmed] = useState(false);
  useInput((ch, key) => {
    if (key.ctrl && ch === "d") {
      onExit();
      return;
    }
    if (key.ctrl && ch === "c") {
      if (armed) {
        onExit();
        return;
      }
      setArmed(true);
      setTimeout(() => setArmed(false), armWindowMs);
    }
  });
  if (!showBanner || !armed) return null;
  return (
    <Box marginTop={1}>
      <Text color={theme.severity.warning} bold>
        press Ctrl-C again to exit
      </Text>
    </Box>
  );
};
