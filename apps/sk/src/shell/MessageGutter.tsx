import { useTheme } from "@chat-ui/index.ts";
import { Box, Text } from "ink";
import { createContext, useContext } from "react";

const NestedContext = createContext<boolean>(false);

export type GutterTone = "default" | "active" | "assistant" | "user" | "tool";

export interface MessageGutterProps {
  prefix?: string;
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
