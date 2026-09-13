// Structured diff renderer — takes a before/after JSON payload
// (as emitted by `askUser.confirm { kind: save_workflow_draft }`) and
// renders a hunk-style diff: + lines green, − lines red, unchanged
// lines dim, with a path header.
//
// The input shape is flexible:
//   { before: unknown, after: unknown }              — generic JSON diff
//   { name, slug, description, steps, ... }           — a workflow draft
// For workflow drafts we render the common fields as a structured
// summary plus a JSON diff of `steps`.

import { Box, Text } from "ink";
import type React from "react";

import { useTheme } from "../theme/Provider.tsx";

export interface StructuredDiffProps {
  /** Structured before/after payload. Either `{before, after}` or a flat draft. */
  diff: unknown;
  /** Optional header label (e.g., workflow slug, file path). */
  header?: string;
  /** Max lines shown before the body truncates with an ellipsis. */
  maxLines?: number;
}

export const StructuredDiff: React.FC<StructuredDiffProps> = ({ diff, header, maxLines = 60 }) => {
  const theme = useTheme();
  const lines = renderDiffLines(diff, maxLines);

  return (
    <Box flexDirection="column" marginY={1}>
      {header ? (
        <Text color={theme.severity.info} bold>
          {header}
        </Text>
      ) : null}
      {lines.map((line, i) => {
        const color =
          line.kind === "added"
            ? theme.emphasis.added
            : line.kind === "removed"
              ? theme.emphasis.removed
              : line.kind === "header"
                ? theme.severity.info
                : theme.severity.dim;
        const prefix = line.kind === "added" ? "+ " : line.kind === "removed" ? "- " : "  ";
        return (
          <Text key={`diff-${i}`} color={color}>
            {prefix}
            {line.text}
          </Text>
        );
      })}
    </Box>
  );
};

interface DiffLine {
  kind: "added" | "removed" | "context" | "header";
  text: string;
}

function renderDiffLines(diff: unknown, maxLines: number): DiffLine[] {
  const lines: DiffLine[] = [];
  const beforeAfter = asBeforeAfter(diff);
  if (beforeAfter) {
    const { before, after } = beforeAfter;
    const b = jsonLines(before);
    const a = jsonLines(after);
    lines.push({ kind: "header", text: `@@ ${b.length} ‑› ${a.length} lines @@` });
    lines.push(...computeHunks(b, a));
  } else {
    // Treat as an after-only snapshot — render each field as an added
    // line so the user still sees the shape.
    lines.push({ kind: "header", text: "new draft" });
    for (const line of jsonLines(diff)) {
      lines.push({ kind: "added", text: line });
    }
  }
  if (lines.length > maxLines) {
    const truncated = lines.slice(0, maxLines);
    truncated.push({
      kind: "context",
      text: `… ${lines.length - maxLines} more lines (press Ctrl+E to expand)`,
    });
    return truncated;
  }
  return lines;
}

function asBeforeAfter(diff: unknown): { before: unknown; after: unknown } | null {
  if (
    diff &&
    typeof diff === "object" &&
    !Array.isArray(diff) &&
    "before" in diff &&
    "after" in diff
  ) {
    const d = diff as { before: unknown; after: unknown };
    return { before: d.before, after: d.after };
  }
  return null;
}

function jsonLines(value: unknown): string[] {
  if (value === undefined || value === null) return ["null"];
  try {
    return JSON.stringify(value, null, 2).split("\n");
  } catch {
    return [String(value)];
  }
}

/**
 * Longest-common-subsequence hunk renderer. Small enough to inline
 * here — we expect diffs in the dozens of lines at most
 * (workflow-draft size). For bigger payloads the caller should pass
 * a pre-truncated `diff`.
 */
function computeHunks(before: string[], after: string[]): DiffLine[] {
  const n = before.length;
  const m = after.length;
  const lcs: number[][] = Array.from({ length: n + 1 }, () => Array(m + 1).fill(0));
  for (let i = n - 1; i >= 0; i--) {
    for (let j = m - 1; j >= 0; j--) {
      const b = before[i];
      const a = after[j];
      if (b !== undefined && a !== undefined && b === a) {
        lcs[i]![j] = (lcs[i + 1]![j + 1] ?? 0) + 1;
      } else {
        lcs[i]![j] = Math.max(lcs[i + 1]![j] ?? 0, lcs[i]![j + 1] ?? 0);
      }
    }
  }
  const out: DiffLine[] = [];
  let i = 0;
  let j = 0;
  while (i < n && j < m) {
    if (before[i] === after[j]) {
      out.push({ kind: "context", text: before[i] ?? "" });
      i++;
      j++;
    } else if ((lcs[i + 1]![j] ?? 0) >= (lcs[i]![j + 1] ?? 0)) {
      out.push({ kind: "removed", text: before[i] ?? "" });
      i++;
    } else {
      out.push({ kind: "added", text: after[j] ?? "" });
      j++;
    }
  }
  while (i < n) out.push({ kind: "removed", text: before[i++] ?? "" });
  while (j < m) out.push({ kind: "added", text: after[j++] ?? "" });
  return out;
}
