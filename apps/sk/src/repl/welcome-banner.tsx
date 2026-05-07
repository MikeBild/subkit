// Welcome banner — first-paint orientation only. Keep it compact so the
// transcript can take over as soon as the user starts working.

import { useTheme } from "@chat-ui/index.ts";
import { VERSION } from "@cli-core/version.ts";
import { Box, Text } from "ink";
import type React from "react";
import { memo } from "react";
import type { PermissionMode } from "../repl/status-line/render.ts";

export interface WelcomeBannerProps {
  persona: string;
  tenant: string | null;
  engineUrl: string;
  profileName?: string;
  sessionId?: string | null;
  mode?: PermissionMode | undefined;
  transcriptMode?: "chat" | "inspect" | undefined;
  connectionState?: "online" | "reconnecting" | "offline" | "unknown" | undefined;
  connectionReason?: string | null | undefined;
  targetKind?: "connector" | "workflow" | "none" | null | undefined;
  targetName?: string | null | undefined;
  environment?: string | null | undefined;
  compact?: boolean | undefined;
  /** One-line tip shown under the hint row. Rotate via `pickTip`. */
  tip?: string;
}

function engineHost(url: string): string {
  try {
    const u = new URL(url);
    return u.port ? `${u.hostname}:${u.port}` : u.hostname;
  } catch {
    return url;
  }
}

const WelcomeBannerImpl: React.FC<WelcomeBannerProps> = ({
  persona,
  tenant,
  engineUrl,
  profileName,
  sessionId,
  mode = "ask",
  transcriptMode = "chat",
  connectionState = "unknown",
  connectionReason = null,
  targetKind = null,
  targetName = null,
  environment = null,
  compact = false,
  tip,
}) => {
  const theme = useTheme();
  const personaSlot = tenant ? `${persona}@${tenant}` : persona;
  const host = engineHost(engineUrl);
  const sessionLabel = sessionId ? sessionId.slice(0, 8) : "new";
  const modeColor = theme.mode[mode];
  const nextView = transcriptMode === "chat" ? "inspect" : "chat";
  const connectionLabel =
    connectionState === "offline"
      ? connectionReason
        ? `offline · ${connectionReason}`
        : "offline"
      : connectionState === "reconnecting"
        ? "reconnecting"
        : "online";
  const targetLabel =
    targetKind && targetKind !== "none"
      ? `${targetKind}${targetName ? ` "${targetName}"` : ""}${environment ? ` · ${environment}` : ""}`
      : null;
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
        {profileName ? <Text color={theme.severity.dim}> · profile {profileName}</Text> : null}
      </Box>
      <Box>
        <Text color={theme.role.user} bold>
          {personaSlot}
        </Text>
        <Text color={theme.severity.dim}> · </Text>
        <Text color={theme.severity.dim}>{host}</Text>
        <Text color={theme.severity.dim}> · session </Text>
        <Text color={theme.role.assistant}>{sessionLabel}</Text>
      </Box>
      <Box>
        <Text color={modeColor} bold>
          {mode}
        </Text>
        <Text color={theme.severity.dim}> · {transcriptMode}</Text>
        <Text color={theme.severity.dim}> · {connectionLabel}</Text>
        {targetLabel ? <Text color={theme.severity.dim}> · {targetLabel}</Text> : null}
      </Box>
      {!compact ? (
        <Text>
          Resume work, create a connector, build a workflow, inspect tenant state, or ask about API
          / MCP / chat.
        </Text>
      ) : null}
      {tip ? (
        <Box marginTop={1}>
          <Text color={theme.severity.warning}>◦ </Text>
          <Text color={theme.severity.dim}>{tip}</Text>
        </Box>
      ) : null}
      {!compact ? (
        <Box marginTop={1}>
          <Text color={theme.severity.dim}>type a request · </Text>
          <Text color={theme.role.assistant}>/help</Text>
          <Text color={theme.severity.dim}> · </Text>
          <Text color={theme.role.assistant}>/resume</Text>
          <Text color={theme.severity.dim}> · </Text>
          <Text color={theme.role.assistant}>/view inspect</Text>
          <Text color={theme.severity.dim}> · </Text>
          <Text color={theme.role.assistant}>Ctrl-O</Text>
          <Text color={theme.severity.dim}> {nextView}</Text>
        </Box>
      ) : null}
    </Box>
  );
};

export const WelcomeBanner = memo(WelcomeBannerImpl);

export const BANNER_TIPS: readonly string[] = [
  "Use /resume to reopen a prior session without replaying the full transcript.",
  "`@path/to/file` inlines a file; `@workflow:<slug>` fetches a committed workflow.",
  "Drop an `SK.md` next to your project and sk injects it as memory each turn.",
  'Run `sk -p "your prompt"` for headless output in scripts or CI.',
  "Use /permissions when you need the fastest grounded view of your current access.",
  "Use /status for tenant state before asking the assistant to summarize what exists.",
  "Use /view inspect when you need the raw call trace behind the chat view.",
  "Shift-Tab cycles ask / auto / plan; the footer always shows the active mode.",
  "`/approve` or `/reject` resolves the current confirmation request inline.",
  "Use /compact when a long conversation needs a smaller working context.",
  "Ask about MCP, the HTTP API, or chat adapters in plain language; the assistant grounds on real sk surfaces.",
  "If the engine errors repeatedly, turn on `SK_DEBUG=1` or use `/debug on`.",
] as const;

export function pickTip(seed: number = Date.now()): string {
  const idx = Math.abs(Math.floor(seed)) % BANNER_TIPS.length;
  return BANNER_TIPS[idx] ?? BANNER_TIPS[0] ?? "";
}
