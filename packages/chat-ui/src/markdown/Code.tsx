// Syntax-highlighted code block. Reuses `cli-highlight` (already a
// dep) for the language families the LLM emits (yaml, json,
// typescript, sql, bash). Unknown languages fall through to dim
// plain text. Line-number gutter shown only when caller asks for it.

import { highlight } from "cli-highlight";
import { Box, Text } from "ink";
import type React from "react";

import { useTheme } from "../theme/Provider.tsx";

export interface CodeProps {
  code: string;
  language?: string;
  /** When true, prepend 1-indexed line numbers. */
  showLineNumbers?: boolean;
  /** When false, suppress the surrounding ```fence markers. */
  showFence?: boolean;
}

const SUPPORTED = new Set([
  "yaml",
  "yml",
  "json",
  "js",
  "javascript",
  "ts",
  "typescript",
  "tsx",
  "bash",
  "shell",
  "sh",
  "sql",
  "python",
  "py",
]);

export const Code: React.FC<CodeProps> = ({
  code,
  language,
  showLineNumbers,
  showFence = true,
}) => {
  const theme = useTheme();
  const lang = language?.toLowerCase();
  let rendered = code;
  if (lang && SUPPORTED.has(lang)) {
    try {
      rendered = highlight(code, { language: lang, ignoreIllegals: true });
    } catch {
      // cli-highlight throws on some edge cases; fall back to raw.
    }
  }
  const lines = rendered.split("\n");
  const gutterWidth = String(lines.length).length;

  return (
    <Box flexDirection="column" marginY={1}>
      {language && showFence ? <Text color={theme.severity.dim}>```{language}</Text> : null}
      {lines.map((line, i) => (
        <Text key={`code-${i}`}>
          {showLineNumbers ? (
            <Text color={theme.severity.dim}>{String(i + 1).padStart(gutterWidth, " ")} │ </Text>
          ) : null}
          {line}
        </Text>
      ))}
      {language && showFence ? <Text color={theme.severity.dim}>```</Text> : null}
    </Box>
  );
};
