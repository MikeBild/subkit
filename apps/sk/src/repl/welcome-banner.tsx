// ASCII welcome banner — the first thing a user sees when they run
// `sk` interactively. Inspired by Claude Code's LogoV2/WelcomeV2
// component: a themed unicode-block logo + a version line + a tiny
// hint about the slash-command surface.
//
// The banner is a pure function of (version, persona, tenant,
// engineUrl) so it can be memoized by the React tree. React's own
// reconciliation avoids re-rendering it on every keystroke as long
// as the parent passes stable props.

import { Box, Text } from "ink";
import type React from "react";
import { memo } from "react";

const VERSION = "0.0.1";

export interface WelcomeBannerProps {
  persona: string;
  tenant: string | null;
  engineUrl: string;
  profileName?: string;
  /** One-line tip shown under the version. Rotate these in the caller. */
  tip?: string;
}

/**
 * Compact boxed banner. Avoids a heavy ASCII logo so the terminal
 * feels immediately chat-ready. Uses Unicode box drawing so it
 * renders crisply in every terminal theme without bespoke theme
 * detection. Centered title + two info lines + an optional tip.
 */
const WelcomeBannerImpl: React.FC<WelcomeBannerProps> = ({
  persona,
  tenant,
  engineUrl,
  profileName,
  tip,
}) => {
  return (
    <Box
      flexDirection="column"
      borderStyle="round"
      borderColor="cyan"
      paddingX={1}
      marginBottom={1}
    >
      <Box>
        <Text bold color="cyanBright">
          ✻ sk
        </Text>
        <Text dimColor> v{VERSION} — end-user CLI for subkit-backend</Text>
      </Box>
      <Box>
        <Text>
          <Text dimColor>signed in as </Text>
          <Text bold color="green">
            {persona}
          </Text>
          <Text dimColor> on </Text>
          <Text bold>{tenant ?? "(no tenant)"}</Text>
          {profileName ? (
            <>
              <Text dimColor> · </Text>
              <Text color="cyan">{profileName}</Text>
            </>
          ) : null}
          <Text dimColor> · </Text>
          <Text>{engineUrl}</Text>
        </Text>
      </Box>
      {tip ? (
        <Box>
          <Text color="yellow">💡 </Text>
          <Text dimColor>{tip}</Text>
        </Box>
      ) : null}
      <Box>
        <Text dimColor>type a prompt · </Text>
        <Text color="cyan">/help</Text>
        <Text dimColor> for commands · </Text>
        <Text color="cyan">↑/↓</Text>
        <Text dimColor> for history · </Text>
        <Text color="cyan">/exit</Text>
        <Text dimColor> to leave</Text>
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
  "press Ctrl-T to open the full-screen transcript, Ctrl-T again to exit",
  "type `@path/to/file` to inline a file, `@workflow:<slug>` to fetch a workflow",
  "drop a `SUBKIT.md` in cwd and sk will inject it as memory on every turn",
  'run `sk -p "your prompt"` for headless / script-friendly output',
  "customize the status line via `statusLine.command` in ~/.sk/settings.json",
  "`/compact` collapses old history so sk keeps responding quickly on long sessions",
] as const;

export function pickTip(seed: number = Date.now()): string {
  const idx = Math.abs(Math.floor(seed)) % BANNER_TIPS.length;
  return BANNER_TIPS[idx] ?? BANNER_TIPS[0] ?? "";
}
