// Two-line REPL footer — sits below the bordered composer and keeps the
// persistent chrome intentionally compact:
//
//   line 1: <user> @ <tenant>  ·  <engine-host>  ·  <session>
//   line 2: ⏵⏵ <mode>  ·  <view>            (shift+tab / ctrl-o hints)
//
// Rationale: sk is a workflow-authoring CLI against a multi-tenant
// engine. Users care about "which tenant am I talking to, on which
// engine, in which conversation" — they do not care about their local
// `cwd` or the engine's internal model selection.
//
// Mode labels match subkit's permission semantics, not Claude's brand:
//   ask   → "ask approval"        (engine prompts on tool calls)
//   auto  → "auto-approve on"     (engine auto-confirms tool calls)
//   plan  → "plan mode (read-only)" (engine executes no writes)
//
// The mode glyph color follows `theme.mode.*` so a palette swap
// updates every surface at once.

import { useTheme } from "@chat-ui/index.ts";
import { Box, Text } from "ink";
import type React from "react";
import { memo } from "react";
import type { PermissionMode } from "../status-line.ts";

export interface FooterProps {
  /** Signed-in user identifier (email, id, or persona label fallback). */
  user: string;
  /** Tenant slug / id — subkit's multi-tenant isolation boundary. */
  tenant: string | null;
  /** Engine base URL — compressed to host:port on render. */
  engineUrl: string;
  /** Current conversation id (post-turn); `null` on a fresh REPL. */
  sessionId: string | null;
  /** Active permission mode — drives line 2 label + glyph color. */
  mode: PermissionMode;
  /** Transcript view indicator shown next to the mode hint. */
  transcriptMode: "chat" | "inspect";
  /** Live engine-connection state from the health pinger. When "offline"
   *  or "reconnecting" the footer shows a red/yellow chip so the user
   *  notices before they hit a mysterious tool failure. */
  connectionState?: "online" | "reconnecting" | "offline" | "unknown";
  /** Short reason attached to non-online states. */
  connectionReason?: string | null;
}

export const MODE_LABELS: Record<PermissionMode, string> = {
  ask: "ask",
  auto: "auto",
  plan: "plan",
};

/** Turn an engine URL into a `host:port` string; falls back to the raw value. */
export function engineHost(url: string): string {
  try {
    const u = new URL(url);
    return u.port ? `${u.hostname}:${u.port}` : u.hostname;
  } catch {
    return url;
  }
}

const FooterImpl: React.FC<FooterProps> = ({
  user,
  tenant,
  engineUrl,
  sessionId,
  mode,
  transcriptMode,
  connectionState = "unknown",
  connectionReason,
}) => {
  const theme = useTheme();
  const tenantLabel = tenant ?? "(no tenant)";
  const host = engineHost(engineUrl);
  const sessionLabel = sessionId ? sessionId.slice(0, 8) : "new";
  const modeColor = theme.mode[mode];
  const modeLabel = MODE_LABELS[mode];
  const nextView = transcriptMode === "chat" ? "inspect" : "chat";
  const connChip = renderConnectionBadge(connectionState, connectionReason ?? null, theme);
  return (
    <Box flexDirection="column" marginTop={1}>
      <Box>
        <Text color={theme.severity.dim}> </Text>
        <Text color={theme.role.user} bold>
          {user}
        </Text>
        <Text color={theme.severity.dim}> @ </Text>
        <Text bold>{tenantLabel}</Text>
        <Text color={theme.severity.dim}> · </Text>
        <Text color={theme.severity.dim}>{host}</Text>
        <Text color={theme.severity.dim}> · </Text>
        <Text color={theme.severity.dim}>session </Text>
        <Text color={theme.role.assistant}>{sessionLabel}</Text>
        {connChip}
      </Box>
      <Box>
        <Text color={theme.severity.dim}> </Text>
        <Text color={modeColor} bold>
          ⏵⏵{" "}
        </Text>
        <Text color={modeColor}>{modeLabel}</Text>
        <Text color={theme.severity.dim}>{` · ${transcriptMode}`}</Text>
        <Text color={theme.severity.dim}>{` · shift+tab mode · ctrl-o ${nextView}`}</Text>
      </Box>
    </Box>
  );
};

function renderConnectionBadge(
  state: "online" | "reconnecting" | "offline" | "unknown",
  reason: string | null,
  theme: ReturnType<typeof useTheme>,
): React.ReactNode {
  if (state === "online" || state === "unknown") return null;
  const dot = state === "offline" ? "●" : "⟳";
  const label = state === "offline" ? "offline" : "reconnecting";
  const color = state === "offline" ? theme.severity.error : theme.severity.warning;
  const trimmed = reason && reason.length > 40 ? `${reason.slice(0, 37)}…` : reason;
  return (
    <>
      <Text color={theme.severity.dim}> · </Text>
      <Text color={color} bold>
        {dot} {label}
      </Text>
      {trimmed ? (
        <>
          <Text color={theme.severity.dim}> · </Text>
          <Text color={theme.severity.dim}>{trimmed}</Text>
        </>
      ) : null}
    </>
  );
}

export const Footer = memo(FooterImpl);
