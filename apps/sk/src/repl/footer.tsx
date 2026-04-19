// Two-line REPL footer — sits below the bordered composer. Mirrors the
// visual cadence of Claude Code's footer but carries subkit-native
// identity chrome, not IDE chrome:
//
//   line 1: <user> @ <tenant>  ·  <engine-host>  ·  <session>
//   line 2: ⏵⏵ <mode>                        (shift+tab to cycle)
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

import { homedir } from "node:os";
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
  /** Transcript density indicator shown next to the mode hint. */
  transcriptMode: "compact" | "detail";
}

export const MODE_LABELS: Record<PermissionMode, string> = {
  ask: "ask approval",
  auto: "auto-approve on",
  plan: "plan mode (read-only)",
};

/** Compress `/Users/me/foo` → `~/foo` when under $HOME. Exported for banner reuse. */
export function compressCwd(cwd: string, home = homedir()): string {
  if (!home) return cwd;
  if (cwd === home) return "~";
  if (cwd.startsWith(`${home}/`)) return `~${cwd.slice(home.length)}`;
  return cwd;
}

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
}) => {
  const theme = useTheme();
  const tenantLabel = tenant ?? "(no tenant)";
  const host = engineHost(engineUrl);
  const sessionLabel = sessionId ? sessionId.slice(0, 8) : "new";
  const modeColor = theme.mode[mode];
  const modeLabel = MODE_LABELS[mode];
  return (
    <Box flexDirection="column" marginTop={1}>
      {/* line 1 — subkit identity: user @ tenant · engine · session */}
      <Box>
        <Text color={theme.severity.dim}> </Text>
        <Text color={theme.role.user} bold>
          {user}
        </Text>
        <Text color={theme.severity.dim}> @ </Text>
        <Text bold>{tenantLabel}</Text>
        <Text color={theme.severity.dim}> · </Text>
        <Text color={theme.severity.dim}>{host}</Text>
        <Text color={theme.severity.dim}> · session </Text>
        <Text color={theme.role.assistant}>{sessionLabel}</Text>
      </Box>
      {/* line 2 — permission mode + cycle hint */}
      <Box>
        <Text color={theme.severity.dim}> </Text>
        <Text color={modeColor} bold>
          ⏵⏵{" "}
        </Text>
        <Text color={modeColor}>{modeLabel}</Text>
        <Text
          color={theme.severity.dim}
        >{` (shift+tab mode · ctrl-o ${transcriptMode} transcript)`}</Text>
      </Box>
    </Box>
  );
};

export const Footer = memo(FooterImpl);
