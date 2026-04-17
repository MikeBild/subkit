// Welcome banner — the first thing a user sees in `sk`. Claude-Code-style:
// no box border, a sparkle + bold title, a dimmed subtitle, and a
// three-line context block (persona · tenant · engine), all
// theme-token colored so the host can swap palettes without editing
// this file. The rotating tip gets a muted tip glyph and sits under
// the context block.
//
// The banner is memoized — React re-renders it only when one of its
// pure props changes.

import { useTheme } from "@chat-ui/index.ts";
import { VERSION } from "@cli-core/version.ts";
import { Box, Text } from "ink";
import type React from "react";
import { memo } from "react";

export interface WelcomeBannerProps {
  persona: string;
  tenant: string | null;
  engineUrl: string;
  profileName?: string;
  /** One-line tip shown under the context block. Rotate these in the caller. */
  tip?: string;
}

const WelcomeBannerImpl: React.FC<WelcomeBannerProps> = ({
  persona,
  tenant,
  engineUrl,
  profileName,
  tip,
}) => {
  const theme = useTheme();
  return (
    <Box flexDirection="column" marginBottom={1}>
      {/* Title row — sparkle + bold "sk" + version + tagline. */}
      <Box>
        <Text color={theme.role.assistant} bold>
          ✻ sk
        </Text>
        <Text color={theme.severity.dim}> · v{VERSION} · subkit conversation CLI</Text>
      </Box>

      {/* Session context — aligned ▸ rows, easier to scan than inline. */}
      <Box flexDirection="column" marginTop={1}>
        <Box>
          <Text color={theme.severity.dim}>▸ </Text>
          <Text>persona </Text>
          <Text color={theme.role.user} bold>
            {persona}
          </Text>
          {profileName ? (
            <>
              <Text color={theme.severity.dim}> · profile </Text>
              <Text color={theme.role.assistant}>{profileName}</Text>
            </>
          ) : null}
        </Box>
        <Box>
          <Text color={theme.severity.dim}>▸ </Text>
          <Text>tenant </Text>
          <Text bold>{tenant ?? "(none)"}</Text>
        </Box>
        <Box>
          <Text color={theme.severity.dim}>▸ </Text>
          <Text>engine </Text>
          <Text color={theme.severity.dim}>{engineUrl}</Text>
        </Box>
      </Box>

      {/* Tip row (rotates). */}
      {tip ? (
        <Box marginTop={1}>
          <Text color={theme.severity.warning}>◦ </Text>
          <Text color={theme.severity.dim}>{tip}</Text>
        </Box>
      ) : null}

      {/* Quick-hint footer — single line of colored keys. */}
      <Box marginTop={1}>
        <Text color={theme.severity.dim}>type a prompt · </Text>
        <Text color={theme.role.assistant}>/help</Text>
        <Text color={theme.severity.dim}> · </Text>
        <Text color={theme.role.assistant}>@</Text>
        <Text color={theme.severity.dim}>file · </Text>
        <Text color={theme.role.assistant}>↑/↓</Text>
        <Text color={theme.severity.dim}> history · </Text>
        <Text color={theme.role.assistant}>Ctrl-C</Text>
        <Text color={theme.severity.dim}> cancel · </Text>
        <Text color={theme.role.assistant}>/exit</Text>
      </Box>
    </Box>
  );
};

export const WelcomeBanner = memo(WelcomeBannerImpl);

/**
 * Rotating tip strings — one is picked at random per session so the
 * banner stays fresh without nagging. Extend freely.
 */
export const BANNER_TIPS: readonly string[] = [
  "press Ctrl-T for full-screen transcript, Ctrl-T again to exit",
  "type `@path/to/file` to inline a file, `@workflow:<slug>` to fetch a workflow",
  "drop a `SUBKIT.md` in cwd and sk will inject it as memory on every turn",
  'run `sk -p "your prompt"` for headless / script-friendly output',
  "customize the status line via `statusLine.command` in ~/.sk/settings.json",
  "`/compact` collapses old history so sk stays responsive on long sessions",
  "`/approve` or `/reject` resolves the current elicitation inline",
] as const;

export function pickTip(seed: number = Date.now()): string {
  const idx = Math.abs(Math.floor(seed)) % BANNER_TIPS.length;
  return BANNER_TIPS[idx] ?? BANNER_TIPS[0] ?? "";
}
