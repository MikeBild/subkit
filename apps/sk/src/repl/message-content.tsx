import { Code, Table } from "@chat-ui/index.ts";
import { parseRenderableMessageContent, type RenderableMessagePart } from "@cli-core/index.ts";
import { Box, Text } from "ink";
import type React from "react";
import { memo, useMemo } from "react";

export interface MessageContentProps {
  content: string;
  parts?: RenderableMessagePart[] | undefined;
  /**
   * Available width for the body, in columns. Equals
   * `terminal_columns - indent` where the indent is the row's leading
   * glyph + speaker-label gutter (2 + 6 = 8 cols today). Pre-fix the
   * Text wrapped at full terminal width regardless of the speaker
   * indent — continuation lines lost the indent and words split
   * mid-glyph (session 86de186b: "transf\norm)" + "wrapper,\n" at
   * col 0). Passing an explicit width keeps wrap inside the body
   * column.
   */
  width?: number;
}

function normalizeInlineMarkdown(text: string): string {
  return text
    .replace(/^#{1,6}\s+/gm, "")
    .replace(/^\s*[-*]\s+\[x\]\s+/gim, "✓ ")
    .replace(/^\s*[-*]\s+\[\s\]\s+/gim, "○ ")
    .replace(/^\s*[-*]\s+/gm, "• ")
    .replace(/\*\*(.*?)\*\*/g, "$1")
    .replace(/__(.*?)__/g, "$1")
    .replace(/`([^`]+)`/g, "$1")
    .replace(/\n{3,}/g, "\n\n");
}

const MessageContentImpl: React.FC<MessageContentProps> = ({ content, parts, width }) => {
  const resolved = useMemo(() => {
    if (parts && parts.length > 0) return parts;
    return parseRenderableMessageContent(content).parts;
  }, [content, parts]);

  // When a width is provided we constrain the box so Ink's text
  // layout wraps WITHIN this column instead of using the full
  // terminal width. Without this constraint Ink wraps at the
  // terminal edge AND continuation lines render at col 0, breaking
  // the speaker-indent the row layout established. Width is clamped
  // to a sane minimum so a tiny terminal still gets readable lines.
  const boxWidth = typeof width === "number" && width > 16 ? width : undefined;

  if (resolved.length === 0) {
    return (
      <Box width={boxWidth}>
        <Text wrap="wrap">{normalizeInlineMarkdown(content)}</Text>
      </Box>
    );
  }

  return (
    <Box flexDirection="column" width={boxWidth}>
      {resolved.map((part, index) => {
        if (part.type === "code_block") {
          return (
            <Code
              key={`part-${index}`}
              code={part.code}
              {...(part.language ? { language: part.language } : {})}
              showFence={false}
            />
          );
        }
        if (part.type === "table") {
          return (
            <Table
              key={`part-${index}`}
              columns={part.headers.map((header) => ({ header, maxWidth: 32 }))}
              rows={part.rows}
            />
          );
        }
        return (
          <Text key={`part-${index}`} wrap="wrap">
            {normalizeInlineMarkdown(part.text)}
          </Text>
        );
      })}
    </Box>
  );
};

export const MessageContent = memo(MessageContentImpl);
