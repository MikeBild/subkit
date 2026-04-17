// File preview — renders a block with line numbers + path header.
// Used by tool results shaped like `{ path, lines: [{n, text}] }`
// (connector-docs / knowledge excerpts) so excerpted content is
// immediately recognizable as coming from a file.

import { Box, Text } from "ink";
import type React from "react";
import { useTheme } from "../theme/Provider.tsx";

export interface FilePreviewLine {
  n: number;
  text: string;
}

export interface FilePreviewProps {
  path: string;
  lines: FilePreviewLine[];
  /** Optional header after the path (e.g., "3 matches"). */
  meta?: string;
}

export const FilePreview: React.FC<FilePreviewProps> = ({ path, lines, meta }) => {
  const theme = useTheme();
  const gutterWidth = Math.max(
    1,
    String(lines.length > 0 ? (lines[lines.length - 1]?.n ?? 1) : 1).length,
  );

  return (
    <Box flexDirection="column" marginY={1}>
      <Text color={theme.severity.info} bold>
        {path}
        {meta ? <Text color={theme.severity.dim}> — {meta}</Text> : null}
      </Text>
      {lines.map((l, i) => (
        <Text key={`file-${i}`}>
          <Text color={theme.severity.dim}>{String(l.n).padStart(gutterWidth, " ")} │ </Text>
          {l.text}
        </Text>
      ))}
    </Box>
  );
};
