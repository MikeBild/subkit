import { useTheme } from "@chat-ui/index.ts";
import { Box, Text } from "ink";
import type React from "react";
import { memo } from "react";

export type NoticeTone = "info" | "success" | "warning" | "error";

export interface NoticeItem {
  id: string;
  tone: NoticeTone;
  message: string;
  persistent?: boolean | undefined;
}

const NOTICE_META: Record<NoticeTone, { glyph: string; label: string }> = {
  info: { glyph: "i", label: "info" },
  success: { glyph: "✓", label: "success" },
  warning: { glyph: "!", label: "warning" },
  error: { glyph: "×", label: "error" },
};

function toneColor(tone: NoticeTone, theme: ReturnType<typeof useTheme>): string {
  switch (tone) {
    case "success":
      return theme.emphasis.added;
    case "warning":
      return theme.severity.warning;
    case "error":
      return theme.severity.error;
    default:
      return theme.severity.info;
  }
}

const NoticeStackImpl: React.FC<{ items: NoticeItem[] }> = ({ items }) => {
  const theme = useTheme();
  if (items.length === 0) return null;
  return (
    <Box flexDirection="column" marginBottom={1}>
      {items.map((item, index) => {
        const meta = NOTICE_META[item.tone];
        const color = toneColor(item.tone, theme);
        const showDismiss = item.persistent && index === 0;
        return (
          <Box
            key={item.id}
            flexDirection="column"
            borderStyle="round"
            borderColor={color}
            paddingX={1}
            marginBottom={1}
          >
            <Box>
              <Text color={color} bold>
                {meta.glyph}
              </Text>
              <Text> </Text>
              <Text color={color} bold>
                {meta.label}
              </Text>
            </Box>
            <Text>{item.message}</Text>
            {showDismiss ? <Text color={theme.severity.dim}>Esc to dismiss</Text> : null}
          </Box>
        );
      })}
    </Box>
  );
};

export const NoticeStack = memo(NoticeStackImpl);
