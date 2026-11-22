import { Code, renderTextWithLinks, Table } from "@chat-ui/index.ts";
import { parseRenderableMessageContent, type RenderableMessagePart } from "@cli-core/index.ts";
import { Box, Text } from "ink";
import type React from "react";
import { memo, useMemo } from "react";

export interface MessageContentProps {
  content: string;
  parts?: RenderableMessagePart[] | undefined;
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

function linkifyProse(text: string): string {
  return renderTextWithLinks(normalizeInlineMarkdown(text));
}

const MessageContentImpl: React.FC<MessageContentProps> = ({ content, parts, width }) => {
  const resolved = useMemo(() => {
    if (parts && parts.length > 0) return parts;
    return parseRenderableMessageContent(content).parts;
  }, [content, parts]);

  const boxWidth = typeof width === "number" && width > 16 ? width : undefined;

  if (resolved.length === 0) {
    return (
      <Box width={boxWidth}>
        <Text wrap="wrap">{linkifyProse(content)}</Text>
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
            {linkifyProse(part.text)}
          </Text>
        );
      })}
    </Box>
  );
};

export const MessageContent = memo(MessageContentImpl);
