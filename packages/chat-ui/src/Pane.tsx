import { Box, Text, useInput } from "ink";
import type React from "react";
import { useTheme } from "./theme/Provider.tsx";

export interface PaneProps {
  title: string;
  subtitle?: string;
  footer?: string;
  onDismiss?: () => void;
  inputDisabled?: boolean;
  children: React.ReactNode;
}

export const Pane: React.FC<PaneProps> = ({
  title,
  subtitle,
  footer,
  onDismiss,
  inputDisabled,
  children,
}) => {
  const theme = useTheme();
  useInput(
    (_ch, key) => {
      if (key.escape) onDismiss?.();
    },
    { isActive: !inputDisabled },
  );
  return (
    <Box
      flexDirection="column"
      borderStyle="round"
      borderColor={theme.severity.dim}
      paddingX={1}
      marginTop={1}
    >
      <Box>
        <Text color={theme.role.assistant} bold>
          {title}
        </Text>
        {subtitle ? <Text color={theme.severity.dim}> · {subtitle}</Text> : null}
      </Box>
      <Box marginTop={1} flexDirection="column">
        {children}
      </Box>
      <Box marginTop={1}>
        <Text color={theme.severity.dim}>{footer ?? "Esc to close"}</Text>
      </Box>
    </Box>
  );
};
