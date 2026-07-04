// Single-body modal shell — used by `/skills`, `/knowledge`,
// `/permissions`, `/admin`. The shell owns the title strip, the
// tenant tag, and the outer Esc-to-close behavior. The body is
// supplied via a render prop that receives `setInnerEscape` so a
// body with a transient filter / sub-panel can claim Esc temporarily
// (the shell suppresses its own dismiss while inner is active).

import { Box, Text, useInput } from "ink";
import type React from "react";
import { useState } from "react";

export interface SinglePaneRenderProps {
  /** Tab bodies call this with their transient inner state. While
   *  `true`, the shell suppresses Esc so the body's own handler can
   *  clear the inner state first. */
  setInnerEscape: (active: boolean) => void;
}

export interface SinglePaneProps {
  /** Title rendered in the shell header. Convention: `"sk <surface>"` */
  title: string;
  /** Optional tenant chip shown next to the title. */
  tenant?: string | null;
  /** Esc dismisses the pane. Wired by the host (ink-app.tsx). */
  onDismiss: () => void;
  /** Subtitle shown under the title. Default: `Esc closes`. */
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
