// sk block-mark mascot — the first thing a user sees in the REPL: a 3-row
// glyph on the left with a meta panel (name + version, model, cwd) on the
// right.
//
// Rendering notes:
//   - Glyph uses `theme.role.assistant` so it picks up the host palette.
//   - Apple Terminal does NOT render vertical whitespace between block
//     characters consistently, so we fall back to a background-fill row.
//   - Keep the column spacing inside the glyph strings (two spaces after
//     each row) so the right-side meta panel aligns flush across rows.

import { useTheme } from "@chat-ui/index.ts";
import { Box, Text } from "ink";
import type React from "react";
import { memo } from "react";

const STANDARD_ROWS = ["▛▀▘▐▘ ", "▜▄  ▐▖", "      "] as const;

// Apple Terminal renders adjacent block glyphs with gaps; we swap to a
// solid-background row so the mascot stays readable on Terminal.app.
const APPLE_ROWS = ["▛▀▘▐▘ ", "▜▄  ▐▖", "▘▘ ▝▝ "] as const;

export interface LogoProps {
  /** Forces the Apple-Terminal fallback path — tests pass `true`. */
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

/** Exposed so tests can assert on the raw glyph rows. */
export const LOGO_ROWS = STANDARD_ROWS;
export const LOGO_ROWS_APPLE = APPLE_ROWS;
