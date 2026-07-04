// `⎿` continuation gutter wrapper.
//
// Used by the transcript and by tool-call cards to indent secondary
// content one or two columns under a parent header line. A nested
// `<MessageGutter>` is suppressed via context so we don't double-indent
// when components compose.

import { useTheme } from "@chat-ui/index.ts";
import { Box, Text } from "ink";
import { createContext, useContext } from "react";

const NestedContext = createContext<boolean>(false);

export type GutterTone = "default" | "active" | "assistant" | "user" | "tool";

export interface MessageGutterProps {
  /** Glyph rendered before the children. Defaults to `⎿`. */
  prefix?: string;
  /** Picks the color from `theme.gutter.*`. Defaults to "default". */
  tone?: GutterTone;
  children: React.ReactNode;
}

export function MessageGutter({
  prefix = "⎿",
  tone = "default",
  children,
}: MessageGutterProps): React.ReactElement {
  const tokens = useTheme();
  const isNested = useContext(NestedContext);
  if (isNested) {
    // Suppress nested gutters — caller already indented us.
    return <Box flexDirection="column">{children}</Box>;
  }
  const color = tokens.gutter[tone];
  return (
    <NestedContext.Provider value={true}>
      <Box flexDirection="row">
        <Text color={color}>{prefix} </Text>
        <Box flexDirection="column" flexGrow={1}>
          {children}
        </Box>
      </Box>
    </NestedContext.Provider>
  );
}
