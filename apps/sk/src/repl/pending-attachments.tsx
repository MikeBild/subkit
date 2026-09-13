import { basename } from "node:path";

import { Box, Text } from "ink";
import type React from "react";
import { memo } from "react";

import type { StoredPaste } from "./paste-store.ts";

function formatBytes(bytes: number | undefined): string | null {
  if (bytes === undefined || !Number.isFinite(bytes)) return null;
  if (bytes < 1024) return `${bytes} B`;
  if (bytes < 1024 * 1024) return `${(bytes / 1024).toFixed(1)} KB`;
  return `${(bytes / (1024 * 1024)).toFixed(1)} MB`;
}

function summarizeText(text: string, max = 42): string {
  const squashed = text.replace(/\s+/g, " ").trim();
  if (squashed.length <= max) return squashed;
  return `${squashed.slice(0, Math.max(1, max - 1)).trimEnd()}…`;
}

function describeItem(item: StoredPaste): string {
  if (item.kind === "text") {
    const lineCount = Math.max(1, item.text.split(/\r\n|\r|\n/).length);
    return `${lineCount} line${lineCount === 1 ? "" : "s"} · ${summarizeText(item.text)}`;
  }
  if (item.kind === "image") {
    const size = formatBytes(item.bytes);
    return [basename(item.path), item.mediaType, size].filter(Boolean).join(" · ");
  }
  const size = formatBytes(item.bytes);
  return [item.filename, size].filter(Boolean).join(" · ");
}

interface PendingPasteRefsProps {
  items: readonly StoredPaste[];
}

const PendingPasteRefsImpl: React.FC<PendingPasteRefsProps> = ({ items }) => {
  if (items.length === 0) return null;
  return (
    <Box flexDirection="column" marginBottom={1}>
      <Text dimColor>
        paste refs · {items.length} pending · remove: /paste remove {"<id>"} · clear: /paste clear
      </Text>
      {items.map((item) => (
        <Box key={item.id}>
          <Text bold>[{item.id}] </Text>
          <Text>{item.kind}</Text>
          <Text dimColor> · {describeItem(item)}</Text>
        </Box>
      ))}
    </Box>
  );
};

export const PendingPasteRefs = memo(PendingPasteRefsImpl);
