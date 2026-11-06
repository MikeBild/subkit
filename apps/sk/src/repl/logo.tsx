import { useTheme } from "@chat-ui/index.ts";
import { Box, Text } from "ink";
import type React from "react";
import { memo } from "react";

const STANDARD_ROWS = ["▛▀▘▐▘ ", "▜▄  ▐▖", "      "] as const;

const APPLE_ROWS = ["▛▀▘▐▘ ", "▜▄  ▐▖", "▘▘ ▝▝ "] as const;

interface LogoProps {
  appleFallback?: boolean;
}

const LogoImpl: React.FC<LogoProps> = ({ appleFallback }) => {
  const theme = useTheme();
  const isApple =
    appleFallback ??
    (typeof process !== "undefined" && process.env?.TERM_PROGRAM === "Apple_Terminal");
  const rows = isApple ? APPLE_ROWS : STANDARD_ROWS;
  return (
    <Box flexDirection="column">
      {rows.map((row, i) => (
        <Text key={`logo-row-${i}`} color={theme.role.assistant} bold>
          {row}
        </Text>
      ))}
    </Box>
  );
};

export const Logo = memo(LogoImpl);

export const LOGO_ROWS = STANDARD_ROWS;
export const LOGO_ROWS_APPLE = APPLE_ROWS;
