import { Code, Table } from "@chat-ui/index.ts";
import { parseRenderableMessageContent, type RenderableMessagePart } from "@cli-core/index.ts";
import { Box, Text } from "ink";
import type React from "react";
import { memo, useMemo } from "react";

export interface MessageContentProps {
  content: string;
  parts?: RenderableMessagePart[] | undefined;
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

const MessageContentImpl: React.FC<MessageContentProps> = ({ content, parts }) => {
  const resolved = useMemo(() => {
    if (parts && parts.length > 0) return parts;
    return parseRenderableMessageContent(content).parts;
  }, [content, parts]);

  if (resolved.length === 0) {
    return <Text wrap="wrap">{normalizeInlineMarkdown(content)}</Text>;
  }

  return (
    <Box flexDirection="column">
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
