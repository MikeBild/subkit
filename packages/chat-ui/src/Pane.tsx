// Modal pane — hosts slash-command and interactive content (/status,
// /resume browser, /help, /compact summary, etc.) in a single
// reserved slot. Exactly one pane is active at a time.
//
// Pane is intentionally dumb: it renders a bordered box with a title,
// optional footer hints, and an Esc-to-dismiss keybinding. The host
// owns open/close state; Pane notifies through `onDismiss`.
//
// Mirrors the `<Pane>` pattern in Claude Code's design system without
// copying its internals. We keep things flat — no modal stacking, no
// slot context — because sk's interaction model never needs more than
// one modal at a time.

import { Box, Text, useInput } from "ink";
import type React from "react";
import { useTheme } from "./theme/Provider.tsx";

export interface PaneProps {
  title: string;
  /** Optional subtitle rendered dim below the title. */
  subtitle?: string;
  /** Optional footer hint — overrides the default "Esc to close". */
  footer?: string;
  /** Called when the user hits Esc. The host unmounts the pane. */
  onDismiss?: () => void;
  /** Disables Esc handling (e.g. while a child input is eating keys). */
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
