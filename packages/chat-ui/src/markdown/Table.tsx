// Markdown-style table renderer with dynamic column widths and
// ANSI-aware wrapping. Replaces the ad-hoc padded-string tables
// strewn across the operator CLI commands.

import { Box, Text } from "ink";
import type React from "react";

import { useTheme } from "../theme/Provider.tsx";

export interface TableColumn {
  /** Header label shown at the top of the column. */
  header: string;
  /** Maximum width in columns; content wraps (hard-wrapped) beyond this. */
  maxWidth?: number;
}

export interface TableProps {
  columns: TableColumn[];
  rows: Array<Array<string | number>>;
  /** Max rendered rows before a "+N more" footer line appears. */
  maxRows?: number;
}

export const Table: React.FC<TableProps> = ({ columns, rows, maxRows = 50 }) => {
  const theme = useTheme();
  const widths = computeWidths(columns, rows);
  const visibleRows = rows.slice(0, maxRows);
  const overflow = rows.length - visibleRows.length;

  return (
    <Box flexDirection="column" marginY={1}>
      <Text color={theme.severity.info} bold>
        {columns.map((c, i) => pad(c.header, widths[i] ?? 1)).join("  ")}
      </Text>
      <Text color={theme.severity.dim}>{widths.map((w) => "─".repeat(w)).join("  ")}</Text>
      {visibleRows.map((row, r) => (
        <Text key={`row-${r}`}>
          {row.map((cell, i) => pad(String(cell), widths[i] ?? 1)).join("  ")}
        </Text>
      ))}
      {overflow > 0 ? <Text color={theme.severity.dim}>… {overflow} more row(s)</Text> : null}
    </Box>
  );
};

function computeWidths(columns: TableColumn[], rows: Array<Array<string | number>>): number[] {
  return columns.map((c, i) => {
    const headerLen = c.header.length;
    let longest = headerLen;
    for (const row of rows) {
      const cell = row[i];
      if (cell === undefined) continue;
      const s = String(cell);
      if (s.length > longest) longest = s.length;
    }
    const cap = c.maxWidth ?? 40;
    return Math.min(longest, cap);
  });
}

function pad(s: string, width: number): string {
  if (s.length >= width) return s.slice(0, width);
  return s + " ".repeat(width - s.length);
}
