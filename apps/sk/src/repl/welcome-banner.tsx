// Welcome banner — the first thing a user sees in `sk`. Adopts the
// Claude-Code layout: a block-glyph mascot on the left, a meta panel on
// the right (sk · version / persona@tenant / engine / cwd), a rotating
// tip row, and a single-line quick-hint footer. Everything is plain
// Ink — no external dependencies — and all colors flow through the
// theme tokens so the host can swap palettes without editing this file.

import { useTheme } from "@chat-ui/index.ts";
import { VERSION } from "@cli-core/version.ts";
import { Box, Text } from "ink";
import type React from "react";
import { memo } from "react";
import { Logo } from "./logo.tsx";

export interface WelcomeBannerProps {
  persona: string;
  tenant: string | null;
  engineUrl: string;
  profileName?: string;
  /** One-line tip shown under the hint row. Rotate via `pickTip`. */
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
  const personaSlot = tenant ? `${persona}@${tenant}` : persona;
  return (
    <Box flexDirection="column" marginBottom={1}>
      {/* Mascot + meta panel — two-column layout. Subkit-native fields
          only: persona@tenant, engine, profile. No cwd / model — sk is
          a workflow-authoring CLI, not an IDE agent. */}
      <Box flexDirection="row">
        <Logo />
        <Box flexDirection="column" marginLeft={2}>
          <Box>
            <Text bold>sk </Text>
            <Text color={theme.severity.dim}>· v{VERSION}</Text>
            <Text color={theme.severity.dim}> · subkit conversation CLI</Text>
          </Box>
          <Box>
            <Text color={theme.severity.dim}>persona </Text>
            <Text color={theme.role.user} bold>
              {personaSlot}
            </Text>
          </Box>
          <Box>
            <Text color={theme.severity.dim}>engine </Text>
            <Text color={theme.severity.dim}>{engineUrl}</Text>
          </Box>
          {profileName ? (
            <Box>
              <Text color={theme.severity.dim}>profile </Text>
              <Text color={theme.role.assistant}>{profileName}</Text>
            </Box>
          ) : null}
        </Box>
      </Box>

      {/* Tip row (rotates). */}
      {tip ? (
        <Box marginTop={1}>
          <Text color={theme.severity.warning}>◦ </Text>
          <Text color={theme.severity.dim}>{tip}</Text>
        </Box>
      ) : null}

      {/* Quick-hint footer — colored keys, shown once on first paint. */}
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
  "`@path/to/file` inlines a file; `@workflow:<slug>` fetches a committed workflow from the engine",
  "drop a `SUBKIT.md` next to your project and sk injects it as memory every turn",
  'run `sk -p "your prompt"` for headless / script-friendly output',
  "customize the status line via `statusLine.command` in ~/.sk/settings.json",
  "`/compact` trims the running turn context so long conversations stay within token budget",
  "`/approve` or `/reject` resolves the current elicitation inline",
  "Shift-Tab cycles ask / auto-approve / plan — watch the footer for the active mode",
  "`/resume` browses past conversations; `/status` shows tenant connectors and token usage",
  "stuck on `sk: HTTP 500 internal_error`? run with `SK_DEBUG=1` (or `/debug on`) to log requests to ~/.sk/debug.log",
] as const;

export function pickTip(seed: number = Date.now()): string {
  const idx = Math.abs(Math.floor(seed)) % BANNER_TIPS.length;
  return BANNER_TIPS[idx] ?? BANNER_TIPS[0] ?? "";
}
