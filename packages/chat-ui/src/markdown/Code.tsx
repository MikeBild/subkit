import { highlight } from "cli-highlight";
import { Box, Text } from "ink";
import type React from "react";
import { useTheme } from "../theme/Provider.tsx";

export interface CodeProps {
  code: string;
  language?: string;
  showLineNumbers?: boolean;
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
    } catch {}
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
