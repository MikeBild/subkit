import { Box, Text, useInput } from "ink";
import type React from "react";
import { useState } from "react";

export interface SinglePaneRenderProps {
  setInnerEscape: (active: boolean) => void;
}

export interface SinglePaneProps {
  title: string;
  tenant?: string | null;
  onDismiss: () => void;
  subtitle?: string;
  children: (rp: SinglePaneRenderProps) => React.ReactNode;
}

export const SinglePane: React.FC<SinglePaneProps> = ({
  title,
  tenant,
  onDismiss,
  subtitle,
  children,
}) => {
  const [innerActive, setInnerActive] = useState(false);

  useInput((_input, key) => {
    if (key.escape) {
      if (innerActive) return;
      onDismiss();
    }
  });

  return (
    <Box flexDirection="column">
      <Box marginBottom={1}>
        <Text bold>{title}</Text>
        {tenant ? <Text color="yellow"> (tenant: {tenant})</Text> : null}
        <Text color="gray"> · {subtitle ?? "Esc closes"}</Text>
      </Box>
      <Box>{children({ setInnerEscape: setInnerActive })}</Box>
    </Box>
  );
};
