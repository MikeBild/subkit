// Welcome banner — first-paint orientation only. Keep it compact so the
// transcript can take over as soon as the user starts working.

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
  /** One-line tip shown under the hint row. Rotate via `pickTip`. */
  tip?: string;
}

const WelcomeBannerImpl: React.FC<WelcomeBannerProps> = ({ persona, tenant, tip }) => {
  const theme = useTheme();
  const personaSlot = tenant ? `${persona}@${tenant}` : persona;
  return (
    <Box
      flexDirection="column"
      borderStyle="round"
      borderColor={theme.severity.dim}
      paddingX={1}
      marginBottom={1}
    >
      <Box>
        <Text bold>sk</Text>
        <Text color={theme.severity.dim}> · v{VERSION}</Text>
        <Text color={theme.severity.dim}> · {personaSlot}</Text>
      </Box>
      <Text>
        Resume work, connect a system, build a workflow, inspect tenant state, or ask about API /
        MCP / chat.
      </Text>
      {tip ? (
        <Box marginTop={1}>
          <Text color={theme.severity.warning}>◦ </Text>
          <Text color={theme.severity.dim}>{tip}</Text>
        </Box>
      ) : null}
      <Box marginTop={1}>
        <Text color={theme.severity.dim}>type a request · </Text>
        <Text color={theme.role.assistant}>/help</Text>
        <Text color={theme.severity.dim}> · </Text>
        <Text color={theme.role.assistant}>/resume</Text>
        <Text color={theme.severity.dim}> · </Text>
        <Text color={theme.role.assistant}>/view inspect</Text>
        <Text color={theme.severity.dim}> · </Text>
        <Text color={theme.role.assistant}>Ctrl-O</Text>
        <Text color={theme.severity.dim}> inspect</Text>
      </Box>
    </Box>
  );
};

export const WelcomeBanner = memo(WelcomeBannerImpl);

export const BANNER_TIPS: readonly string[] = [
  "Use /resume to reopen a prior session without replaying the full transcript.",
  "`@path/to/file` inlines a file; `@workflow:<slug>` fetches a committed workflow.",
  "Drop a `SUBKIT.md` next to your project and sk injects it as memory each turn.",
  'Run `sk -p "your prompt"` for headless output in scripts or CI.',
  "Use /permissions when you need the fastest grounded view of your current access.",
  "Use /status for tenant state before asking the assistant to summarize what exists.",
  "Use /view inspect when you need the raw tool trace behind the chat view.",
  "Shift-Tab cycles ask / auto / plan; the footer always shows the active mode.",
  "`/approve` or `/reject` resolves the current confirmation request inline.",
  "Use /compact when a long conversation needs a smaller working context.",
  "Ask about MCP, the HTTP API, or chat adapters in plain language; the assistant should ground on real Subkit surfaces.",
  "If the engine errors repeatedly, turn on `SK_DEBUG=1` or use `/debug on`.",
] as const;

export function pickTip(seed: number = Date.now()): string {
  const idx = Math.abs(Math.floor(seed)) % BANNER_TIPS.length;
  return BANNER_TIPS[idx] ?? BANNER_TIPS[0] ?? "";
}
