// Rich /status pane — shows every useful field in one modal.
//
// Composes with `<Pane>` for the frame. Data comes in as an array of
// [label, value | null] tuples so the host can splice in whatever
// is known at render time (engine-side snapshot + local session
// state). Null / undefined / empty values render as "—" so the
// layout stays aligned regardless of what's populated.

import { Box, Text } from "ink";
import type React from "react";
import { Pane } from "./Pane.tsx";
import { useTheme } from "./theme/Provider.tsx";

export type StatusPaneRow = readonly [string, string | number | null | undefined];

export interface StatusPaneProps {
  title?: string;
  subtitle?: string;
  rows: readonly StatusPaneRow[];
  onDismiss?: () => void;
  inputDisabled?: boolean;
}

export const StatusPane: React.FC<StatusPaneProps> = ({
  title = "status",
  subtitle,
  rows,
  onDismiss,
  inputDisabled,
}) => {
  const theme = useTheme();
  const labelWidth = rows.reduce((w, [label]) => Math.max(w, label.length), 0);
  return (
    <Pane
      title={title}
      {...(subtitle !== undefined ? { subtitle } : {})}
      {...(onDismiss ? { onDismiss } : {})}
      {...(inputDisabled !== undefined ? { inputDisabled } : {})}
    >
      {rows.map(([label, value]) => {
        const shown = value === null || value === undefined || value === "" ? "—" : String(value);
        return (
          <Box key={`sp-${label}`}>
            <Text color={theme.severity.dim}>{label.padEnd(labelWidth + 2, " ")}</Text>
            <Text>{shown}</Text>
          </Box>
        );
      })}
    </Pane>
  );
};
